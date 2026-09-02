/**
 * The control plane end to end: a real `@effect/rpc` client against the real
 * daemon, over the session's real Unix socket.
 *
 * Everything here goes over the wire on purpose. The daemon's in-process
 * surface is a different thing from what a script, a CLI or another machine's
 * client can ask of it, and the second is the contract worth pinning.
 *
 * @effect-diagnostics *:skip-file -- a real OS boundary (sockets, subprocess) this suite deliberately
 * drives unmocked. See the seam documented in packages/amux/src/harness.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Deferred, Effect, Fiber, Option, Scope, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { AttachClient } from "./attach.ts";
import { agentWatch, controlCall, connectControl, type ControlClient } from "./control-client.ts";
import { command } from "./commands.ts";
import { MAX_RPC_BYTES } from "./limits.ts";
import { SessionStore, sessionPaths } from "./session.ts";
import { waitFor } from "./test-wait.ts";
import { parseWorkspaceJson } from "./workspace.ts";
import { testEffect } from "./test-effect.ts";

const dirs: string[] = [];
const daemons: SessionDaemonService[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop).catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Scope.Scope>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(SessionStore.layer),
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );

async function started(id: string) {
  const home = await mkdtemp(join(tmpdir(), "amux-control-"));
  dirs.push(home);
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
  } as NodeJS.ProcessEnv;
  const daemon = await run(startDaemon(id), env);
  daemons.push(daemon);
  return { daemon, env };
}

const ctl = <A, E>(
  id: string,
  env: NodeJS.ProcessEnv,
  use: (control: ControlClient) => Effect.Effect<A, E>,
) => run(controlCall(id, use), env);

const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

/** Write raw bytes to the control socket and report whether it stayed open. */
async function raw(path: string, line: string) {
  const received: string[] = [];
  let closed = false;
  const socket = await Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      data: (_s, d) => void received.push(d.toString("utf8")),
      close: () => void (closed = true),
    },
  });
  socket.write(line);
  await Bun.sleep(150);
  socket.end();
  return { received: received.join(""), closed };
}

test("ping and status answer over the session's unix socket", async () => {
  const { daemon, env } = await started("control-status");

  expect(await ctl(daemon.id, env, (c) => c.Ping())).toEqual({
    attached: false,
  });

  const status = await ctl(daemon.id, env, (c) => c.Status());
  expect(status.session.id).toBe("control-status");
  expect(status.degraded).toBeUndefined();
  // The workspace crosses as JSON text, exactly as the attach plane sends it.
  expect(JSON.parse(status.workspace).spaces).toHaveLength(1);
  expect(status.agents).toHaveLength(1);
});

test("workspace JSON responses are schema-validated before projection", async () => {
  const { daemon, env } = await started("control-workspace-validation");
  const status = await ctl(daemon.id, env, (c) => c.Status());

  expect(Effect.runSyncExit(parseWorkspaceJson("not json"))._tag).toBe("Failure");
  expect(Effect.runSyncExit(parseWorkspaceJson(JSON.stringify({ revision: 0 })))._tag).toBe(
    "Failure",
  );
  expect(Effect.runSync(parseWorkspaceJson(status.workspace)).revision).toBeGreaterThanOrEqual(0);
});

test("one connection serves many requests for its whole scope", async () => {
  const { daemon, env } = await started("control-reuse");
  const seen = await run(
    Effect.gen(function* () {
      const control = yield* connectControl(daemon.id);
      yield* control.SetBuffer({ name: "a", data: "one" });
      yield* control.SetBuffer({ name: "b", data: "two" });
      return yield* control.ListBuffers();
    }),
    env,
  );
  expect(seen.map((entry) => entry.name).sort()).toEqual(["a", "b"]);
});

/* The handshake is what makes the stream usable: a subscriber that acts only
 * after `events.ready` knows it cannot have missed an event its own action
 * caused. Workspace changes are not on this stream — they reach clients as
 * whole snapshots over the attach channel. */
test("the events stream opens with a readiness handshake", async () => {
  const { daemon, env } = await started("control-events");
  const first = await run(
    Effect.gen(function* () {
      const control = yield* connectControl(daemon.id);
      return yield* Stream.runHead(control.Events());
    }),
    env,
  );
  await Effect.runPromise(daemon.stop).catch(() => {});
  daemons.splice(daemons.indexOf(daemon), 1);
  expect(Option.map(first, (item) => item)).toEqual(
    Option.some({ sequence: 0, event: { _tag: "events.ready" } }),
  );
});

