import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { cleanupStaleSessions, loadSession, saveSession, sessionPaths, writeLease, SessionEnv } from "./session.ts"

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

const run = <A>(effect: Effect.Effect<A, unknown, SessionEnv>, env: NodeJS.ProcessEnv) => Effect.runPromise(effect.pipe(Effect.provideService(SessionEnv, env)))

test("session writes are atomic and recover the previous generation", async () => {
  const e = await env()
  await run(saveSession(state("one")), e)
  const next = { ...state("one"), attached: true }
  await run(saveSession(next), e)
  expect((await run(loadSession("one"), e))?.attached).toBe(true)
  expect(JSON.parse(await readFile((await run(sessionPaths("one"), e)).backup, "utf8")).attached).toBe(false)
})

test("a truncated current file falls back to the previous generation", async () => {
  const e = await env()
  await run(saveSession(state("recover")), e)
  await run(saveSession({ ...state("recover"), attached: true }), e)
  await Bun.write((await run(sessionPaths("recover"), e)).state, "{\"version\":1")
  expect((await run(loadSession("recover"), e))?.attached).toBe(false)
})

test("stale cleanup removes dead leases but never live leases", async () => {
  const e = await env()
  await run(saveSession(state("dead")), e)
  await run(writeLease({ version: 1, session: "dead", pid: 999999, socket: "", startedAt: 1, heartbeatAt: 1 }), e)
  await run(saveSession(state("live")), e)
  await run(writeLease({ version: 1, session: "live", pid: process.pid, socket: "", startedAt: 1, heartbeatAt: 1 }), e)
  expect(await run(cleanupStaleSessions(), e)).toEqual(["dead"])
  expect(await run(loadSession("dead"), e)).toBeNull()
  expect(await run(loadSession("live"), e)).not.toBeNull()
})
