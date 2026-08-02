/**
 * The paste buffer stack over the daemon's real RPC socket, into real PTYs.
 *
 * The whole point of the buffers living on the server is that copy and paste
 * work with no client attached: the daemon holds the bytes and writes them
 * into its own PTYs. So these tests drive the verbs exactly the way a script
 * would — daemonRequest against the unix socket — and read the result back
 * out of a real child process's output.
 */

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { daemonRequest, SessionDaemon, type DaemonRequest, type DaemonResponse } from "./daemon.ts"
import { decodeAttachFrames, encodeAttachFrame, type AttachFrame } from "./effect/AttachProtocol.ts"
import { SessionEnv } from "./session.ts"

const dirs: string[] = []
const daemons: SessionDaemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function started(id: string) {
  const home = await mkdtemp(join(tmpdir(), "herdr-buffers-"))
  dirs.push(home)
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") }
  const daemon = await Effect.runPromise(SessionDaemon.open(id).pipe(Effect.provideService(SessionEnv, env)))
  daemons.push(daemon)
  await daemon.start()
  // The RPC client must resolve the same session paths, so it needs the same
  // env the daemon was started with.
  return { daemon, env }
}

const rpc = (id: string, request: DaemonRequest, env: NodeJS.ProcessEnv) =>
  Effect.runPromise(daemonRequest(id, request).pipe(Effect.provideService(SessionEnv, env)))

/** A raw client of the attach socket, keeping every output frame it receives. */
async function attach(path: string, client: string) {
  const frames: AttachFrame[] = []
  let buffer = ""
  const socket = await Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      open(socket) {
        socket.write(encodeAttachFrame({ _tag: "hello", client }))
      },
      data(_socket, data) {
        buffer += data.toString("utf8")
        const decoded = decodeAttachFrames(buffer)
        buffer = decoded.rest
        frames.push(...decoded.frames)
      },
    },
  })
  return { socket, frames }
}

const settle = (ms = 80) => Bun.sleep(ms)
const output = (frames: AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => Buffer.from(frame.data).toString("utf8"))
    .join("")

test("a copy pushed onto the stack pastes into a real pane's PTY", async () => {
  const { daemon, env } = await started("copy-paste")
  await daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 })
  const viewer = await attach(daemon.paths.attach, "watcher")
  await settle()

  // A copy is set-buffer with no name: it becomes the top of the stack.
  const set = await rpc(daemon.id, { command: "set-buffer", bufferData: "pasted text\n" }, env)
  expect(set).toEqual({ ok: true, bufferName: "0" })

  const pasted = await rpc(daemon.id, { command: "paste-buffer", bufferTarget: "pane" }, env)
  expect(pasted.ok).toBe(true)
  await settle(200)

  // `cat` echoes what it receives; raw, because it never enabled bracketed paste.
  const text = output(viewer.frames)
  expect(text).toContain("pasted text")
  expect(text).not.toContain("\x1b[200~")
  viewer.socket.end()
})

test("the stack is a stack: the newest copy is what a default paste reads", async () => {
  const { daemon, env } = await started("stack-order")
  await daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 })
  const viewer = await attach(daemon.paths.attach, "watcher")
  await settle()

  await rpc(daemon.id, { command: "set-buffer", bufferData: "older\n" }, env)
  await rpc(daemon.id, { command: "set-buffer", bufferData: "newer\n" }, env)
  const list = await rpc(daemon.id, { command: "list-buffers" }, env)
  expect(list.buffers?.map((buffer) => buffer.name)).toEqual(["1", "0"])

  await rpc(daemon.id, { command: "paste-buffer", bufferTarget: "pane" }, env)
  await settle(200)
  expect(output(viewer.frames)).toContain("newer")
  viewer.socket.end()
})

test("a named buffer pastes, shows, and deletes by name", async () => {
  const { daemon, env } = await started("named-buffer")
  await daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 })
  const viewer = await attach(daemon.paths.attach, "watcher")
  await settle()

  await rpc(daemon.id, { command: "set-buffer", bufferName: "clip", bufferData: "named\n" }, env)
  const shown = await rpc(daemon.id, { command: "show-buffer", bufferName: "clip" }, env)
  expect(shown).toEqual({ ok: true, bufferData: "named\n" })

  const pasted = await rpc(daemon.id, { command: "paste-buffer", bufferName: "clip", bufferTarget: "pane" }, env)
  expect(pasted.ok).toBe(true)
  await settle(200)
  expect(output(viewer.frames)).toContain("named")

  await rpc(daemon.id, { command: "delete-buffer", bufferName: "clip" }, env)
  const after = await rpc(daemon.id, { command: "show-buffer", bufferName: "clip" }, env)
  expect(after.ok).toBe(false)
  viewer.socket.end()
})

test("paste-buffer -d deletes the buffer only after it was pasted", async () => {
  const { daemon, env } = await started("paste-delete")
  await daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 })
  const viewer = await attach(daemon.paths.attach, "watcher")
  await settle()

  await rpc(daemon.id, { command: "set-buffer", bufferData: "gone after\n" }, env)
  const pasted = await rpc(daemon.id, { command: "paste-buffer", bufferTarget: "pane", bufferDelete: true }, env)
  expect(pasted.ok).toBe(true)
  await settle(200)
  expect(output(viewer.frames)).toContain("gone after")

  const list = await rpc(daemon.id, { command: "list-buffers" }, env)
  expect(list.buffers).toEqual([])
  viewer.socket.end()
})

test("a paste into a bracketed-paste-enabled child arrives wrapped", async () => {
  const { daemon, env } = await started("bracketed")
  // The child turns on DECSET 2004 (what vim, nano and bracketed shells do)
  // before reading, so a paste must arrive wrapped to be treated as one paste.
  // Echo and canonical mode are off: echo would rewrite the ESC bytes as ^[
  // (ECHOCTL), and canonical mode would hold back the \x1b[201~ tail because
  // it ends without a newline.
  await daemon.spawnAgent({
    id: "pane",
    cmd: ["sh", "-c", "printf '\\x1b[?2004h'; stty -echo -icanon; cat"],
    cols: 80,
    rows: 24,
  })
  const viewer = await attach(daemon.paths.attach, "watcher")
  await settle()

  await rpc(daemon.id, { command: "set-buffer", bufferData: "bracketed\n" }, env)
  await rpc(daemon.id, { command: "paste-buffer", bufferTarget: "pane" }, env)
  await settle(200)

  // cat's output path turns the \n into \r\n (ONLCR); the wrapping is intact.
  expect(output(viewer.frames)).toContain("\x1b[200~bracketed\r\n\x1b[201~")
  viewer.socket.end()
})

test("buffer failures are answers, not crashes", async () => {
  const { daemon, env } = await started("buffer-errors")
  await daemon.spawnAgent({ id: "pane", cmd: ["cat"], cols: 80, rows: 24 })
  await settle()

  const empty = await rpc(daemon.id, { command: "paste-buffer", bufferTarget: "pane" }, env)
  expect(empty.ok).toBe(false)
  expect(empty.error).toContain("no buffers")

  await rpc(daemon.id, { command: "set-buffer", bufferData: "x" }, env)
  const unknown = await rpc(daemon.id, { command: "paste-buffer", bufferTarget: "no-such-session" }, env)
  expect(unknown.ok).toBe(false)
  expect(unknown.error).toContain("unknown session 'no-such-session'")

  const missing = await rpc(daemon.id, { command: "set-buffer" }, env)
  expect(missing.ok).toBe(false)
  expect(missing.error).toContain("requires data")
})