test("a refused command arrives as the daemon's typed failure, not a crash", async () => {
  const { daemon, env } = await started("control-typed-failure");
  const workspace = Effect.runSync(daemon.getWorkspace);

  const error = await ctl(daemon.id, env, (c) =>
    Effect.flip(
      c.Batch({
        values: [command("space.rename", { name: "loser" })],
        expectedRevision: workspace.revision + 99,
        context,
      }),
    ),
  );
  expect(error._tag).toBe("ControlError");
  expect(error.message).toContain("stale workspace revision");

  // The connection that carried the failure is still a working connection.
  expect((await ctl(daemon.id, env, (c) => c.Status())).degraded).toBeUndefined();
});

test("a command batch runs in order and carries its workspace revision forward", async () => {
  const { daemon, env } = await started("control-batch");
  const before = Effect.runSync(daemon.getWorkspace);

  const { outputs } = await ctl(daemon.id, env, (c) =>
    c.Batch({
      values: [
        command("space.rename", { name: "first" }),
        command("space.rename", { name: "named-remotely" }),
      ],
      expectedRevision: before.revision,
      context,
    }),
  );
  expect(outputs).toHaveLength(2);
  expect(JSON.parse(outputs[0]!.workspace!).revision).toBe(before.revision + 1);
  expect(JSON.parse(outputs[1]!.workspace!).revision).toBe(before.revision + 2);
  expect(Effect.runSync(daemon.getWorkspace).spaces[0]!.name).toBe("named-remotely");
});

test("workspace creation returns created ids with its snapshot", async () => {
  const { daemon, env } = await started("control-creation-result");
  const { outputs } = await ctl(daemon.id, env, (control) =>
    control.Batch({ values: [command("pane.split", { axis: "row" })], context }),
  );
  const output = outputs[0]!;
  const snapshot = JSON.parse(output.workspace!);
  const panes = snapshot.spaces[0].windows[0].layout.root.children;
  expect(output.result).toEqual({ session: panes[1].content.session, pane: panes[1].id });
});

test("an empty command batch is rejected", async () => {
  const { daemon, env } = await started("control-empty-batch");
  const error = await ctl(daemon.id, env, (control) => Effect.flip(control.Batch({ values: [] })));
  expect(error.message).toContain("must not be empty");
});

