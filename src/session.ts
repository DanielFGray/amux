import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { Context, Effect } from "effect"

export class SessionEnv extends Context.Reference<SessionEnv>()("SessionEnv", {
  defaultValue: () => process.env,
}) {}

export class SessionId extends Context.Tag("SessionId")<SessionId, string>() {}

/** On-disk format. Additive changes must bump neither version nor consumers. */
export const SESSION_VERSION = 1

export interface PersistedAgent {
  id: string
  name: string
  cmd: string[]
  cwd?: string
  cols: number
  rows: number
  exited: boolean
  exitCode: number | null
}

export interface PersistedWindow {
  number: number
  name: string | null
  focusedAgent: string | null
  agents: PersistedAgent[]
  /**
   * The split arrangement, as an encoded layout string (see layout.ts).
   *
   * A flat agent list cannot express arrangement, so without this a restored
   * window could only guess at one. Absent or null means "no arrangement was
   * recorded" — restore falls back to a preset rather than refusing.
   *
   * Zoom is deliberately not here: it is a transient view of a layout, not a
   * layout, the same reason exportLayout reads through it.
   */
  layout?: string | null
}

export interface PersistedSpace {
  id: string
  name: string
  dir: string
  activeWindow: number | null
  windows: PersistedWindow[]
}

export interface SessionState {
  version: typeof SESSION_VERSION
  id: string
  createdAt: number
  updatedAt: number
  attached: boolean
  spaces: PersistedSpace[]
  /** Space that was on screen, by id. Absent means "none recorded", and a
   *  restore falls back to the first space. */
  activeSpace?: string | null
}

export interface SessionLease {
  version: typeof SESSION_VERSION
  session: string
  pid: number
  socket: string
  startedAt: number
  heartbeatAt: number
  /** Earliest claim time among current attachments; absent when detached. */
  attachedSince?: number
  /** Most recent activity time among current attachments. */
  attachLastSeen?: number
  /** Per-client liveness, since one dead attachment must not hide the others. */
  attachments?: SessionAttachment[]
}

export interface SessionAttachment {
  client: string
  attachedSince: number
  attachLastSeen: number
}

export interface SessionPaths {
  root: string
  state: string
  backup: string
  lease: string
  lock: string
  socket: string
  /**
   * The attach stream socket, separate from the RPC one.
   *
   * Two sockets because they are two different things: `socket` answers a
   * request and hangs up, while `attach` is a connection whose lifetime *is*
   * the attachment — its EOF is how the daemon learns a client died. Putting
   * both on one listener would mean a one-shot status call could not be told
   * from an attachment going away.
   */
  attach: string
}

export function sessionRoot(): Effect.Effect<string, never, SessionEnv> {
  return Effect.map(SessionEnv, (env) => join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "opentui-herdr", "sessions"))
}

export function sessionPaths(id: string): Effect.Effect<SessionPaths, never, SessionEnv> {
  return Effect.map(sessionRoot(), (root) => {
    const path = join(root, id)
    return { root: path, state: join(path, "session.json"), backup: join(path, "session.json.prev"), lease: join(path, "lease.json"), lock: join(path, "daemon.lock"), socket: join(path, "daemon.sock"), attach: join(path, "attach.sock") }
  })
}

function validState(value: unknown): value is SessionState {
  return !!value && typeof value === "object" && (value as SessionState).version === SESSION_VERSION &&
    typeof (value as SessionState).id === "string" && Array.isArray((value as SessionState).spaces)
}

async function jsonFile<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T } catch { return null }
}

export function loadSession(id: string): Effect.Effect<SessionState | null, never, SessionEnv> {
  return Effect.gen(function* () {
    const paths = yield* sessionPaths(id)
    const current = yield* Effect.promise(() => jsonFile<SessionState>(paths.state))
    if (validState(current)) return current
    const backup = yield* Effect.promise(() => jsonFile<SessionState>(paths.backup))
    return validState(backup) ? backup : null
  })
}

/** Atomic replace. The previous valid generation remains available after a crash. */
export function saveSession(state: SessionState): Effect.Effect<void, unknown, SessionEnv> {
  return Effect.gen(function* () {
    if (!validState(state)) return yield* Effect.fail(new Error("invalid session state"))
    const paths = yield* sessionPaths(state.id)
    yield* Effect.promise(() => mkdir(paths.root, { recursive: true, mode: 0o700 }))
    const temp = `${paths.state}.${process.pid}.tmp`
    const bytes = JSON.stringify({ ...state, version: SESSION_VERSION, updatedAt: Date.now() }, null, 2) + "\n"
    yield* Effect.promise(() => writeFile(temp, bytes, { mode: 0o600 }))
    yield* Effect.promise(async () => { try { await rename(paths.state, paths.backup) } catch (error: any) { if (error.code !== "ENOENT") throw error } })
    yield* Effect.promise(() => rename(temp, paths.state))
  })
}

export function writeLease(lease: SessionLease): Effect.Effect<void, unknown, SessionEnv> {
  return Effect.gen(function* () {
    const paths = yield* sessionPaths(lease.session)
    yield* Effect.promise(() => mkdir(paths.root, { recursive: true, mode: 0o700 }))
    const temp = `${paths.lease}.${process.pid}.tmp`
    yield* Effect.promise(() => writeFile(temp, JSON.stringify(lease) + "\n", { mode: 0o600 }))
    yield* Effect.promise(() => rename(temp, paths.lease))
  })
}

export function readLease(id: string): Effect.Effect<SessionLease | null, never, SessionEnv> {
  return Effect.flatMap(sessionPaths(id), (paths) => Effect.promise(() => jsonFile<SessionLease>(paths.lease)))
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error: any) { return error.code === "EPERM" }
}

export function removeSession(id: string): Effect.Effect<void, unknown, SessionEnv> {
  return Effect.flatMap(sessionPaths(id), (paths) => Effect.promise(() => rm(paths.root, { recursive: true, force: true })))
}

/** Remove only sessions whose lease is absent, malformed, or owned by a dead pid. */
export function cleanupStaleSessions(): Effect.Effect<string[], unknown, SessionEnv> {
  return Effect.gen(function* () {
    const root = yield* sessionRoot()
    let entries: string[]
    try { entries = yield* Effect.promise(() => readdir(root)) } catch (error: any) { if (error.code === "ENOENT") return []; return yield* Effect.fail(error) }
    const removed: string[] = []
    for (const id of entries) {
    // A lock is the stronger startup signal than the lease: there is a small
    // window between acquiring it and publishing the first lease heartbeat.
    // Leave locked sessions for SessionDaemon.open to adjudicate.
    const paths = yield* sessionPaths(id)
    const locked = yield* Effect.tryPromise({ try: () => stat(paths.lock), catch: (error) => error }).pipe(
      Effect.map(() => true),
      Effect.catchAll((error: any) => error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error)),
    )
    if (locked) continue
    const lease = yield* readLease(id)
    if (lease && processAlive(lease.pid)) continue
    yield* removeSession(id)
    removed.push(id)
  }
    return removed
  })
}

export function sessionExists(id: string): Effect.Effect<boolean, never, SessionEnv> {
  return Effect.flatMap(sessionPaths(id), (paths) => Effect.promise(() => stat(paths.root)).pipe(Effect.as(true), Effect.catchAll(() => Effect.succeed(false))))
}
