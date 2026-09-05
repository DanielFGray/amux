/**
 * The daemon as a live PTY owner, exercised over its real attach socket.
 *
 * These are the properties that separate a multiplexer from a terminal grid, so
 * they are tested against the actual socket and actual PTYs rather than against
 * the services in isolation: a session must outlive the client that started it,
 * and a client that dies without saying goodbye must still be noticed.
 */

import { ConfigProvider, Effect, Layer, Path } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { afterEach, expect } from "bun:test";
import { tmpdir } from "node:os";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { controlCall, type ControlClient } from "./control-client.ts";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./effect/AttachProtocol.ts";
import { SessionStore } from "./session.ts";
import { testEffect } from "./test-effect.ts";
import { until } from "./test-wait.ts";

const dirs: string[] = [];
const join = (...paths: string[]) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.join(...paths)).pipe(Effect.provide(Path.layer)),
  );
const basename = (value: string) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.basename(value)).pipe(Effect.provide(Path.layer)),
  );
const fsRun = <A>(
  effect: Effect.Effect<A, import("effect/PlatformError").PlatformError, FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)));
const mkdtemp = (prefix: string) =>
  fsRun(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.makeTempDirectory({ directory: tmpdir(), prefix: basename(prefix) }),
    ),
  );
const rm = (path: string, _options?: { recursive?: boolean; force?: boolean }) =>
  fsRun(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(path, { recursive: true, force: true }),
    ),
  );
const daemons: SessionDaemonService[] = [];
const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );
afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const daemon of daemons.splice(0)) yield* daemon.stop.pipe(Effect.ignore);
      for (const dir of dirs.splice(0))
        yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
    }),
  ),
);
const envs = new Map<string, NodeJS.ProcessEnv>();

const started = Effect.fnUntraced(function* (id: string) {
  const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-attach-host-")));
  dirs.push(home);
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
  const daemon = yield* Effect.promise(() => run(Effect.scoped(startDaemon(id)), env));
  daemons.push(daemon);
  envs.set(daemon.id, env);
  return daemon;
});

/** One control-plane request over the daemon's real Unix socket. */
const control = <A, E>(
  daemon: SessionDaemonService,
  use: (client: ControlClient) => Effect.Effect<A, E>,
) => run(controlCall(daemon.id, use), envs.get(daemon.id)!);

/** A client of the attach socket that keeps every frame it was sent. */
function client(path: string, hello: string, extra: string = "") {
  const frames: AttachFrame[] = [];
  let buffer = "";
  return Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      open(socket) {
        // Written as one payload on purpose: a real client will batch its
        // hello with whatever it already wanted to say, and both must land.
        socket.write(encodeAttachFrame({ _tag: "hello", client: hello }) + extra);
      },
      data(_socket, data) {
        buffer += data.toString("utf8");
        const decoded = decodeAttachFrames(buffer);
        buffer = decoded.rest;
        frames.push(...decoded.frames);
      },
    },
  }).then((socket) => ({ socket, frames }));
}

const text = (frames: AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => Buffer.from(frame.data).toString("utf8"))
    .join("");

// These tests assert on daemon state a real socket round trip settles
// asynchronously — attach/detach bookkeeping, frame delivery. A fixed sleep
// before asserting only holds up on a quiet machine; under the load a full
// suite run puts on the box, the round trip can still be in flight and the
// assertion sees the state from before it landed (ts-525c9b). `until` polls
// for the outcome instead, so a slow machine just takes longer rather than
// flaking.

testEffect("a session outlives the client that was watching it", () =>
  Effect.gen(function* () {
    const daemon = yield* started("survives");
    yield* daemon.spawnSession({
      id: "agent-1",
      cmd: ["sh", "-c", "sleep 0.4; echo still-here"],
      cols: 80,
      rows: 24,
    });

    const first = yield* Effect.promise(() => client(daemon.paths.attach, "watcher"));
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === "watcher"),
      "the watcher to attach",
    );

    // The client goes away while the process is still working.
    first.socket.end();
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === null),
      "the watcher to detach",
    );

    // A new client sees the output the old one was never around for, which is
    // only possible because nothing killed the PTY on disconnect.
    const second = yield* Effect.promise(() => client(daemon.paths.attach, "replacement"));
    yield* until(
      () => text(second.frames).includes("still-here"),
      "the still-running process's output",
    );
    second.socket.end();
  }),
);

