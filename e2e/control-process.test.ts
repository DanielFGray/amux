/** @effect-diagnostics *:skip-file -- a real OS boundary (sockets, subprocess) this suite deliberately
 * drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/**
 * Control-plane process / socket / daemon-lifecycle checks that need a real OS
 * boundary. Moved out of the unit suite (bucket 6 slow lane).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Path,
  Scope,
  Stream,
} from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import {
  startDaemon,
  DaemonError,
  type SessionDaemonService,
} from "../packages/amux/src/daemon.ts";
import { AttachClient } from "../packages/amux/src/attach.ts";
import { SessionClient } from "../packages/amux/src/client.ts";
import {
  controlCall,
  connectControl,
  type ControlClient,
} from "../packages/amux/src/control-client.ts";
import { MAX_RPC_BYTES } from "../packages/amux/src/limits.ts";
import { SessionStore, sessionPaths } from "../packages/amux/src/session.ts";
import { SessionHandle } from "../packages/amux/src/session-handle.ts";
import { registerCleanup, tempDir } from "../packages/amux/src/test-tmp.ts";
import { waitFor } from "../packages/amux/src/test-wait.ts";
import { testEffect } from "../packages/amux/src/test-effect.ts";

registerCleanup();

const daemons: SessionDaemonService[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop).catch(() => {});
});

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path | Scope.Scope>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(
        SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );

async function started(id: string) {
  const home = tempDir("control");
  const configHome = join(home, "config");
  const harness = new URL("../packages/plugin-agent-harness", import.meta.url).pathname;
  const continuity = new URL("../packages/plugin-agent-continuity", import.meta.url).pathname;
  const editor = new URL("../packages/editor", import.meta.url).pathname;
  const pluginConfig = {
    options: {},
    keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
    plugins: [
      { path: harness, enabled: true },
      { path: continuity, enabled: true },
      { path: editor, enabled: true },
    ],
    permissions: [],
    layoutRules: [],
  };
  await mkdir(join(configHome, "amux"), { recursive: true });
  await writeFile(
    join(configHome, "amux", "config.json"),
    JSON.stringify({
      plugins: [
        { path: harness, enabled: true },
        { path: continuity, enabled: true },
        { path: editor, enabled: true },
      ],
    }),
  );
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: configHome,
  } as NodeJS.ProcessEnv;
  const daemon = await run(startDaemon(id, { pluginConfig }), env);
  daemons.push(daemon);
  return { daemon, env, pluginConfig };
}

const ctl = <A, E>(
  id: string,
  env: NodeJS.ProcessEnv,
  use: (control: ControlClient) => Effect.Effect<A, E>,
) => run(controlCall(id, use), env);

/**
 * Write raw bytes to the control socket and report whether it stayed open.
 * Some malformed inputs draw a reply, some draw a server-initiated close, and
 * some draw neither (silently dropped) — so this waits for either signal
 * instead of sleeping a fixed amount, falling through to the timeout
 * unanswered rather than throwing, since "no response at all" is itself a
 * valid, asserted-on outcome for a caller.
 */
async function raw(path: string, line: string, timeoutMs = 300) {
  const received: string[] = [];
  let closed = false;
  let signal!: () => void;
  const signaled = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const socket = await Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      data: (_s, d) => {
        received.push(d.toString("utf8"));
        signal();
      },
      close: () => {
        closed = true;
        signal();
      },
    },
  });
  socket.write(line);
  await Promise.race([signaled, Bun.sleep(timeoutMs)]);
  socket.end();
  return { received: received.join(""), closed };
}

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
    const entry = new URL("../packages/amux/src/cli.ts", import.meta.url).pathname;
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
    // Stall path must beat the 30s child sleep; don't assert against the 10s
    // CLI budget itself — spawn + scheduling under load can land just over it.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  }),
);

