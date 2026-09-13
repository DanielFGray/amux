/** @effect-diagnostics *:skip-file -- drives a real supervised child (spawn, sockets). */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer, Path, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "../daemon.ts";
import { SessionStore, processAlive } from "../session.ts";
import { controlCall } from "../control-client.ts";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "../effect/AttachProtocol.ts";
import { waitFor } from "../test-wait.ts";
import { registerCleanup, tempDir } from "../test-tmp.ts";

registerCleanup();

async function env() {
  const home = tempDir("plugin-host");
  return { HOME: home, XDG_STATE_HOME: join(home, "state") };
}

const provideEnv = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  e: NodeJS.ProcessEnv,
): Effect.Effect<A, E, Exclude<R, SessionStore | FileSystem.FileSystem | Path.Path>> =>
  effect.pipe(
    Effect.provide(
      SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(e)),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path | Scope.Scope>,
  e: NodeJS.ProcessEnv,
) => Effect.runPromise(Effect.scoped(provideEnv(effect, e)));

const hangFixture = fileURLToPath(new URL("./hang-fixture.ts", import.meta.url));

/** Attach client that records output frames — daemon path for reading a PTY. */
const attach = (path: string, client: string) => {
  const frames: AttachFrame[] = [];
  let buffer = "";
  return Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      open(socket) {
        socket.write(encodeAttachFrame({ _tag: "hello", client }));
      },
      data(_socket, data) {
        buffer += data.toString("utf8");
        const decoded = decodeAttachFrames(buffer);
        buffer = decoded.rest;
        frames.push(...decoded.frames);
      },
    },
  }).then((socket) => ({ socket, frames }));
};

const outputText = (frames: AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => Buffer.from(frame.data).toString("utf8"))
    .join("");

const open = (
  id: string,
  e: NodeJS.ProcessEnv,
  pluginHost?: {
    readonly hang?: boolean;
    readonly argv?: readonly string[];
  },
) => {
  const timing = {
    pingIntervalMs: 200,
    pingTimeoutMs: 500,
    backoffInitialMs: 50,
    backoffMaxMs: 200,
  };
  const argv = pluginHost?.argv
    ? pluginHost.argv
    : pluginHost?.hang
      ? [process.execPath, hangFixture]
      : undefined;
  return run(
    startDaemon(id, {
      pluginHost: argv ? { ...timing, argv } : timing,
    }),
    e,
  );
};

const status = (d: SessionDaemonService, e: NodeJS.ProcessEnv) =>
  run(controlCall(d.id, (c) => c.Status()), e);

const waitReady = async (d: SessionDaemonService, e: NodeJS.ProcessEnv) => {
  let report = await status(d, e);
  await waitFor(
    async () => {
      report = await status(d, e);
      return report.pluginHost.state === "ready";
    },
    "plugin-host to become ready",
    15_000,
  );
  return report;
};

test("the daemon starts the plugin-host and Ping answers (Status ready)", async () => {
  const e = await env();
  const daemon = await open("ph-start", e);
  const report = await waitReady(daemon, e);
  expect(report.pluginHost.state).toBe("ready");
  expect(report.pluginHost.restarts).toBe(0);
  expect(report.pluginHost.pid).toBeGreaterThan(0);
  expect(await Effect.runPromise(processAlive(report.pluginHost.pid!))).toBe(true);

  await Effect.runPromise(daemon.stop);
}, 30_000);

test("killing the host restarts it and an existing session keeps running", async () => {
  const e = await env();
  const daemon = await open("ph-kill", e);
  await waitReady(daemon, e);

  // SessionSupervisor owns session.output and publishes to the attach hub.
  // Activate happens at spawn — replay before attach is lost — so prove the
  // PTY the way buffers.test.ts does: attach, then write, then read frames.
  const pty = await run(
    daemon.spawnSession({
      id: "keep-alive",
      cmd: ["cat"],
      cols: 80,
      rows: 24,
    }),
    e,
  );

  const viewer = await attach(daemon.paths.attach, "watcher");
  await waitFor(
    async () => (await Effect.runPromise(daemon.getAttachedClients)).includes("watcher"),
    "attach watcher to claim the daemon",
    10_000,
  );

  await run(pty.write("before-restart\n"), e);
  await waitFor(
    async () => outputText(viewer.frames).includes("before-restart"),
    "keep-alive session to echo before host kill",
    10_000,
  );

  const before = await status(daemon, e);
  const oldPid = before.pluginHost.pid;
  expect(oldPid).toBeGreaterThan(0);
  process.kill(oldPid!, "SIGKILL");

  await waitFor(
    async () => {
      const report = await status(daemon, e);
      return report.pluginHost.restarts >= 1 && report.pluginHost.state === "ready";
    },
    "plugin-host to restart after kill",
    15_000,
  );

  await run(pty.write("still-here\n"), e);
  await waitFor(
    async () => outputText(viewer.frames).includes("still-here"),
    "PTY to echo after host restart",
    10_000,
  );

  viewer.socket.end();
  await Effect.runPromise(daemon.stop);
}, 40_000);

