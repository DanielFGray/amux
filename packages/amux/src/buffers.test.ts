/**
 * The paste buffer stack over the daemon's real RPC socket, into real PTYs.
 *
 * The whole point of the buffers living on the server is that copy and paste
 * work with no client attached: the daemon holds the bytes and writes them
 * into its own PTYs. So these tests drive the verbs exactly the way a script
 * would — the @effect/rpc control plane on the unix socket — and read the result back
 * out of a real child process's output.
 */

import { afterEach, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, ConfigProvider, Effect, SchemaIssue } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { controlCall, type ControlClient } from "./control-client.ts";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./effect/AttachProtocol.ts";
import { SessionStore } from "./session.ts";
import { testEffect } from "./test-effect.ts";
import { waitFor } from "./test-wait.ts";

const dirs: string[] = [];
const daemons: SessionDaemonService[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop).catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const started = (id: string) =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-buffers-")));
    dirs.push(home);
    const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
    const daemon = yield* Effect.scoped(startDaemon(id)).pipe(
      Effect.provide(SessionStore.layer),
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    );
    daemons.push(daemon);
    // The RPC client must resolve the same session paths, so it needs the same
    // env the daemon was started with.
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

/** The failure message of a control call that is expected to be refused. */
const refusal = <A, E>(
  id: string,
  use: (control: ControlClient) => Effect.Effect<A, E>,
  env: NodeJS.ProcessEnv,
) => rpc(id, (control) => Effect.flip(use(control)), env).pipe(Effect.map(String));

/** A raw client of the attach socket, keeping every output frame it receives. */
const attach = (path: string, client: string) =>
  Effect.promise(async () => {
    const frames: AttachFrame[] = [];
    let buffer = "";
    const socket = await Bun.connect({
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
    });
    return { socket, frames };
  });

const settle = (ms = 80) => Effect.sleep(ms);
const output = (frames: AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => Buffer.from(frame.data).toString("utf8"))
    .join("");

/**
 * Wait for the pane's echoed output to contain `text`.
 *
 * A paste crosses the RPC socket, a real PTY, the child's own read and write,
 * and the attach socket back. No fixed delay bounds that — a machine under load
 * loses the race and the test fails for a reason that has nothing to do with
 * buffers. The output is the event; wait on it.
 */
const untilOutput = (frames: AttachFrame[], text: string) =>
  Effect.promise(() =>
    waitFor(() => output(frames).includes(text), `'${text}' in the pane's output`),
  );

testEffect("a copy pushed onto the stack pastes into a real pane's PTY", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* started("copy-paste");
    yield* daemon.spawnSession({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 });
    const viewer = yield* attach(daemon.paths.attach, "watcher");
    yield* settle();

    // A copy is set-buffer with no name: it becomes the top of the stack.
    const set = yield* rpc(daemon.id, (c) => c.SetBuffer({ data: "pasted text\n" }), env);
    expect(set).toBe("0");

    yield* rpc(daemon.id, (c) => c.PasteBuffer({ target: "pane" }), env);
    yield* untilOutput(viewer.frames, "pasted text");

    // `cat` echoes what it receives; raw, because it never enabled bracketed paste.
    const text = output(viewer.frames);
    expect(text).toContain("pasted text");
    expect(text).not.toContain("\x1b[200~");
    viewer.socket.end();
  }),
);

testEffect("the stack is a stack: the newest copy is what a default paste reads", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* started("stack-order");
    yield* daemon.spawnSession({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 });
    const viewer = yield* attach(daemon.paths.attach, "watcher");
    yield* settle();

    yield* rpc(daemon.id, (c) => c.SetBuffer({ data: "older\n" }), env);
    yield* rpc(daemon.id, (c) => c.SetBuffer({ data: "newer\n" }), env);
    const list = yield* rpc(daemon.id, (c) => c.ListBuffers(), env);
    expect(list.map((buffer) => buffer.name)).toEqual(["1", "0"]);

    yield* rpc(daemon.id, (c) => c.PasteBuffer({ target: "pane" }), env);
    yield* untilOutput(viewer.frames, "newer");
    viewer.socket.end();
  }),
);