testEffect("client projection of a deferred resume sends resize and flushes the pending plan", () =>
  Effect.gen(function* () {
    const { daemon, env, pluginConfig } = yield* Effect.promise(() =>
      started("defer-agent-resume-client"),
    );
    const paneId = workspacePaneId(Effect.runSync(daemon.getWorkspace));
    const sessionId = Effect.runSync(daemon.getWorkspace).spaces[0]!.windows[0]!.sessions[0]!.id;
    const paths = yield* Effect.promise(() => run(sessionPaths(daemon.id), env));

    yield* Effect.promise(() =>
      raw(
        paths.processState,
        JSON.stringify({
          id: "defer-client",
          method: "pane.report_agent_session",
          params: {
            paneId,
            source: "amux:claude",
            agent: "claude",
            seq: 1,
            agentSessionId: "conv-client-resize",
          },
        }) + "\n",
      ),
    );
    yield* Effect.promise(() =>
      waitFor(async () => {
        const pane = Effect.runSync(daemon.getWorkspace).spaces[0]?.windows[0]?.layout.root;
        return (
          pane !== null &&
          typeof pane === "object" &&
          "agentSession" in pane &&
          (pane as { agentSession?: { value: string } }).agentSession?.value ===
            "conv-client-resize"
        );
      }, "agent session ref to land"),
    );

    yield* daemon.close;
    daemons.splice(daemons.indexOf(daemon), 1);

    const captured: Array<{ cmd: readonly string[]; cols: number; rows: number; id: string }> = [];
    const reloaded = yield* Effect.promise(() =>
      run(
        startDaemon(daemon.id, {
          pluginConfig,
          spawnSession: (spec) => {
            captured.push({
              id: spec.id,
              cmd: spec.cmd,
              cols: spec.cols,
              rows: spec.rows,
            });
            return Effect.fail(new DaemonError({ message: "capture-only spawn" }));
          },
        }),
        env,
      ),
    );
    daemons.push(reloaded);
    expect(reloaded.pendingAgentResumeSessions()).toContain(sessionId);
    const statusBeforeProject = yield* Effect.promise(() => ctl(daemon.id, env, (c) => c.Status()));
    expect(statusBeforeProject.agents).toContain(sessionId);

    const scope = yield* Scope.make();
    const client = yield* Effect.promise(() =>
      run(
        Scope.provide(
          SessionClient.connect(daemon.id, { client: "defer-ui", autostart: false }),
          scope,
        ),
        env,
      ),
    );
    // Projection of the modeled-but-not-live session: backend must resize
    // (not "is not live") so AttachHost flushes the pending resume.
    const projected = yield* SessionHandle.make({
      id: sessionId,
      cmd: ["/usr/bin/zsh"],
      cols: 100,
      rows: 30,
      backend: client.backend(),
    });
    yield* Effect.promise(() =>
      waitFor(() => captured.length > 0, "client resize to flush deferred resume"),
    );
    expect(captured).toEqual([
      {
        id: sessionId,
        cmd: ["claude", "--resume", "conv-client-resize"],
        cols: 100,
        rows: 30,
      },
    ]);
    projected.dispose();
    client.close();
    yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
  }),
);

