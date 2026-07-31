import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupStaleSessions, loadSession, saveSession, sessionPaths, writeLease } from "./session.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function env() {
  const home = await mkdtemp(join(tmpdir(), "herdr-session-"))
  dirs.push(home)
  return { HOME: home, XDG_STATE_HOME: join(home, "state") }
}

function state(id: string) {
  return { version: 1 as const, id, createdAt: 1, updatedAt: 1, attached: false, spaces: [] }
}

test("session writes are atomic and recover the previous generation", async () => {
  const e = await env()
  await saveSession(state("one"), e)
  const next = { ...state("one"), attached: true }
  await saveSession(next, e)
  expect((await loadSession("one", e))?.attached).toBe(true)
  expect(JSON.parse(await readFile(sessionPaths("one", e).backup, "utf8")).attached).toBe(false)
})

test("a truncated current file falls back to the previous generation", async () => {
  const e = await env()
  await saveSession(state("recover"), e)
  await saveSession({ ...state("recover"), attached: true }, e)
  await Bun.write(sessionPaths("recover", e).state, "{\"version\":1")
  expect((await loadSession("recover", e))?.attached).toBe(false)
})

test("stale cleanup removes dead leases but never live leases", async () => {
  const e = await env()
  await saveSession(state("dead"), e)
  await writeLease({ version: 1, session: "dead", pid: 999999, socket: "", startedAt: 1, heartbeatAt: 1 }, e)
  await saveSession(state("live"), e)
  await writeLease({ version: 1, session: "live", pid: process.pid, socket: "", startedAt: 1, heartbeatAt: 1 }, e)
  expect(await cleanupStaleSessions(e)).toEqual(["dead"])
  expect(await loadSession("dead", e)).toBeNull()
  expect(await loadSession("live", e)).not.toBeNull()
})
