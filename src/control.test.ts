/**
 * The control plane end to end: a real `@effect/rpc` client against the real
 * daemon, over the session's real Unix socket.
 *
 * Everything here goes over the wire on purpose. The daemon's in-process
 * surface is a different thing from what a script, a CLI or another machine's
 * client can ask of it, and the second is the contract worth pinning.
 */
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Scope, Stream } from "effect";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { controlCall, connectControl, type ControlClient } from "./control-client.ts";
import { command } from "./commands.ts";
import { MAX_RPC_BYTES } from "./limits.ts";
import { Session, SessionEnv, sessionPaths } from "./session.ts";
import { parseWorkspaceJson } from "./workspace.ts";

const dirs: string[] = [];
const daemons: SessionDaemonService[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop).catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const run = <A>(
  effect: Effect.Effect<A, unknown, Session | SessionEnv | FileSystem.FileSystem | Scope.Scope>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(Session.Default),
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(SessionEnv, env),
    ),
  );

async function started(id: string) {
  const home = await mkdtemp(join(tmpdir(), "amux-control-"));
  dirs.push(home);
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv;
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

  expect(await ctl(daemon.id, env, (c) => c.Ping())).toEqual({ attached: false });

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

  expect(() => parseWorkspaceJson("not json")).toThrow();
  expect(() => parseWorkspaceJson(JSON.stringify({ revision: 0 }))).toThrow();
  expect(parseWorkspaceJson(status.workspace).revision).toBeGreaterThanOrEqual(0);
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

test("the events stream is ready before it observes later workspace changes", async () => {
  const { daemon, env } = await started("control-events");
  const before = Effect.runSync(daemon.getWorkspace);
  const event = await run(
    Effect.gen(function* () {
      const control = yield* connectControl(daemon.id);
      const stream = control.Events().pipe(
        Stream.tap((item) =>
          item.event._tag === "events.ready"
            ? control
                .Run({
                  value: command("space.rename", { name: "event-space" }),
                  expectedRevision: before.revision,
                  context,
                })
                .pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.filter((item) => item.event._tag === "space.changed"),
      );
      return yield* Stream.runHead(stream);
    }),
    env,
  );
  expect(Option.map(event, (item) => item.event)).toEqual(
    Option.some({
      _tag: "space.changed",
      space: before.spaces[0]!.id,
      change: "renamed",
    }),
  );
});

test("a refused command arrives as the daemon's typed failure, not a crash", async () => {
  const { daemon, env } = await started("control-typed-failure");
  const workspace = Effect.runSync(daemon.getWorkspace);

  const error = await ctl(daemon.id, env, (c) =>
    Effect.flip(
      c.WorkspaceCommand({
        value: command("space.rename", { name: "loser" }),
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

test("a workspace command run over the socket installs the new generation", async () => {
  const { daemon, env } = await started("control-run");
  const before = Effect.runSync(daemon.getWorkspace);

  const { workspace } = await ctl(daemon.id, env, (c) =>
    c.Run({
      value: command("space.rename", { name: "named-remotely" }),
      expectedRevision: before.revision,
      context,
    }),
  );
  expect(JSON.parse(workspace!).spaces[0].name).toBe("named-remotely");
  expect(Effect.runSync(daemon.getWorkspace).spaces[0]!.name).toBe("named-remotely");
});

test("a native agent can capture a live session through the command surface", async () => {
  const { daemon, env } = await started("agent-tools");
  const id = "capture-agent";
  await Effect.runPromise(
    daemon.spawnAgent({
      kind: "pty",
      id,
      cmd: ["sh", "-c", "printf 'capture-me\\n'; sleep 30"],
      cols: 80,
      rows: 24,
    }),
  );
  await Bun.sleep(50);
  const { result } = await ctl(daemon.id, env, (c) =>
    c.Run({ value: command("pane.capture", { session: id }) }),
  );
  expect(result).toContain("capture-me");
  await Effect.runPromise(daemon.killAgent(id));
});

test("a native worker invokes pane.capture through the amux CLI", async () => {
  const { daemon, env } = await started("agent-cli-tools");
  const target = "capture-target";
  await Effect.runPromise(
    daemon.spawnAgent({
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
    daemon.spawnAgent({
      kind: "agent",
      id: worker,
      cmd: [process.execPath, "-e", script],
      cols: 80,
      rows: 24,
    }),
  );
  const session = await ctl(daemon.id, env, (c) => c.Status());
  expect(session.agents).toContain(worker);
  await Bun.sleep(300);
  await Effect.runPromise(daemon.killAgent(target));
  await Effect.runPromise(daemon.killAgent(worker));
});

test("the pane control socket accepts ping and agent state reports", async () => {
  const { daemon, env } = await started("pane-control");
  const paths = await run(sessionPaths(daemon.id), env);
  const lines: string[] = [];
  const socket = await Bun.connect({
    unix: paths.control,
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
  await Bun.sleep(50);
  socket.end();
  expect(lines.join("\n")).toContain('"id":"one"');
  expect(lines.join("\n")).toContain('"id":"two"');
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
  expect(await run(Session.load(daemon.id), env)).toBeNull();
});
