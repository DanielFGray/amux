/**
 * The paste buffer stack over the daemon's real RPC socket, into real PTYs.
 *
 * The whole point of the buffers living on the server is that copy and paste
 * work with no client attached: the daemon holds the bytes and writes them
 * into its own PTYs. So these tests drive the verbs exactly the way a script
 * would — the @effect/rpc control plane on the unix socket — and read the result back
 * out of a real child process's output.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Scope } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { controlCall, type ControlClient } from "./control-client.ts";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./effect/AttachProtocol.ts";
import { Session } from "./session.ts";

const dirs: string[] = [];
const daemons: SessionDaemonService[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop).catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function started(id: string) {
  const home = await mkdtemp(join(tmpdir(), "amux-buffers-"));
  dirs.push(home);
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
  const daemon = await Effect.runPromise(
    Effect.scoped(startDaemon(id)).pipe(
      Effect.provide(Session.Default),
      Effect.provide(BunFileSystem.layer),
      Effect.withConfigProvider(ConfigProvider.fromJson(env)),
    ),
  );
  daemons.push(daemon);
  // The RPC client must resolve the same session paths, so it needs the same
  // env the daemon was started with.
  return { daemon, env };
}

const rpc = <A, E>(
  id: string,
  use: (control: ControlClient) => Effect.Effect<A, E>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    controlCall(id, use).pipe(
      Effect.withConfigProvider(ConfigProvider.fromJson(env)),
    ),
  );

/** The failure message of a control call that is expected to be refused. */
const refusal = <A, E>(
  id: string,
  use: (control: ControlClient) => Effect.Effect<A, E>,
  env: NodeJS.ProcessEnv,
) => rpc(id, (control) => Effect.flip(use(control)), env).then((error) => String(error));

/** A raw client of the attach socket, keeping every output frame it receives. */
async function attach(path: string, client: string) {
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
}

const settle = (ms = 80) => Bun.sleep(ms);
const output = (frames: AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => Buffer.from(frame.data).toString("utf8"))
    .join("");

test("a copy pushed onto the stack pastes into a real pane's PTY", async () => {
  const { daemon, env } = await started("copy-paste");
  await Effect.runPromise(daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 }));
  const viewer = await attach(daemon.paths.attach, "watcher");
  await settle();

  // A copy is set-buffer with no name: it becomes the top of the stack.
  const set = await rpc(daemon.id, (c) => c.SetBuffer({ data: "pasted text\n" }), env);
  expect(set).toBe("0");

  await rpc(daemon.id, (c) => c.PasteBuffer({ target: "pane" }), env);
  await settle(200);

  // `cat` echoes what it receives; raw, because it never enabled bracketed paste.
  const text = output(viewer.frames);
  expect(text).toContain("pasted text");
  expect(text).not.toContain("\x1b[200~");
  viewer.socket.end();
});

test("the stack is a stack: the newest copy is what a default paste reads", async () => {
  const { daemon, env } = await started("stack-order");
  await Effect.runPromise(daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 }));
  const viewer = await attach(daemon.paths.attach, "watcher");
  await settle();

  await rpc(daemon.id, (c) => c.SetBuffer({ data: "older\n" }), env);
  await rpc(daemon.id, (c) => c.SetBuffer({ data: "newer\n" }), env);
  const list = await rpc(daemon.id, (c) => c.ListBuffers(), env);
  expect(list.map((buffer) => buffer.name)).toEqual(["1", "0"]);

  await rpc(daemon.id, (c) => c.PasteBuffer({ target: "pane" }), env);
  await settle(200);
  expect(output(viewer.frames)).toContain("newer");
  viewer.socket.end();
});

test("a named buffer pastes, shows, and deletes by name", async () => {
  const { daemon, env } = await started("named-buffer");
  await Effect.runPromise(daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 }));
  const viewer = await attach(daemon.paths.attach, "watcher");
  await settle();

  await rpc(daemon.id, (c) => c.SetBuffer({ name: "clip", data: "named\n" }), env);
  expect(await rpc(daemon.id, (c) => c.ShowBuffer({ name: "clip" }), env)).toBe("named\n");

  await rpc(daemon.id, (c) => c.PasteBuffer({ name: "clip", target: "pane" }), env);
  await settle(200);
  expect(output(viewer.frames)).toContain("named");

  await rpc(daemon.id, (c) => c.DeleteBuffer({ name: "clip" }), env);
  expect(await refusal(daemon.id, (c) => c.ShowBuffer({ name: "clip" }), env)).toContain("clip");
  viewer.socket.end();
});

test("paste-buffer -d deletes the buffer only after it was pasted", async () => {
  const { daemon, env } = await started("paste-delete");
  await Effect.runPromise(daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 }));
  const viewer = await attach(daemon.paths.attach, "watcher");
  await settle();

  await rpc(daemon.id, (c) => c.SetBuffer({ data: "gone after\n" }), env);
  await rpc(daemon.id, (c) => c.PasteBuffer({ target: "pane", deleteAfter: true }), env);
  await settle(200);
  expect(output(viewer.frames)).toContain("gone after");

  expect(await rpc(daemon.id, (c) => c.ListBuffers(), env)).toEqual([]);
  viewer.socket.end();
});

test("a paste into a bracketed-paste-enabled child arrives wrapped", async () => {
  const { daemon, env } = await started("bracketed");
  // The child turns on DECSET 2004 (what vim, nano and bracketed shells do)
  // before reading, so a paste must arrive wrapped to be treated as one paste.
  // Echo and canonical mode are off: echo would rewrite the ESC bytes as ^[
  // (ECHOCTL), and canonical mode would hold back the \x1b[201~ tail because
  // it ends without a newline.
  await Effect.runPromise(
    daemon.spawnAgent({
      id: "pane",
      cmd: ["sh", "-c", "printf '\\x1b[?2004h'; stty -echo -icanon; cat"],
      cols: 80,
      rows: 24,
    }),
  );
  const viewer = await attach(daemon.paths.attach, "watcher");
  await settle();

  await rpc(daemon.id, (c) => c.SetBuffer({ data: "bracketed\n" }), env);
  await rpc(daemon.id, (c) => c.PasteBuffer({ target: "pane" }), env);
  await settle(200);

  // cat's output path turns the \n into \r\n (ONLCR); the wrapping is intact.
  expect(output(viewer.frames)).toContain("\x1b[200~bracketed\r\n\x1b[201~");
  viewer.socket.end();
});

test("buffer failures are answers, not crashes", async () => {
  const { daemon, env } = await started("buffer-errors");
  await Effect.runPromise(daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 }));
  await settle();

  expect(await refusal(daemon.id, (c) => c.PasteBuffer({ target: "pane" }), env)).toContain(
    "no buffers",
  );

  await rpc(daemon.id, (c) => c.SetBuffer({ data: "x" }), env);
  expect(
    await refusal(daemon.id, (c) => c.PasteBuffer({ target: "no-such-session" }), env),
  ).toContain("unknown session 'no-such-session'");

  // A missing `data` field is a schema violation, not a refusal: the payload
  // fails to encode and the request never reaches the daemon at all.
  await expect(rpc(daemon.id, (c) => c.SetBuffer({} as { data: string }), env)).rejects.toThrow(
    "is missing",
  );
});
