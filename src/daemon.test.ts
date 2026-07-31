import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionDaemon } from "./daemon.ts"
import { cleanupStaleSessions, loadSession, sessionPaths, writeLease } from "./session.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function env() {
  const home = await mkdtemp(join(tmpdir(), "herdr-daemon-"))
  dirs.push(home)
  return { HOME: home, XDG_STATE_HOME: join(home, "state") }
}

test("concurrent opens reject the second owner and release on stop", async () => {
  const e = await env()
  const first = await SessionDaemon.open("race", e)
  await expect(SessionDaemon.open("race", e)).rejects.toThrow("already being opened")
  await first.start()
  await expect(SessionDaemon.open("race", e)).rejects.toThrow(/already (being opened|owned)/)
  await first.stop()
  expect(await loadSession("race", e)).toBeNull()
})

test("a dead lease and stale lock are recovered without deleting state", async () => {
  const e = await env()
  const paths = sessionPaths("restart", e)
  await Bun.write(paths.state, JSON.stringify({ version: 1, id: "restart", createdAt: 1, updatedAt: 1, attached: true, spaces: [] }))
  await writeFile(paths.lock, "999999\n")
  await writeLease({ version: 1, session: "restart", pid: 999999, socket: paths.socket, startedAt: 1, heartbeatAt: 1 }, e)
  const daemon = await SessionDaemon.open("restart", e)
  expect(daemon.state.id).toBe("restart")
  expect(daemon.state.attached).toBe(false)
  await daemon.stop()
})

test("cleanup leaves a locked startup session for its owner", async () => {
  const e = await env()
  const paths = sessionPaths("starting", e)
  await Bun.write(paths.state, JSON.stringify({ version: 1, id: "starting", createdAt: 1, updatedAt: 1, attached: false, spaces: [] }))
  await writeFile(paths.lock, `${process.pid}\n`)
  expect(await cleanupStaleSessions(e)).toEqual([])
  expect(await loadSession("starting", e)).not.toBeNull()
})

test("attachment is exclusive, survives daemon restart, and requires its owner to detach", async () => {
  const e = await env()
  const first = await SessionDaemon.open("attach", e)
  await first.start()
  expect((await first.handle({ command: "attach", client: "one" })).ok).toBe(true)
  expect((await first.handle({ command: "attach", client: "two" })).ok).toBe(false)
  expect((await first.handle({ command: "detach", client: "two" })).ok).toBe(false)

  await first.close()
  const second = await SessionDaemon.open("attach", e)
  expect(second.state.attached).toBe(false)
  await second.close()
})

test("a dead one-shot client cannot be mistaken for a detached client", async () => {
  const e = await env()
  const daemon = await SessionDaemon.open("client-death", e)
  await daemon.handle({ command: "attach", client: "process-that-died" })
  // The current HTTP RPC has no durable client connection to observe death.
  // Keeping the lease is safer than allowing a replacement to steal the PTY.
  expect((await daemon.handle({ command: "attach", client: "replacement" })).ok).toBe(false)
  await daemon.close()
})