testEffect("a named buffer pastes, shows, and deletes by name", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* started("named-buffer");
    yield* daemon.spawnSession({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 });
    const viewer = yield* attach(daemon.paths.attach, "watcher");
    yield* settle();

    yield* rpc(daemon.id, (c) => c.SetBuffer({ name: "clip", data: "named\n" }), env);
    expect(yield* rpc(daemon.id, (c) => c.ShowBuffer({ name: "clip" }), env)).toBe("named\n");

    yield* rpc(daemon.id, (c) => c.PasteBuffer({ name: "clip", target: "pane" }), env);
    yield* untilOutput(viewer.frames, "named");

    yield* rpc(daemon.id, (c) => c.DeleteBuffer({ name: "clip" }), env);
    expect(yield* refusal(daemon.id, (c) => c.ShowBuffer({ name: "clip" }), env)).toContain("clip");
    viewer.socket.end();
  }),
);

testEffect("paste-buffer -d deletes the buffer only after it was pasted", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* started("paste-delete");
    yield* daemon.spawnSession({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 });
    const viewer = yield* attach(daemon.paths.attach, "watcher");
    yield* settle();

    yield* rpc(daemon.id, (c) => c.SetBuffer({ data: "gone after\n" }), env);
    yield* rpc(daemon.id, (c) => c.PasteBuffer({ target: "pane", deleteAfter: true }), env);
    yield* untilOutput(viewer.frames, "gone after");

    expect(yield* rpc(daemon.id, (c) => c.ListBuffers(), env)).toEqual([]);
    viewer.socket.end();
  }),
);

testEffect("a paste into a bracketed-paste-enabled child arrives wrapped", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* started("bracketed");
    // The child turns on DECSET 2004 (what vim, nano and bracketed shells do)
    // before reading, so a paste must arrive wrapped to be treated as one paste.
    // Echo and canonical mode are off: echo would rewrite the ESC bytes as ^[
    // (ECHOCTL), and canonical mode would hold back the \x1b[201~ tail because
    // it ends without a newline.
    yield* daemon.spawnSession({
      id: "pane",
      cmd: ["sh", "-c", "printf '\\x1b[?2004h'; stty -echo -icanon; cat"],
      cols: 80,
      rows: 24,
    });
    const viewer = yield* attach(daemon.paths.attach, "watcher");
    yield* settle();

    yield* rpc(daemon.id, (c) => c.SetBuffer({ data: "bracketed\n" }), env);
    yield* rpc(daemon.id, (c) => c.PasteBuffer({ target: "pane" }), env);
    // cat's output path turns the \n into \r\n (ONLCR); the wrapping is intact.
    yield* untilOutput(viewer.frames, "\x1b[200~bracketed\r\n\x1b[201~");
    viewer.socket.end();
  }),
);

testEffect("buffer failures are answers, not crashes", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* started("buffer-errors");
    yield* daemon.spawnSession({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 });
    yield* settle();

    expect(yield* refusal(daemon.id, (c) => c.PasteBuffer({ target: "pane" }), env)).toContain(
      "no buffers",
    );

    yield* rpc(daemon.id, (c) => c.SetBuffer({ data: "x" }), env);
    expect(
      yield* refusal(daemon.id, (c) => c.PasteBuffer({ target: "no-such-session" }), env),
    ).toContain("unknown session 'no-such-session'");

    // A missing `data` field is a schema violation, not a refusal: the payload
    // fails to encode and the request never reaches the daemon at all. The
    // payload constructor throws a generic message and hands the issue over as
    // the cause, so which field went missing is read from there. It arrives as a
    // defect rather than a typed failure, so the whole cause is what to inspect.
    type SetBufferInput = Parameters<ControlClient["SetBuffer"]>[0];
    const thrown = yield* rpc(daemon.id, (c) => c.SetBuffer({} as SetBufferInput), env).pipe(
      Effect.as(undefined),
      Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause) as Error)),
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(SchemaIssue.makeFormatterDefault()(thrown!.cause as SchemaIssue.Issue)).toContain(
      'Missing key\n  at ["data"]',
    );
  }),
);
