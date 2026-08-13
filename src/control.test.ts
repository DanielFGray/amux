/**
 * The control plane end to end: a real `@effect/rpc` client against the real
 * daemon, over the session's real Unix socket.
 *
 * Everything here goes over the wire on purpose. The daemon's in-process
 * surface is a different thing from what a script, a CLI or another machine's
 * client can ask of it, and the second is the contract worth pinning.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Deferred, Effect, Fiber, Option, Scope, Stream } from "effect";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { controlCall, connectControl, type ControlClient } from "./control-client.ts";
import { command } from "./commands.ts";
import { MAX_RPC_BYTES } from "./limits.ts";
import { SessionStore, sessionPaths } from "./session.ts";
import { waitFor } from "./test-wait.ts";
import { parseWorkspaceJson } from "./workspace.ts";

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
      Effect.provide(SessionStore.Default),
      Effect.provide(BunFileSystem.layer),
      Effect.withConfigProvider(ConfigProvider.fromJson(env)),
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
  expect(output.result).toEqual({ session: panes[1].agent, pane: panes[1].id });
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

test("a native agent can capture a live session through the command surface", async () => {
  const { daemon, env } = await started("agent-tools");
  const id = "capture-agent";
  await Effect.runPromise(
    daemon.spawnSession({
      kind: "pty",
      id,
      cmd: ["sh", "-c", "printf 'capture-me\\n'; sleep 30"],
      cols: 80,
      rows: 24,
    }),
  );
  const capture = () =>
    ctl(daemon.id, env, (c) => c.Batch({ values: [command("pane.capture", { session: id })] }));
  let outputs = (await capture()).outputs;
  await waitFor(async () => {
    outputs = (await capture()).outputs;
    return String(outputs[0]!.result).includes("capture-me");
  }, "the pane to print before it is captured");
  expect(outputs[0]!.result).toContain("capture-me");
  await Effect.runPromise(daemon.killSession(id));
});

test("a native worker invokes pane.capture through the amux CLI", async () => {
  const { daemon, env } = await started("agent-cli-tools");
  const target = "capture-target";
  await Effect.runPromise(
    daemon.spawnSession({
      id: target,
      cmd: ["sh", "-c", "printf 'worker-capture\n'; sleep 30"],
      cols: 80,
      rows: 24,
    }),
  );
  const worker = "capture-worker";
  const entry = new URL("./cli.ts", import.meta.url).pathname;
  const script = `
    const p = Bun.spawnSync([process.execPath, ${JSON.stringify(entry)}, "pane.capture", process.env.AMUX_SESSION, "--session=${target}"], { env: process.env });
    const data = Buffer.from(p.stdout).toString("utf8");
    process.stdout.write(JSON.stringify({_tag:"output",session:process.env.AMUX_AGENT_ID,data:Buffer.from(data).toString("base64")})+"\\n");
  `;
  await Effect.runPromise(
    daemon.spawnSession({
      kind: "component",
      id: worker,
      cmd: [process.execPath, "-e", script],
      cols: 80,
      rows: 24,
    }),
  );
  const session = await ctl(daemon.id, env, (c) => c.Status());
  expect(session.agents).toContain(worker);
  await Bun.sleep(300);
  await Effect.runPromise(daemon.killSession(target));
  await Effect.runPromise(daemon.killSession(worker));
});

test("agent.prompt --wait returns the anchored turn completion", async () => {
  const { daemon, env } = await started("agent-prompt-wait");
  const target = "wait-target";
  const script = `
    for await (const chunk of process.stdin) {
      for (const line of chunk.toString().split("\\n")) {
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame._tag !== "agent.prompt") continue;
        process.stdout.write(JSON.stringify({_tag:"agent.event",event:{_tag:"turn.start",session:process.env.AMUX_PANE_ID,turn:"turn-e2e",prompt:frame.text}})+"\\n");
        process.stdout.write(JSON.stringify({_tag:"agent.event",event:{_tag:"turn.end",session:process.env.AMUX_PANE_ID,turn:"turn-e2e",outcome:"completed",text:"finished"}})+"\\n");
      }
    }
  `;
  await Effect.runPromise(
    daemon.spawnSession({
      kind: "component",
      id: target,
      cmd: [process.execPath, "-e", script],
      cols: 80,
      rows: 24,
    }),
  );

  const entry = new URL("./cli.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [process.execPath, entry, "agent.prompt", target, "inspect", "--wait", "--timeout=1000"],
    {
      env: { ...process.env, ...env, AMUX_DAEMON_SESSION: daemon.id },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(stdout)).toMatchObject({ turn: "turn-e2e", outcome: "completed" });
});

test("agent.prompt --wait fails fast with the named stall error", async () => {
  const { daemon, env } = await started("agent-prompt-stall");
  await Effect.runPromise(
    daemon.spawnSession({
      kind: "component",
      id: "stall-target",
      cmd: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
      cols: 80,
      rows: 24,
    }),
  );
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
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("agent_prompt_stalled");
  expect(Date.now() - startedAt).toBeLessThan(10_000);
}, 10_000);

test("the agent state socket accepts ping and agent state reports", async () => {
  const { daemon, env } = await started("pane-control");
  const paths = await run(sessionPaths(daemon.id), env);
  const lines: string[] = [];
  const socket = await Bun.connect({
    unix: paths.agentState,
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
      method: "agent.state",
      params: { agent: "pane-a", state: "blocked" },
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

/* A reply of `ok:true` only proves the socket parsed the line. What callers
 * subscribe to is the event bus, and the two came apart once already: the
 * listener built the publish Effect and discarded it, so every agent looked
 * idle forever while the socket kept answering ok. Assert the publication.
 *
 * The report names a LIVE session, as a real hook does: it runs inside a pane
 * and reports the AMUX_PANE_ID it was handed. A report is committed to that
 * session's log before it is published, so an id belonging to no session has
 * nowhere to land and is dropped. */
test("an agent self-report reaches the event bus, not just the socket", async () => {
  const { daemon, env } = await started("agent-state-publish");
  const paths = await run(sessionPaths(daemon.id), env);
  await Effect.runPromise(
    daemon.spawnSession({ id: "pane-a", cmd: ["sh", "-c", "sleep 30"], cols: 80, rows: 24 }),
  );

  const report = Effect.promise(async () => {
    const socket = await Bun.connect({
      unix: paths.agentState,
      socket: { data: () => {} },
    });
    socket.write(
      JSON.stringify({
        id: "report",
        method: "agent.state",
        params: { agent: "pane-a", state: "working" },
      }) + "\n",
    );
    await Bun.sleep(50);
    socket.end();
  });

  const published = await run(
    Effect.gen(function* () {
      const control = yield* connectControl(daemon.id);
      const ready = yield* Deferred.make<void>();
      const head = yield* Effect.fork(
        Stream.runHead(
          control.Events().pipe(
            Stream.tap((frame) =>
              frame.event._tag === "events.ready"
                ? Deferred.succeed(ready, undefined)
                : Effect.void,
            ),
            Stream.filter((frame) => frame.event._tag === "agent.state"),
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
  );

  expect(Option.getOrNull(published)?.event).toEqual({
    _tag: "agent.state",
    session: "pane-a",
    state: "working",
  });
});

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
  expect(await run(SessionStore.load(daemon.id), env)).toBeNull();
});
