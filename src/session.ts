import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { Context, Data, Effect } from "effect"

export class SessionEnv extends Context.Reference<SessionEnv>()("SessionEnv", {
  defaultValue: () => process.env,
}) {}

export class SessionId extends Context.Tag("SessionId")<SessionId, string>() {}

/** On-disk format. Additive changes must bump neither version nor consumers. */
export const SESSION_VERSION = 1

/**
 * A session id becomes a single directory name under the sessions root, so it
 * must be a bounded, filename-safe, single path component: generous enough for
 * "default", UUIDs, and human names, small enough to fit any filesystem's
 * component limit with room to spare.
 */
export const MAX_SESSION_ID_LENGTH = 128

export class SessionIdError extends Data.TaggedError("SessionIdError")<{
  message: string
}> {}

/**
 * Whether `id` is safe to use as a session's directory name.
 *
 * The whole string must be a single component made of ASCII letters, digits,
 * `.`, `_`, or `-`. The special components `.` and `..` are rejected, while
 * other dot-prefixed names remain valid filename-safe ids. Path separators and
 * control characters are not in the set, so they can never reach a path. The
 * checks are explicit charcode tests rather than a regex because `/^[...]+$/`
 * matches before a trailing newline in JavaScript, and that is exactly the
 * kind of control character this function exists to reject.
 */
export function isSessionId(id: string): boolean {
  if (id.length === 0 || id.length > MAX_SESSION_ID_LENGTH || id === "." || id === "..") return false
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i)
    const safe = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 46 || c === 95
    if (!safe) return false
  }
  return true
}

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
  agents: PersistedAgent[]
  /**
   * The split arrangement, as an encoded layout string (see layout.ts).
   *
   * A flat agent list cannot express arrangement, so without this a restored
   * window could only guess at one. Absent or null means "no arrangement was
   * recorded" — restore falls back to a preset rather than refusing.
   *
   * Which pane had focus is in here too, rather than beside it. It was once a
   * `focusedAgent` field, because a layout could only name a pane by its agent
   * and so could not distinguish two panes showing one agent; panes carry their
   * own ids now (layout.ts PaneRef), so the layout says it exactly and a field
   * next to it could only ever disagree with it.
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

export function sessionPaths(id: string): Effect.Effect<SessionPaths, SessionIdError, SessionEnv> {
  return Effect.gen(function* () {
    if (!isSessionId(id)) {
      return yield* Effect.fail(new SessionIdError({ message: `invalid session id ${JSON.stringify(id)}` }))
    }
    const root = yield* sessionRoot()
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

export function loadSession(id: string): Effect.Effect<SessionState | null, SessionIdError, SessionEnv> {
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

export function readLease(id: string): Effect.Effect<SessionLease | null, SessionIdError, SessionEnv> {
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
    // Never resolve an entry that is not a valid session id: a name with a
    // separator or a dot-component would turn this readdir into a path that
    // exists somewhere else, and a tampered entry is not our session to remove.
    if (!isSessionId(id)) continue
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
  return Effect.flatMap(sessionPaths(id), (paths) => Effect.tryPromise(() => stat(paths.root)).pipe(Effect.as(true), Effect.catchAll(() => Effect.succeed(false)))).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
  )
}