test("the CLI runs escaped-semicolon command groups in order", async () => {
  const id = "control-cli-chain";
  const { daemon, env } = await started(id);
  const before = Effect.runSync(daemon.getWorkspace);
  const entry = new URL("./cli.ts", import.meta.url).pathname;

  const child = Bun.spawn({
    cmd: [process.execPath, entry, "space.rename", "first", ";", "space.rename", "second"],
    env: { ...process.env, ...env, AMUX_DAEMON_SESSION: id },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(Effect.runSync(daemon.getWorkspace).revision).toBe(before.revision + 2);
  expect(Effect.runSync(daemon.getWorkspace).spaces[0]!.name).toBe("second");
});

test("--session selects the daemon for a command whose schema has no session field", async () => {
  const id = "flag-daemon";
  const { daemon, env } = await started(id);
  const before = Effect.runSync(daemon.getWorkspace);
  const entry = new URL("./cli.ts", import.meta.url).pathname;
  const { AMUX_DAEMON_SESSION: _session, ...clean } = process.env;

  const child = Bun.spawn({
    cmd: [process.execPath, entry, "space.rename", "flagged", `--session=${id}`],
    env: { ...clean, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(Effect.runSync(daemon.getWorkspace).revision).toBe(before.revision + 1);
  expect(Effect.runSync(daemon.getWorkspace).spaces[0]!.name).toBe("flagged");
});

testEffect("--session also fills a command's session field, targeting the session it selects", () =>
  Effect.gen(function* () {
    const id = "capture-flag";
    const { daemon, env } = yield* Effect.promise(() => started(id));
    yield* daemon.spawnSession({
      kind: "pty",
      id,
      cmd: ["sh", "-c", "printf 'flag-captured\\n'; sleep 30"],
      cols: 80,
      rows: 24,
    });
    const capture = () =>
      ctl(daemon.id, env, (c) => c.Batch({ values: [command("pane.capture", { session: id })] }));
    let outputs = (yield* Effect.promise(() => capture())).outputs;
    yield* Effect.promise(() =>
      waitFor(async () => {
        outputs = (await capture()).outputs;
        return String(outputs[0]!.result).includes("flag-captured");
      }, "the pane to print before it is captured"),
    );
    expect(outputs[0]!.result).toContain("flag-captured");

    const entry = new URL("./cli.ts", import.meta.url).pathname;
    const { AMUX_DAEMON_SESSION: _session, ...clean } = process.env;
    const child = Bun.spawn({
      cmd: [process.execPath, entry, "pane.capture", `--session=${id}`],
      env: { ...clean, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
    );
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("flag-captured");
    yield* daemon.killSession(id);
  }),
);

testEffect("--session satisfies a command's required session field", () =>
  Effect.gen(function* () {
    const id = "reveal-flag";
    const { daemon, env } = yield* Effect.promise(() => started(id));
    yield* daemon.spawnSession({ kind: "pty", id, cmd: ["sleep", "30"], cols: 80, rows: 24 });
    const entry = new URL("./cli.ts", import.meta.url).pathname;
    const { AMUX_DAEMON_SESSION: _session, ...clean } = process.env;

    const child = Bun.spawn({
      cmd: [process.execPath, entry, "session.reveal", `--session=${id}`],
      env: { ...clean, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = yield* Effect.promise(() =>
      Promise.all([child.exited, new Response(child.stderr).text()]),
    );
    // Without the feed the required field errors as 'missing required argument:
    // session'; reaching the daemon at all proves --session supplied it.
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  }),
);

testEffect("a native agent can capture a live session through the command surface", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* Effect.promise(() => started("agent-tools"));
    const id = "capture-agent";
    yield* daemon.spawnSession({
      kind: "pty",
      id,
      cmd: ["sh", "-c", "printf 'capture-me\\n'; sleep 30"],
      cols: 80,
      rows: 24,
    });
    const capture = () =>
      ctl(daemon.id, env, (c) => c.Batch({ values: [command("pane.capture", { session: id })] }));
    let outputs = (yield* Effect.promise(() => capture())).outputs;
    yield* Effect.promise(() =>
      waitFor(async () => {
        outputs = (await capture()).outputs;
        return String(outputs[0]!.result).includes("capture-me");
      }, "the pane to print before it is captured"),
    );
    expect(outputs[0]!.result).toContain("capture-me");
    yield* daemon.killSession(id);
  }),
);

testEffect("a native worker invokes pane.capture through the amux CLI", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* Effect.promise(() => started("agent-cli-tools"));
    const target = "capture-target";
    yield* daemon.spawnSession({
      id: target,
      cmd: ["sh", "-c", "printf 'worker-capture\n'; sleep 30"],
      cols: 80,
      rows: 24,
    });
    const worker = "capture-worker";
    const entry = new URL("./cli.ts", import.meta.url).pathname;
    const script = `
    const p = Bun.spawnSync([process.execPath, ${JSON.stringify(entry)}, "pane.capture", process.env.AMUX_SESSION, "--session=${target}"], { env: process.env });
    const data = Buffer.from(p.stdout).toString("utf8");
    process.stdout.write(JSON.stringify({_tag:"output",session:process.env.AMUX_AGENT_ID,data:Buffer.from(data).toString("base64")})+"\\n");
  `;
    yield* daemon.spawnSession({
      kind: "component",
      id: worker,
      cmd: [process.execPath, "-e", script],
      cols: 80,
      rows: 24,
    });
    const session = yield* Effect.promise(() => ctl(daemon.id, env, (c) => c.Status()));
    expect(session.agents).toContain(worker);
    yield* Effect.sleep(300);
    yield* daemon.killSession(target);
    yield* daemon.killSession(worker);
  }),
);

/**
 * `--wait` follows the one signal core owns: the state the session publishes.
 * The CLI loads no plugins, so it cannot recognise a turn and must not try —
 * it waits for the prompt to move the session, then for it to settle again.
 */
testEffect("agent.prompt --wait returns once the session settles again", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* Effect.promise(() => started("agent-prompt-wait"));
    const target = "wait-target";
    const script = `
    for await (const chunk of process.stdin) {
      for (const line of chunk.toString().split("\\n")) {
        if (!line) continue;
        const frame = JSON.parse(line);
        // The daemon routes harness control inside session.message; the
        // prompt is the opaque payload, not a frame tag of its own.
        if (frame._tag !== "session.message" || frame.message?._tag !== "agent.prompt") continue;
        const publish = (payload) => process.stdout.write(JSON.stringify({_tag:"agent.emit",event:{_tag:"topic",session:process.env.AMUX_AGENT_ID,topic:"session.state",payload}})+"\\n");
        publish("running");
        publish("idle");
      }
    }
  `;
    yield* daemon.spawnSession({
      kind: "component",
      id: target,
      cmd: [process.execPath, "-e", script],
      cols: 80,
      rows: 24,
    });

    const entry = new URL("./cli.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [process.execPath, entry, "agent.prompt", target, "inspect", "--wait", "--timeout=1000"],
      {
        env: { ...process.env, ...env, AMUX_DAEMON_SESSION: daemon.id },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
    );
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ topic: "session.state", payload: "idle" });
  }),
);

testEffect("agent.prompt --wait fails fast with the named stall error", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* Effect.promise(() => started("agent-prompt-stall"));
    yield* daemon.spawnSession({
      kind: "component",
      id: "stall-target",
      cmd: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
      cols: 80,
      rows: 24,
    });
    const entry = new URL("./cli.ts", import.meta.url).pathname;
    const startedAt = Date.now();
    const child = Bun.spawn(
      [
        process.execPath,
        entry,
        "agent.prompt",
        "stall-target",
        "inspect",
        "--wait",
        "--timeout=10000",
      ],
      {
        env: { ...process.env, ...env, AMUX_DAEMON_SESSION: daemon.id },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = yield* Effect.promise(() =>
      Promise.all([child.exited, new Response(child.stderr).text()]),
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("agent_prompt_stalled");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }),
);

/* The DoD round trip: a process inside a real daemon-spawned pane, given only
 * the injected environment, learns which pane it is and where the process-state
 * socket lives, connects to it, and gets a response back. Earlier tests prove
 * the two halves separately — SessionRegistry injects the variables, the
 * socket answers — but a pane whose hook cannot actually dial the mux is the
 * exact failure this task reopened on, so the halves are joined here. */
testEffect("a script inside a pane reports and gets a response using only the injected env", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* Effect.promise(() => started("pane-roundtrip"));
    const script = `
    const net = require("node:net");
    const path = process.env.AMUX_PROCESS_STATE_SOCKET;
    const pane = process.env.AMUX_PANE_ID;
    process.stdout.write("pane=" + pane + " socket=" + path + "\\n");
    const s = net.createConnection(path);
    s.on("connect", () =>
      s.write(JSON.stringify({ id: "roundtrip", method: "process.state", params: { session: pane, state: "blocked" } }) + "\\n"));
    s.on("data", (d) => { process.stdout.write("reply:" + d.toString().trim() + "\\n"); s.destroy(); process.exit(0); });
    s.on("error", (e) => { process.stdout.write("error:" + e.message + "\\n"); process.exit(1); });
    s.setTimeout(3000, () => { process.stdout.write("timeout\\n"); process.exit(1); });
  `;
    yield* daemon.spawnSession({
      id: "roundtrip-pane",
      paneId: "roundtrip-pane",
      cmd: [process.execPath, "-e", script],
      cols: 80,
      rows: 24,
    });
    // The supervisor already consumes the session's output stream, so the pane's
    // bytes are observed where a real client sees them — over the attach plane.
    const attached = yield* Effect.promise(() =>
      AttachClient.connect({
        path: daemon.paths.attach,
        client: "roundtrip-watcher",
      }),
    );
    const frames = yield* Effect.promise(() =>
      run(
        Effect.scoped(
          attached.stream("roundtrip-pane").pipe(
            Stream.takeUntil((frame) => frame._tag === "exit"),
            Stream.runCollect,
          ),
        ),
        env,
      ),
    );
    attached.close();
    const text = [...frames]
      .map((frame) => (frame._tag === "output" ? new TextDecoder().decode(frame.data) : ""))
      .join("");
    expect(text).toContain("pane=roundtrip-pane");
    expect(text).toContain("reply:");
    expect(JSON.parse(text.split("reply:")[1]!.split("\n")[0]!)).toEqual({
      id: "roundtrip",
      ok: true,
    });
  }),
);

test("the process state socket accepts ping and process state reports", async () => {
  const { daemon, env } = await started("pane-control");
  const paths = await run(sessionPaths(daemon.id), env);
  const lines: string[] = [];
  const socket = await Bun.connect({
    unix: paths.processState,
    socket: {
      data: (_socket, data) => {
        lines.push(data.toString());
      },
    },
  });
  socket.write(JSON.stringify({ id: "one", method: "ping" }) + "\n");
  await Bun.sleep(50);
  socket.write(
    JSON.stringify({
      id: "two",
      method: "process.state",
      params: { session: "pane-a", state: "blocked" },
    }) + "\n",
  );
  await waitFor(
    () => lines.join("\n").includes('"id":"one"') && lines.join("\n").includes('"id":"two"'),
    "both pipelined replies",
  );
  socket.end();
  expect(lines.join("\n")).toContain('"id":"one"');
  expect(lines.join("\n")).toContain('"id":"two"');
});

/* The DoD's two hardening clauses. A process inside a pane is something a user
 * runs, not something amux vouches for, so the socket it dials must be closed
 * to other Unix users, and a hook that dies mid-write must not take the daemon
 * down with it — the agent keeps running either way.
 *
 * This mode does not stop one of this daemon's own panes from naming another:
 * every pane a daemon supervises runs as the same user and is mutually
 * trusted with the others, the same way tmux panes are. See ARCHITECTURE.md's
 * "Trust model for process self-reports". */
test("the process state socket is closed to other Unix users", async () => {
  const { daemon, env } = await started("agent-state-private");
  const paths = await run(sessionPaths(daemon.id), env);
  const { stat } = await import("node:fs/promises");
  const socket = await stat(paths.processState);
  // Owner-only: the daemon pins this after listen so it holds under any umask.
  expect(socket.mode & 0o777).toBe(0o600);
  // The socket lives under the session's 0700 root, so a different user cannot
  // even reach it — a second wall that no umask can open.
  expect((await stat(paths.root)).mode & 0o077).toBe(0);
});

test("a hook that dies mid-write leaves the daemon unaffected", async () => {
  const { daemon, env } = await started("agent-state-abort");
  const paths = await run(sessionPaths(daemon.id), env);
  const socket = await Bun.connect({
    unix: paths.processState,
    socket: { data: () => {} },
  });
  // Start a line, then vanish without the newline and without a clean close.
  socket.write('{"id":"abandoned","method":"process.state","params":{"session":"pane-a","state":');
  socket.end();
  // And confirm the listener is still alive and answering.
  const lines: string[] = [];
  const probe = await Bun.connect({
    unix: paths.processState,
    socket: {
      data: (_socket, data) => void lines.push(data.toString()),
    },
  });
  probe.write(JSON.stringify({ id: "probe", method: "ping" }) + "\n");
  await waitFor(() => lines.join("").includes('"id":"probe"'), "a ping after the aborted write");
  probe.end();
  expect(lines.join("")).toContain('"id":"probe"');
  expect(lines.join("")).toContain('"ok":true');
});

/* A reply of `ok:true` only proves the socket parsed the line. What callers
 * subscribe to is the event bus, and the two came apart once already: the
 * listener built the publish Effect and discarded it, so every agent looked
 * idle forever while the socket kept answering ok. Assert the publication.
 *
 * The report names a LIVE session, as a real hook does: it runs inside a pane
 * and reports the session it was handed (AMUX_AGENT_ID; the pane id it carries
 * in AMUX_PANE_ID is a view, not an identity). A report is committed to that
 * session's log before it is published, so an id belonging to no session has
 * nowhere to land and is dropped. */
testEffect("an agent self-report reaches the session-state topic, not just the socket", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* Effect.promise(() => started("agent-state-publish"));
    const paths = yield* Effect.promise(() => run(sessionPaths(daemon.id), env));
    yield* daemon.spawnSession({ id: "pane-a", cmd: ["sh", "-c", "sleep 30"], cols: 80, rows: 24 });

    const report = Effect.promise(async () => {
      const socket = await Bun.connect({
        unix: paths.processState,
        socket: { data: () => {} },
      });
      socket.write(
        JSON.stringify({
          id: "report",
          method: "process.state",
          params: { session: "pane-a", state: "running" },
        }) + "\n",
      );
      await Bun.sleep(50);
      socket.end();
    });

    const published = yield* Effect.promise(() =>
      run(
        Effect.gen(function* () {
          const control = yield* connectControl(daemon.id);
          const ready = yield* Deferred.make<void>();
          const head = yield* Effect.forkChild(
            Stream.runHead(
              control.Events().pipe(
                Stream.tap((frame) =>
                  frame.event._tag === "events.ready"
                    ? Deferred.succeed(ready, undefined)
                    : Effect.void,
                ),
                Stream.filter((frame) => frame.event._tag === "session.state"),
              ),
            ),
          );
          // Report only once the handshake proves this subscriber is live, so the
          // event cannot be published before anyone is listening for it.
          yield* Deferred.await(ready);
          yield* report;
          return yield* Fiber.join(head).pipe(Effect.timeout("5 seconds"));
        }),
        env,
      ),
    );

    expect(Option.getOrNull(published)?.event).toEqual({
      _tag: "session.state",
      session: "pane-a",
      state: "running",
    });
  }),
);