testEffect("a trusted agent session report persists on the pane and survives daemon reload", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* Effect.promise(() => started("persist-agent-session"));
    const paneId = workspacePaneId(Effect.runSync(daemon.getWorkspace));
    const paths = yield* Effect.promise(() => run(sessionPaths(daemon.id), env));

    const accepted = yield* Effect.promise(() =>
      raw(
        paths.processState,
        JSON.stringify({
          id: "persist",
          method: "pane.report_agent_session",
          params: {
            paneId,
            source: "amux:claude",
            agent: "claude",
            seq: 1,
            agentSessionId: "conv-persist",
          },
        }) + "\n",
      ),
    );
    expect(accepted.received).toContain('"ok":true');

    yield* Effect.promise(() =>
      waitFor(async () => {
        const workspace = Effect.runSync(daemon.getWorkspace);
        const pane = workspace.spaces[0]?.windows[0]?.layout.root;
        return (
          pane !== null &&
          typeof pane === "object" &&
          "agentSession" in pane &&
          (pane as { agentSession?: { value: string } }).agentSession?.value === "conv-persist"
        );
      }, "agent session ref to land on the pane"),
    );

    // Durable shortly after the report: session.json already carries the ref
    // while the daemon is still alive (SIGKILL of the reporter cannot undo it).
    const onDisk = yield* Effect.promise(async () => {
      const text = await Bun.file(paths.state).text();
      return JSON.parse(text) as {
        spaces: Array<{ windows: Array<{ layout: string }> }>;
      };
    });
    const diskLayout = JSON.parse(onDisk.spaces[0]!.windows[0]!.layout) as {
      root: { agentSession?: { source: string; agent: string; kind: string; value: string } };
    };
    expect(diskLayout.root.agentSession).toEqual({
      source: "amux:claude",
      agent: "claude",
      kind: "id",
      value: "conv-persist",
    });

    yield* daemon.close;
    const reloaded = yield* Effect.promise(() => run(startDaemon(daemon.id), env));
    daemons.push(reloaded);
    const restored = workspacePaneId(Effect.runSync(reloaded.getWorkspace));
    expect(restored).toBe(paneId);
    const root = Effect.runSync(reloaded.getWorkspace).spaces[0]!.windows[0]!.layout.root as {
      agentSession?: { value: string };
    };
    expect(root.agentSession?.value).toBe("conv-persist");
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

    const entry = new URL("../packages/amux/src/cli.ts", import.meta.url).pathname;
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
      const received: string[] = [];
      const socket = await Bun.connect({
        unix: paths.processState,
        socket: {
          data: (_socket, data) => void received.push(data.toString()),
        },
      });
      socket.write(
        JSON.stringify({
          id: "report",
          method: "process.state",
          params: { session: "pane-a", state: "running" },
        }) + "\n",
      );
      await waitFor(() => received.join("").includes('"id":"report"'), "process.state reply");
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

      // Valid JSON, but a method neither `process.state`, `topic.publish`, nor
      // `pane.report_agent_session`.
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

/* The DoD's two hardening clauses. A process inside a pane is something a user
 * runs, not something amux vouches for, so the socket it dials must be closed
 * to other Unix users, and a hook that dies mid-write must not take the daemon
 * down with it — the agent keeps running either way.
 *
 * This mode does not stop one of this daemon's own panes from naming another:
 * every pane a daemon supervises runs as the same user and is mutually
 * trusted with the others, the same way tmux panes are. See ARCHITECTURE.md's
 * "Trust model for process self-reports". */
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

test("stop answers before it tears its own socket down", async () => {
  const { daemon, env } = await started("control-stop");
  const paths = await run(sessionPaths(daemon.id), env);
  daemons.pop();
  await ctl(daemon.id, env, (c) => c.Stop());

  const gone = async (path: string) => {
    try {
      await waitFor(async () => !(await Bun.file(path).exists()), `path removed: ${path}`, 2_000);
      return true;
    } catch {
      return false;
    }
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

test("with a daemon, --help lists plugin daemon commands and a plugin verb parses", async () => {
  const home = tempDir("cli-help-daemon");
  const configHome = join(home, "config");
  const editor = new URL("../packages/editor", import.meta.url).pathname;
  mkdirSync(join(configHome, "amux"), { recursive: true });
  writeFileSync(
    join(configHome, "amux", "config.json"),
    JSON.stringify({
      plugins: [{ path: editor, enabled: true }],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: configHome,
  };
  const id = "cli-help-daemon";
  const daemon = await run(
    startDaemon(id, {
      pluginConfig: {
        options: {},
        keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
        plugins: [{ path: editor, enabled: true }],
        permissions: [],
        layoutRules: [],
      },
    }),
    env,
  );
  daemons.push(daemon);

  // Async spawn: the daemon runs in this process, so spawnSync would block the
  // event loop and the child could never complete its control RPC.
  const { AMUX_DAEMON_SESSION: _session, ...clean } = process.env;
  const runCli = async (args: string[]) => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        new URL("../packages/amux/src/cli.ts", import.meta.url).pathname,
        ...args,
      ],
      env: { ...clean, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };

  const help = await runCli(["--help", `--session=${id}`]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("editor.open");
  expect(help.stdout).not.toContain("Plugin commands appear when the session daemon is running.");

  const verb = await runCli(["editor.open", "--split", `--session=${id}`]);
  expect(verb.stderr).toBe("");
  expect(verb.exitCode).toBe(0);
});
