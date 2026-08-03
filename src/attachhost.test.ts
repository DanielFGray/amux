/**
 * The daemon as a live PTY owner, exercised over its real attach socket.
 *
 * These are the properties that separate a multiplexer from a terminal grid, so
 * they are tested against the actual socket and actual PTYs rather than against
 * the services in isolation: a session must outlive the client that started it,
 * and a client that dies without saying goodbye must still be noticed.
 */

import { Effect } from "effect"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionDaemon } from "./daemon.ts"
import { decodeAttachFrames, encodeAttachFrame, type AttachFrame } from "./effect/AttachProtocol.ts"
import { loadSession, SessionEnv } from "./session.ts"

const dirs: string[] = []
const daemons: SessionDaemon[] = []
const run = <A>(effect: Effect.Effect<A, unknown, SessionEnv>, env: NodeJS.ProcessEnv) => Effect.runPromise(effect.pipe(Effect.provideService(SessionEnv, env)))
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function started(id: string) {
  const home = await mkdtemp(join(tmpdir(), "amux-attach-host-"))
  dirs.push(home)
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") }
  const daemon = await run(SessionDaemon.open(id), env)
  daemons.push(daemon)
  await daemon.start()
  return daemon
}

/** A client of the attach socket that keeps every frame it was sent. */
async function client(path: string, hello: string, extra: string = "") {
  const frames: AttachFrame[] = []
  let buffer = ""
  const socket = await Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      open(socket) {
        // Written as one payload on purpose: a real client will batch its
        // hello with whatever it already wanted to say, and both must land.
        socket.write(encodeAttachFrame({ _tag: "hello", client: hello }) + extra)
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

const settle = (ms = 60) => Bun.sleep(ms)
const text = (frames: AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => Buffer.from(frame.data).toString("utf8"))
    .join("")

test("a session outlives the client that was watching it", async () => {
  const daemon = await started("survives")
  const pty = await daemon.spawnAgent({
    id: "agent-1",
    cmd: ["sh", "-c", "sleep 0.4; echo still-here"],
    cols: 80,
    rows: 24,
  })

  const first = await client(daemon.paths.attach, "watcher")
  await settle()
  expect(daemon.attachedClient).toBe("watcher")

  // The client goes away while the process is still working.
  first.socket.end()
  await settle()
  expect(daemon.attachedClient).toBeNull()

  // A new client sees the output the old one was never around for, which is
  // only possible because nothing killed the PTY on disconnect.
  const second = await client(daemon.paths.attach, "replacement")
  await settle(800)
  expect(text(second.frames)).toContain("still-here")
  second.socket.end()
})

test("hello is honoured alongside frames batched behind it in one write", async () => {
  const daemon = await started("batched")
  await daemon.spawnAgent({ id: "agent-1", cmd: ["cat"], cols: 80, rows: 24 })

  const attached = await client(
    daemon.paths.attach,
    "batcher",
    encodeAttachFrame({
      _tag: "input",
      session: "agent-1",
      data: new TextEncoder().encode("echoed\n"),
    }),
  )
  await settle(250)

  // `cat` echoes its input back, so seeing it proves the input frame was read
  // rather than stranded behind the hello.
  expect(text(attached.frames)).toContain("echoed")
  attached.socket.end()
})

test("multiple clients hold independent attachments", async () => {
  const daemon = await started("shared")
  const first = await client(daemon.paths.attach, "one")
  await settle()

  const second = await client(daemon.paths.attach, "two")
  await settle()
  expect(second.frames.some((f) => f._tag === "error")).toBe(false)
  // Both, not "whichever arrived first": there is no owner to name any more.
  expect(daemon.attachedClients.sort()).toEqual(["one", "two"])

  first.socket.end()
  await settle()
  // The survivor keeps the session attached, and it is specifically the one
  // that did NOT leave — asserting `attached` alone would also pass if the
  // release had wiped both and something else had re-attached.
  expect(daemon.attachedClients).toEqual(["two"])
  expect(daemon.state.attached).toBe(true)
  second.socket.end()
  await settle()
  expect(daemon.attachedClient).toBeNull()
})

test("a reconnect with the same client id cannot be released by the old socket", async () => {
  const daemon = await started("same-client-reconnect")
  const first = await client(daemon.paths.attach, "stable")
  await settle()

  first.socket.end()
  const second = await client(daemon.paths.attach, "stable")
  await settle()

  expect(daemon.attachedClient).toBe("stable")
  expect(second.frames.some((frame) => frame._tag === "error")).toBe(false)
  second.socket.write(encodeAttachFrame({ _tag: "ping", nonce: "replacement-alive" }))
  await settle()
  expect(second.frames).toContainEqual({ _tag: "pong", nonce: "replacement-alive" })
  second.socket.end()
})

test("client death is reflected in the persisted session, not just in memory", async () => {
  const daemon = await started("persisted")
  const attached = await client(daemon.paths.attach, "transient")
  await settle()
  expect(daemon.state.attached).toBe(true)

  attached.socket.end()
  await settle()
  expect(daemon.state.attached).toBe(false)
})

test("an input naming a dead session is ignored rather than dropping the attachment", async () => {
  const daemon = await started("stale-input")
  const attached = await client(daemon.paths.attach, "racer")
  await settle()

  attached.socket.write(encodeAttachFrame({
    _tag: "input",
    session: "agent-that-never-was",
    data: new TextEncoder().encode("x"),
  }))
  await settle()

  // Still attached: a keystroke in flight when a process exits is a race, not
  // a protocol violation, and must not take the whole connection down.
  expect(daemon.attachedClient).toBe("racer")
  attached.socket.write(encodeAttachFrame({ _tag: "ping", nonce: "alive" }))
  await settle()
  expect(attached.frames.some((f) => f._tag === "pong" && f.nonce === "alive")).toBe(true)
  attached.socket.end()
})

test("stopping the daemon closes the attach socket and its sessions", async () => {
  const daemon = await started("teardown")
  const pty = await daemon.spawnAgent({ id: "agent-1", cmd: ["sleep", "30"], cols: 80, rows: 24 })
  const path = daemon.paths.attach

  await daemon.stop()
  daemons.splice(daemons.indexOf(daemon), 1)

  await expect(Bun.connect({ unix: path, socket: { data() {} } })).rejects.toThrow()
  // The scope that owned the PTY is gone, so the process it was supervising is
  // gone with it rather than being orphaned. `sleep 30` would still be running
  // if the finalizer had not fired.
  const exited = await Promise.race([
    Effect.runPromise(pty.exit).then(() => "exited" as const),
    Bun.sleep(2000).then(() => "orphaned" as const),
  ])
  expect(exited).toBe("exited")
})

test("closing a daemon persists that the preserved session is detached", async () => {
  const daemon = await started("close-detached")
  const attached = await client(daemon.paths.attach, "watcher")
  await settle()

  await daemon.close()
  daemons.splice(daemons.indexOf(daemon), 1)
  attached.socket.end()

  const home = dirs[dirs.length - 1]!
  expect((await run(loadSession("close-detached"), { HOME: home, XDG_STATE_HOME: join(home, "state") }))?.attached).toBe(false)
})

test("the daemon tracks when the attached client was last seen", async () => {
  const daemon = await started("last-seen")
  const attached = await client(daemon.paths.attach, "watcher")
  await settle()

  const claimed = await daemon.handle({ command: "ping" })
  expect(claimed.ok).toBe(true)
  expect(claimed.attachedSince).toBeGreaterThan(0)
  expect(claimed.attachLastSeen).toBeGreaterThan(0)

  // Any inbound frame refreshes last-seen — a heartbeat above all, because an
  // attached UI showing an idle agent sends nothing else for hours.
  const before = (await daemon.handle({ command: "ping" })).attachLastSeen!
  attached.socket.write(encodeAttachFrame({ _tag: "ping", nonce: "keepalive" }))
  await settle(25)
  const after = (await daemon.handle({ command: "ping" })).attachLastSeen!
  expect(after).toBeGreaterThan(before)

  // Detach clears the freshness along with the attachment itself.
  attached.socket.end()
  await settle()
  const released = await daemon.handle({ command: "ping" })
  expect(released.attached).toBe(false)
  expect(released.attachedSince).toBeUndefined()
  expect(released.attachLastSeen).toBeUndefined()
})