testEffect("hello is honoured alongside frames batched behind it in one write", () =>
  Effect.gen(function* () {
    const daemon = yield* started("batched");
    yield* daemon.spawnSession({ id: "agent-1", cmd: ["cat"], cols: 80, rows: 24 });

    const attached = yield* Effect.promise(() =>
      client(
        daemon.paths.attach,
        "batcher",
        encodeAttachFrame({
          _tag: "input",
          session: "agent-1",
          data: new TextEncoder().encode("echoed\n"),
        }),
      ),
    );
    // `cat` echoes its input back, so seeing it proves the input frame was read
    // rather than stranded behind the hello.
    yield* until(() => text(attached.frames).includes("echoed"), "cat to echo the batched input");
    attached.socket.end();
  }),
);

testEffect("multiple clients hold independent attachments", () =>
  Effect.gen(function* () {
    const daemon = yield* started("shared");
    const first = yield* Effect.promise(() => client(daemon.paths.attach, "one"));
    yield* until(
      () => Effect.map(daemon.getAttachedClients, (c) => c.includes("one")),
      "the first client to attach",
    );

    const second = yield* Effect.promise(() => client(daemon.paths.attach, "two"));
    // Both, not "whichever arrived first": there is no owner to name any more.
    yield* until(
      () => Effect.map(daemon.getAttachedClients, (c) => [...c].sort().join(",") === "one,two"),
      "both clients to attach",
    );
    expect(second.frames.some((f) => f._tag === "error")).toBe(false);

    first.socket.end();
    // The survivor keeps the session attached, and it is specifically the one
    // that did NOT leave — asserting `attached` alone would also pass if the
    // release had wiped both and something else had re-attached.
    yield* until(
      () => Effect.map(daemon.getAttachedClients, (c) => c.join(",") === "two"),
      "the leaving client to release, the survivor to remain",
    );
    expect((yield* daemon.getState).attached).toBe(true);
    second.socket.end();
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === null),
      "the last client to detach",
    );
  }),
);

testEffect("a reconnect with the same client id cannot be released by the old socket", () =>
  Effect.gen(function* () {
    const daemon = yield* started("same-client-reconnect");
    const first = yield* Effect.promise(() => client(daemon.paths.attach, "stable"));
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === "stable"),
      "the first connection to attach",
    );

    first.socket.end();
    const second = yield* Effect.promise(() => client(daemon.paths.attach, "stable"));
    second.socket.write(encodeAttachFrame({ _tag: "ping", nonce: "replacement-alive" }));
    yield* until(
      () => second.frames.some((f) => f._tag === "pong" && f.nonce === "replacement-alive"),
      "the reconnected socket to answer a ping",
    );
    expect(yield* daemon.getAttachedClient).toBe("stable");
    expect(second.frames.some((frame) => frame._tag === "error")).toBe(false);
    second.socket.end();
  }),
);

testEffect("client death is reflected in the persisted session, not just in memory", () =>
  Effect.gen(function* () {
    const daemon = yield* started("persisted");
    const attached = yield* Effect.promise(() => client(daemon.paths.attach, "transient"));
    yield* until(() => Effect.map(daemon.getState, (s) => s.attached), "the client to attach");

    attached.socket.end();
    yield* until(
      () => Effect.map(daemon.getState, (s) => !s.attached),
      "the client's death to persist",
    );
  }),
);

