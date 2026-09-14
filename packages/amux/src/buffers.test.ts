/**
 * One wire smoke: a daemon buffer paste reaches a real PTY.
 *
 * Stack order, named buffers, and empty-stack errors live in BufferStore.test.
 * Bracketed-paste wrapping lives in SessionSupervisor.test. paste-buffer -d
 * is show-then-delete on BufferStore (same file).
 */

import { afterEach, expect } from "bun:test";
import { ConfigProvider, Effect, Layer, Path } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { controlCall, type ControlClient } from "./control-client.ts";
import { registerCleanup, tempDir } from "./test-tmp.ts";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./effect/AttachProtocol.ts";
import { SessionStore } from "./session.ts";
import { testEffect } from "./test-effect.ts";
import { until, waitFor } from "./test-wait.ts";

registerCleanup();

const join = (...paths: string[]) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.join(...paths)).pipe(Effect.provide(Path.layer)),
  );
const daemons: SessionDaemonService[] = [];
afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const daemon of daemons.splice(0)) yield* daemon.stop.pipe(Effect.ignore);
    }),
  ),
);
const started = Effect.fnUntraced(function* (id: string) {
  const home = tempDir("buffers");
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
  const daemon = yield* Effect.scoped(startDaemon(id)).pipe(
    Effect.provide(
      SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );
  daemons.push(daemon);
  return { daemon, env };
});

const rpc = <A, E>(
  id: string,
  use: (control: ControlClient) => Effect.Effect<A, E>,
  env: NodeJS.ProcessEnv,
) =>
  controlCall(id, use).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );

const attach = (path: string, client: string) =>
  Effect.promise(() => {
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
  });

const output = (frames: AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => Buffer.from(frame.data).toString("utf8"))
    .join("");

const untilOutput = (frames: AttachFrame[], text: string) =>
  Effect.promise(() =>
    waitFor(() => output(frames).includes(text), `'${text}' in the pane's output`, 15_000),
  );

testEffect("a copy pushed onto the stack pastes into a real pane's PTY", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* started("copy-paste");
    yield* daemon.spawnSession({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 });
    const viewer = yield* attach(daemon.paths.attach, "watcher");
    yield* until(
      () => Effect.map(daemon.getAttachedClients, (c) => c.includes("watcher")),
      "the viewer to attach",
    );

    const set = yield* rpc(daemon.id, (c) => c.SetBuffer({ data: "pasted text\n" }), env);
    expect(set).toBe("0");

    yield* rpc(daemon.id, (c) => c.PasteBuffer({ target: "pane" }), env);
    yield* untilOutput(viewer.frames, "pasted text");

    const text = output(viewer.frames);
    expect(text).toContain("pasted text");
    expect(text).not.toContain("\x1b[200~");
    viewer.socket.end();
  }),
);