/*
 * `topic.publish` is the same private socket generalized: a plugin names its
 * own topic and hands core an opaque JSON payload instead of the fixed
 * idle/running/blocked/done string `process.state` carries. Core neither knows nor
 * cares that this one happens to be an agent-awareness identity report — it
 * stores and replays it exactly like `session.state`, through the one durable
 * topic door.
 */
/* AgentWatch is a subscribing RPC like Events(): the daemon keeps its serving
 * fiber alive for as long as a client holds the stream open, so this test
 * stops its own daemon before returning rather than leaving that for the
 * shared afterEach, exactly as the events-stream test above does. */
testEffect(
  "an opaque plugin topic reaches the daemon's durable log over the same private socket",
  () =>
    Effect.gen(function* () {
      const { daemon, env } = yield* Effect.promise(() => started("topic-publish"));
      const paths = yield* Effect.promise(() => run(sessionPaths(daemon.id), env));
      yield* daemon.spawnSession({
        id: "pane-a",
        cmd: ["sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });

      yield* Effect.promise(() =>
        raw(
          paths.processState,
          JSON.stringify({
            id: "report",
            method: "topic.publish",
            params: {
              session: "pane-a",
              topic: "amux.agent-awareness/identity-state",
              payload: { agent: "opencode", state: "working" },
            },
          }) + "\n",
        ),
      );

      const first = yield* Effect.promise(() =>
        run(
          Effect.gen(function* () {
            const control = yield* connectControl(daemon.id);
            return yield* Stream.runHead(agentWatch(control, "pane-a"));
          }),
          env,
        ),
      );
      yield* daemon.stop.pipe(Effect.ignore);
      daemons.splice(daemons.indexOf(daemon), 1);

      expect(Option.getOrNull(first)).toEqual({
        _tag: "topic",
        session: "pane-a",
        sequence: 0,
        topic: "amux.agent-awareness/identity-state",
        payload: { agent: "opencode", state: "working" },
      });
    }),
);

testEffect(
  "a malformed envelope on the private socket is rejected without a second event path",
  () =>
    Effect.gen(function* () {
      const { daemon, env } = yield* Effect.promise(() => started("topic-malformed"));
      const paths = yield* Effect.promise(() => run(sessionPaths(daemon.id), env));
      yield* daemon.spawnSession({
        id: "pane-a",
        cmd: ["sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });

      // Not JSON at all.
      expect(
        (yield* Effect.promise(() => raw(paths.processState, "not json at all\n"))).received,
      ).toContain('"ok":false');

      // Valid JSON, but a method neither `process.state` nor `topic.publish`.
      expect(
        (yield* Effect.promise(() =>
          raw(
            paths.processState,
            JSON.stringify({ method: "topic.delete", params: { session: "pane-a" } }) + "\n",
          ),
        )).received,
      ).toContain('"ok":false');

      // `topic.publish` missing the topic name.
      expect(
        (yield* Effect.promise(() =>
          raw(
            paths.processState,
            JSON.stringify({
              method: "topic.publish",
              params: { session: "pane-a", payload: "x" },
            }) + "\n",
          ),
        )).received,
      ).toContain('"ok":false');

      // None of the rejected envelopes reached the durable log.
      const cursor = yield* Effect.promise(() =>
        ctl(daemon.id, env, (c) => c.AgentCursor({ session: "pane-a" })),
      );
      expect(cursor).toBe(-1);
      expect((yield* Effect.promise(() => ctl(daemon.id, env, (c) => c.Ping()))).attached).toBe(
        false,
      );
    }),
);

/* The socket is shared by every pane this daemon supervises, and those panes
 * are mutually trusted with each other — the same-user boundary tmux has, not
 * a per-pane one (see ARCHITECTURE.md's "Trust model for process
 * self-reports"). What the daemon does enforce past that: a report must name
 * a backend id *this daemon* actually spawned, or it is dropped. This test
 * names a session that exists nowhere at all, as the simplest case of that
 * check. */
testEffect("a report naming a session this daemon never spawned commits nothing", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* Effect.promise(() => started("topic-cross-session"));
    const paths = yield* Effect.promise(() => run(sessionPaths(daemon.id), env));
    yield* daemon.spawnSession({ id: "pane-a", cmd: ["sh", "-c", "sleep 30"], cols: 80, rows: 24 });

    yield* Effect.promise(() =>
      raw(
        paths.processState,
        JSON.stringify({
          method: "topic.publish",
          params: {
            session: "someone-elses-pane",
            topic: "amux.agent-awareness/identity-state",
            payload: { agent: "opencode", state: "working" },
          },
        }) + "\n",
      ),
    );

    const cursor = yield* Effect.promise(() =>
      ctl(daemon.id, env, (c) => c.AgentCursor({ session: "someone-elses-pane" })),
    );
    expect(cursor).toBe(-1);
    expect((yield* Effect.promise(() => ctl(daemon.id, env, (c) => c.Ping()))).attached).toBe(
      false,
    );
  }),
);

/* The stronger case: a session id that is not a stranger's fiction but a real,
 * live backend — just owned by a different daemon. Two daemons, each with
 * their own root and socket, both happen to have a session named "pane-a" (a
 * hook only ever gets told a bare session id, so nothing stops two daemons
 * from using the same one). Publishing "pane-a" over daemon A's socket must
 * land in A's log only if A itself spawned that id; here it did not, so this
 * proves both that A rejects it and that nothing about B's identically-named,
 * genuinely-live session lets the report leak into either log. */
testEffect("a live backend id in one daemon grants no standing to name it in another", () =>
  Effect.gen(function* () {
    const a = yield* Effect.promise(() => started("cross-daemon-a"));
    const b = yield* Effect.promise(() => started("cross-daemon-b"));
    const pathsA = yield* Effect.promise(() => run(sessionPaths(a.daemon.id), a.env));

    // "pane-a" is live only in daemon B.
    yield* b.daemon.spawnSession({
      id: "pane-a",
      cmd: ["sh", "-c", "sleep 30"],
      cols: 80,
      rows: 24,
    });

    // The injection happens on daemon A's socket, which never spawned "pane-a".
    yield* Effect.promise(() =>
      raw(
        pathsA.processState,
        JSON.stringify({
          method: "topic.publish",
          params: {
            session: "pane-a",
            topic: "amux.agent-awareness/identity-state",
            payload: { agent: "opencode", state: "working" },
          },
        }) + "\n",
      ),
    );

    const cursorA = yield* Effect.promise(() =>
      ctl(a.daemon.id, a.env, (c) => c.AgentCursor({ session: "pane-a" })),
    );
    const cursorB = yield* Effect.promise(() =>
      ctl(b.daemon.id, b.env, (c) => c.AgentCursor({ session: "pane-a" })),
    );
    // A never accepted it: it did not own that backend id.
    expect(cursorA).toBe(-1);
    // B's genuinely-live "pane-a" saw nothing either: the injected event never
    // crossed from A's socket into B's log, which is the claim under test.
    expect(cursorB).toBe(-1);
  }),
);

test("malformed and oversized frames are refused without taking the daemon down", async () => {
  const { daemon, env } = await started("control-garbage");
  const paths = await run(sessionPaths(daemon.id), env);

  // Not JSON at all.
  await raw(paths.socket, "this is not ndjson\n");
  expect((await ctl(daemon.id, env, (c) => c.Ping())).attached).toBe(false);

  // JSON, but nothing the protocol knows.
  await raw(paths.socket, JSON.stringify({ _tag: "NotARequest" }) + "\n");
  expect((await ctl(daemon.id, env, (c) => c.Ping())).attached).toBe(false);

  // Past the frame limit: the framer gives up on the line before parsing it.
  const oversized = await raw(paths.socket, "x".repeat(MAX_RPC_BYTES + 1) + "\n");
  expect(oversized.closed).toBe(true);
  expect((await ctl(daemon.id, env, (c) => c.Ping())).attached).toBe(false);

  // The same limit applies to a well-formed request that is simply too big.
  await expect(
    ctl(daemon.id, env, (c) => c.SetBuffer({ data: "x".repeat(MAX_RPC_BYTES) })),
  ).rejects.toThrow();
  expect((await ctl(daemon.id, env, (c) => c.Ping())).attached).toBe(false);
});

test("stop answers before it tears its own socket down", async () => {
  const { daemon, env } = await started("control-stop");
  const paths = await run(sessionPaths(daemon.id), env);
  daemons.pop();
  await ctl(daemon.id, env, (c) => c.Stop());

  const gone = async (path: string) => {
    for (let i = 0; i < 100; i++) {
      if (!(await Bun.file(path).exists())) return true;
      await Bun.sleep(20);
    }
    return false;
  };
  expect(await gone(paths.socket)).toBe(true);
  expect(await gone(paths.lease)).toBe(true);
  expect(await gone(paths.lock)).toBe(true);
  // A stopped session is discarded, not merely unreachable.
  expect(
    await run(
      Effect.flatMap(SessionStore, (store) => store.load(daemon.id)),
      env,
    ),
  ).toBeNull();
});

// The machine-facing contract from inside a pane (ts-33067b): with only the
// injected env, an agent resolves its own pane, reads geometry and listings,
// and drives named panes without stealing the human's focus. Everything here
// goes through the real CLI over the real socket.
// Many CLI spawns, each a cold Bun process, so the default 5s is not enough.
test("the CLI read surface resolves the calling pane from inside one", async () => {
  const { daemon, env } = await started("cli-read-surface");
  const workspace = Effect.runSync(daemon.getWorkspace);
  const space = workspace.spaces[0]!;
  const pane = workspacePaneId(workspace);
  const session = space.windows[0]!.sessions[0]!.id;
  const entry = new URL("./cli.ts", import.meta.url).pathname;
  const cli = (args: string[]) =>
    Bun.spawn([process.execPath, entry, ...args], {
      env: {
        ...process.env,
        ...env,
        AMUX_DAEMON_SESSION: daemon.id,
        AMUX_PANE_ID: pane,
        AMUX_AGENT_ID: session,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const child = cli(args);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };

  const current = await run(["pane.current", "--current"]);
  expect(current.code).toBe(0);
  expect(JSON.parse(current.stdout)).toMatchObject({
    id: pane,
    space: space.id,
    window: 1,
    session,
  });

  const layout = await run(["pane.layout", "--current"]);
  expect(layout.code).toBe(0);
  const geometry = JSON.parse(layout.stdout);
  expect(geometry.pane).toBe(pane);
  expect(geometry.size).toEqual({ cols: 80, rows: 24 });

  const panes = await run(["pane.list"]);
  expect(panes.code).toBe(0);
  expect(JSON.parse(panes.stdout)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: pane, space: space.id, pid: expect.any(Number) }),
    ]),
  );

  const agents = await run(["agent.list"]);
  expect(agents.code).toBe(0);
  expect(JSON.parse(agents.stdout)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: session, pane, space: space.id, exited: false }),
    ]),
  );

  const got = await run(["agent.get", session]);
  expect(got.code).toBe(0);
  expect(JSON.parse(got.stdout)).toMatchObject({ id: session, pane });

  const spaces = await run(["space.list"]);
  expect(spaces.code).toBe(0);
  expect(JSON.parse(spaces.stdout)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: space.id, windows: 1 })]),
  );

  const windows = await run(["window.list"]);
  expect(windows.code).toBe(0);
  expect(JSON.parse(windows.stdout)).toEqual(
    expect.arrayContaining([expect.objectContaining({ space: space.id, number: 1 })]),
  );

  // A read never moves focus or changes the model.
  expect(Effect.runSync(daemon.getWorkspace).revision).toBe(workspace.revision);
}, 30000);