testEffect("an input naming a dead session is ignored rather than dropping the attachment", () =>
  Effect.gen(function* () {
    const daemon = yield* started("stale-input");
    const attached = yield* Effect.promise(() => client(daemon.paths.attach, "racer"));
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === "racer"),
      "the client to attach",
    );

    attached.socket.write(
      encodeAttachFrame({
        _tag: "input",
        session: "agent-that-never-was",
        data: new TextEncoder().encode("x"),
      }),
    );
    attached.socket.write(encodeAttachFrame({ _tag: "ping", nonce: "alive" }));
    // Still attached: a keystroke in flight when a process exits is a race, not
    // a protocol violation, and must not take the whole connection down. The
    // ping answered proves it — a dropped connection would never reply.
    yield* until(
      () => attached.frames.some((f) => f._tag === "pong" && f.nonce === "alive"),
      "a ping sent after the stale input to be answered",
    );
    expect(yield* daemon.getAttachedClient).toBe("racer");
    attached.socket.end();
  }),
);

testEffect("stopping the daemon closes the attach socket and its sessions", () =>
  Effect.gen(function* () {
    const daemon = yield* started("teardown");
    const pty = yield* daemon.spawnSession({
      id: "agent-1",
      cmd: ["sleep", "30"],
      cols: 80,
      rows: 24,
    });
    const path = daemon.paths.attach;

    yield* daemon.stop;
    daemons.splice(daemons.indexOf(daemon), 1);

    yield* Effect.promise(() =>
      Bun.connect({ unix: path, socket: { data() {} } }).then(
        () => Promise.reject(new Error("attach socket unexpectedly accepted a connection")),
        () => undefined,
      ),
    );
    // The scope that owned the PTY is gone, so the process it was supervising is
    // gone with it rather than being orphaned. `sleep 30` would still be running
    // if the finalizer had not fired.
    const exited = yield* Effect.race(
      pty.exit.pipe(Effect.as("exited" as const)),
      Effect.sleep(2000).pipe(Effect.as("orphaned" as const)),
    );
    expect(exited).toBe("exited");
  }),
);

testEffect("closing a daemon persists that the preserved session is detached", () =>
  Effect.gen(function* () {
    const daemon = yield* started("close-detached");
    const attached = yield* Effect.promise(() => client(daemon.paths.attach, "watcher"));
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === "watcher"),
      "the watcher to attach",
    );

    yield* daemon.close;
    daemons.splice(daemons.indexOf(daemon), 1);
    attached.socket.end();

    const home = dirs[dirs.length - 1]!;
    expect(
      (yield* Effect.promise(() =>
        run(
          Effect.flatMap(SessionStore, (store) => store.load("close-detached")),
          {
            HOME: home,
            XDG_STATE_HOME: join(home, "state"),
          },
        ),
      ))?.attached,
    ).toBe(false);
  }),
);

testEffect("the daemon tracks when the attached client was last seen", () =>
  Effect.gen(function* () {
    const daemon = yield* started("last-seen");
    const attached = yield* Effect.promise(() => client(daemon.paths.attach, "watcher"));
    const ping = () => control(daemon, (c) => c.Ping());
    let claimed = yield* Effect.promise(ping);
    yield* until(
      () =>
        ping().then((c) => {
          claimed = c;
          return claimed.attached === true;
        }),
      "the watcher to attach",
    );
    expect(claimed.attachedSince).toBeGreaterThan(0);
    expect(claimed.attachLastSeen).toBeGreaterThan(0);

    // Any inbound frame refreshes last-seen — a heartbeat above all, because an
    // attached UI showing an idle agent sends nothing else for hours.
    const before = claimed.attachLastSeen!;
    attached.socket.write(encodeAttachFrame({ _tag: "ping", nonce: "keepalive" }));
    let after = before;
    yield* until(
      () =>
        ping().then((c) => {
          after = c.attachLastSeen!;
          return after > before;
        }),
      "the keepalive to refresh last-seen",
    );

    // Detach clears the freshness along with the attachment itself.
    attached.socket.end();
    let released = yield* Effect.promise(ping);
    yield* until(
      () =>
        ping().then((c) => {
          released = c;
          return released.attached === false;
        }),
      "the watcher's detach to clear the attachment",
    );
    expect(released.attachedSince).toBeUndefined();
    expect(released.attachLastSeen).toBeUndefined();
  }),
);