test("a host that stops answering pings is restarted", async () => {
  const e = await env();
  const daemon = await open("ph-hang", e, { hang: true });
  await waitReady(daemon, e);

  await waitFor(
    async () => {
      const report = await status(daemon, e);
      return report.pluginHost.restarts >= 1 && report.pluginHost.state === "ready";
    },
    "hanging plugin-host to be restarted",
    20_000,
  );

  const report = await status(daemon, e);
  expect(report.pluginHost.restarts).toBeGreaterThanOrEqual(1);
  expect(report.pluginHost.state).toBe("ready");

  await Effect.runPromise(daemon.stop);
}, 40_000);

test("stopping the daemon stops the host and no host process remains", async () => {
  const e = await env();
  const daemon = await open("ph-stop", e);
  const ready = await waitReady(daemon, e);
  const pid = ready.pluginHost.pid;
  expect(pid).toBeGreaterThan(0);
  expect(await Effect.runPromise(processAlive(pid!))).toBe(true);

  await Effect.runPromise(daemon.stop);

  await waitFor(
    async () => !(await Effect.runPromise(processAlive(pid!))),
    "plugin-host process to exit after daemon stop",
    10_000,
  );
  expect(await Effect.runPromise(processAlive(pid!))).toBe(false);
}, 30_000);

test("stopping during connect stays within the shutdown deadline and leaves no host", async () => {
  const e = await env();
  // Child never binds the control socket — supervisor stays in connect/open.
  const daemon = await open("ph-stop-connect", e, {
    argv: [process.execPath, "-e", "await Bun.sleep(999999)"],
  });

  await waitFor(
    async () => {
      const report = await status(daemon, e);
      return report.pluginHost.pid !== undefined && report.pluginHost.pid > 0;
    },
    "plugin-host child to be spawned while still connecting",
    5_000,
  );
  const mid = await status(daemon, e);
  const pid = mid.pluginHost.pid!;
  expect(mid.pluginHost.state).not.toBe("ready");
  expect(await Effect.runPromise(processAlive(pid))).toBe(true);

  const stopped = await Promise.race([
    Effect.runPromise(daemon.stop).then(() => "ok" as const),
    Bun.sleep(1000).then(() => "deadline" as const),
  ]);
  expect(stopped).toBe("ok");
  expect(await Effect.runPromise(processAlive(pid))).toBe(false);
}, 30_000);

test("Status reports plugin-host restart with stable fields", async () => {
  const e = await env();
  const daemon = await open("ph-status", e);
  const ready = await waitReady(daemon, e);
  expect(ready.pluginHost.state).toBe("ready");
  expect(ready.pluginHost.restarts).toBe(0);
  const oldPid = ready.pluginHost.pid;
  expect(oldPid).toBeGreaterThan(0);

  process.kill(oldPid!, "SIGKILL");

  await waitFor(
    async () => {
      const report = await status(daemon, e);
      return report.pluginHost.restarts >= 1 && report.pluginHost.state === "ready";
    },
    "plugin-host to become ready after restart",
    15_000,
  );

  const final = await status(daemon, e);
  expect(final.pluginHost.state).toBe("ready");
  expect(final.pluginHost.restarts).toBeGreaterThanOrEqual(1);
  expect(final.pluginHost.lastError).toBeDefined();
  expect(final.pluginHost.pid).toBeGreaterThan(0);
  expect(final.pluginHost.pid).not.toBe(oldPid);

  await Effect.runPromise(daemon.stop);
}, 30_000);