// Multiple CLI spawns plus terminal waits.
test("the CLI splits, sends keys to, captures and closes a named pane without moving focus", async () => {
  const { daemon, env } = await started("cli-pane-tools");
  const workspace = Effect.runSync(daemon.getWorkspace);
  const pane = workspacePaneId(workspace);
  const session = workspace.spaces[0]!.windows[0]!.sessions[0]!.id;
  const entry = new URL("./cli.ts", import.meta.url).pathname;
  const cli = (args: string[]) =>
    Bun.spawn([process.execPath, entry, ...args], {
      env: {
        ...process.env,
        ...env,
        AMUX_DAEMON_SESSION: daemon.id,
        AMUX_PANE_ID: pane,
        AMUX_AGENT_ID: session,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const child = cli(args);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };

  const split = await run(["pane.split", "--axis", "row", "--no-focus"]);
  expect(split.code).toBe(0);
  const created = JSON.parse(split.stdout) as { session: string; pane: string };
  // The split happened, but the human's focus did not move.
  const afterSplit = Effect.runSync(daemon.getWorkspace);
  const splitWindow = afterSplit.spaces[0]!.windows[0]!;
  expect(afterSplit.spaces[0]!.windows[0]!.state.focus).toBe(pane);
  expect(JSON.stringify(splitWindow.layout)).toContain(created.pane);

  const sent = await run(["pane.send-keys", "--pane", created.pane, "--keys", "echo from-the-cli"]);
  expect(sent.code).toBe(0);

  const captured = await waitForCapture(daemon, env, created.pane, "from-the-cli");

  const closed = await run(["pane.close", "--pane", created.pane]);
  expect(closed.code).toBe(0);
  expect(JSON.stringify(Effect.runSync(daemon.getWorkspace))).not.toContain(created.pane);
  expect(captured).toContain("from-the-cli");
}, 30000);

/** The first pane id the default space's window places. */
function workspacePaneId(workspace: {
  spaces: Array<{ windows: Array<{ layout: { root: unknown } }> }>;
}): string {
  const layout = workspace.spaces[0]!.windows[0]!.layout as {
    root:
      | { type: "pane"; id: string }
      | { type: "split"; children: Array<{ type: "pane"; id: string }> };
  };
  if (layout.root.type === "pane") return layout.root.id;
  return layout.root.children[0]!.id;
}

/** Capture a pane by id until its terminal shows the expected text. */
async function waitForCapture(
  daemon: { id: string },
  env: NodeJS.ProcessEnv,
  paneId: string,
  needle: string,
): Promise<string> {
  let text = "";
  await waitFor(async () => {
    const { outputs } = await ctl(daemon.id, env, (c) =>
      c.Batch({ values: [command("pane.capture", { pane: paneId })] }),
    );
    text = String(outputs[0]!.result ?? "");
    return text.includes(needle);
  }, "the pane to echo before it is captured");
  return text;
}
