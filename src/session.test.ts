import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { cleanupStaleSessions, isSessionId, loadSession, removeSession, saveSession, sessionExists, sessionPaths, sessionRoot, writeLease, SessionEnv } from "./session.ts"

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

test("valid session ids resolve to a single path component", async () => {
  const e = await env()
  const root = await run(sessionRoot(), e)
  const ids = ["default", "e2e-boot-1", "c3f2a9b4-1d7e-4c5b-9f6a-0e8d2b7a4f11", ".hidden", "...", "..hidden", "_leading", "-leading", "a.b_c-1", "a", "x".repeat(128)]
  for (const id of ids) {
    expect(isSessionId(id)).toBe(true)
    const paths = await run(sessionPaths(id), e)
    expect(paths.root).toBe(join(root, id))
    for (const file of [paths.state, paths.backup, paths.lease, paths.lock, paths.socket, paths.attach]) {
      expect(file.startsWith(root + "/")).toBe(true)
    }
  }
})

test("invalid session ids are rejected before any path is built", async () => {
  const e = await env()
  const ids = [
    "", ".", "..",
    "../escape", "a/b", "a/b/c", "a/../b", "a\\b",
    "a\nb", "a\tb", "a\u0000b", "\u001b[0m", "a b",
    "a".repeat(129),
    "h\u00e9llo", "\u{1F600}",
  ]
  for (const id of ids) {
    expect(isSessionId(id)).toBe(false)
    await expect(run(sessionPaths(id), e)).rejects.toThrow(`invalid session id ${JSON.stringify(id)}`)
  }
})

test("no session helper touches the filesystem for a traversal id", async () => {
  const e = await env()
  await run(saveSession(state("ok")), e)
  for (const id of ["..", "../escape", "a/../../victim"]) {
    await expect(run(loadSession(id), e)).rejects.toThrow()
    await expect(run(removeSession(id), e)).rejects.toThrow()
    await expect(run(sessionExists(id), e)).resolves.toBe(false)
  }
  // The valid session is untouched.
  expect(await run(loadSession("ok"), e)).not.toBeNull()
})

test("traversal ids cannot read or delete files outside the sessions root", async () => {
  const e = await env()
  const victim = join(e.HOME!, "victim.json")
  await Bun.write(victim, "secret")
  await expect(run(saveSession({ ...state("../..") }), e)).rejects.toThrow()
  await expect(run(removeSession(".."), e)).rejects.toThrow()
  await expect(run(removeSession("../.."), e)).rejects.toThrow()
  expect(await Bun.file(victim).exists()).toBe(true)
  expect(await Bun.file(victim).text()).toBe("secret")
})

test("cleanup ignores entries that are not valid session ids", async () => {
  const e = await env()
  const root = await run(sessionRoot(), e)
  await mkdir(join(root, "dead"), { recursive: true })
  await mkdir(join(root, "weird name"), { recursive: true })
  expect(await run(cleanupStaleSessions(), e)).toEqual(["dead"])
  expect(await run(sessionExists("dead"), e)).toBe(false)
  await expect(stat(join(root, "weird name"))).resolves.toBeDefined()
})
