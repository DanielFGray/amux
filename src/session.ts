import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

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
  /** Epoch ms the current attach client claimed the session; absent when detached. */
  attachedSince?: number
  /** Epoch ms the attached client was last heard from on the attach stream. */
  attachLastSeen?: number
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

export function sessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "opentui-herdr", "sessions")
}

export function sessionPaths(id: string, env: NodeJS.ProcessEnv = process.env): SessionPaths {
  const root = join(sessionRoot(env), id)
  return { root, state: join(root, "session.json"), backup: join(root, "session.json.prev"), lease: join(root, "lease.json"), lock: join(root, "daemon.lock"), socket: join(root, "daemon.sock"), attach: join(root, "attach.sock") }
}

function validState(value: unknown): value is SessionState {
  return !!value && typeof value === "object" && (value as SessionState).version === SESSION_VERSION &&
    typeof (value as SessionState).id === "string" && Array.isArray((value as SessionState).spaces)
}

async function jsonFile<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T } catch { return null }
}

export async function loadSession(id: string, env?: NodeJS.ProcessEnv): Promise<SessionState | null> {
  const paths = sessionPaths(id, env)
  const current = await jsonFile<SessionState>(paths.state)
  if (validState(current)) return current
  const backup = await jsonFile<SessionState>(paths.backup)
  if (validState(backup)) return backup
  return null
}

/** Atomic replace. The previous valid generation remains available after a crash. */
export async function saveSession(state: SessionState, env?: NodeJS.ProcessEnv): Promise<void> {
  if (!validState(state)) throw new Error("invalid session state")
  const paths = sessionPaths(state.id, env)
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  const temp = `${paths.state}.${process.pid}.tmp`
  const bytes = JSON.stringify({ ...state, version: SESSION_VERSION, updatedAt: Date.now() }, null, 2) + "\n"
  await writeFile(temp, bytes, { mode: 0o600 })
  try { await rename(paths.state, paths.backup) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  await rename(temp, paths.state)
}

export async function writeLease(lease: SessionLease, env?: NodeJS.ProcessEnv): Promise<void> {
  const paths = sessionPaths(lease.session, env)
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  const temp = `${paths.lease}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(lease) + "\n", { mode: 0o600 })
  await rename(temp, paths.lease)
}

export async function readLease(id: string, env?: NodeJS.ProcessEnv): Promise<SessionLease | null> {
  return jsonFile<SessionLease>(sessionPaths(id, env).lease)
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error: any) { return error.code === "EPERM" }
}

export async function removeSession(id: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await rm(sessionPaths(id, env).root, { recursive: true, force: true })
}

/** Remove only sessions whose lease is absent, malformed, or owned by a dead pid. */
export async function cleanupStaleSessions(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const root = sessionRoot(env)
  let entries: string[]
  try { entries = await readdir(root) } catch (error: any) { if (error.code === "ENOENT") return []; throw error }
  const removed: string[] = []
  for (const id of entries) {
    // A lock is the stronger startup signal than the lease: there is a small
    // window between acquiring it and publishing the first lease heartbeat.
    // Leave locked sessions for SessionDaemon.open to adjudicate.
    try { await stat(sessionPaths(id, env).lock); continue } catch (error: any) { if (error.code !== "ENOENT") throw error }
    const lease = await readLease(id, env)
    if (lease && processAlive(lease.pid)) continue
    await removeSession(id, env)
    removed.push(id)
  }
  return removed
}

export async function sessionExists(id: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try { await stat(sessionPaths(id, env).root); return true } catch { return false }
}
