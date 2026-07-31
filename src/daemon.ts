import { mkdir, open, readFile, rm, unlink } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { randomUUID } from "node:crypto"
import {
  loadSession, processAlive, readLease, removeSession, saveSession,
  sessionPaths, writeLease, type SessionLease, type SessionState,
} from "./session.ts"

export type DaemonCommand = "ping" | "attach" | "detach" | "status" | "stop"
export interface DaemonRequest { command: DaemonCommand; client?: string }
export interface DaemonResponse { ok: boolean; error?: string; session?: SessionState; attached?: boolean }

/** A single owner for one session's lifecycle and persistence. PTY ownership is
 * deliberately represented by the callbacks: the UI can provide its existing
 * Agent bridge without making the storage format depend on ghostty internals. */
export class SessionDaemon {
  readonly id: string
  readonly paths: ReturnType<typeof sessionPaths>
  #state: SessionState
  #server: ReturnType<typeof Bun.serve> | null = null
  #heartbeat: Timer | null = null
  #attachedClient: string | null = null
  #save: Promise<void> = Promise.resolve()
  #lockPath: string
  #env: NodeJS.ProcessEnv

  private constructor(id: string, state: SessionState, env: NodeJS.ProcessEnv) {
    this.id = id
    this.paths = sessionPaths(id, env)
    this.#lockPath = this.paths.lock
    this.#env = env
    this.#state = state
  }

  static async open(id = "default", env: NodeJS.ProcessEnv = process.env): Promise<SessionDaemon> {
    const paths = sessionPaths(id, env)
    await mkdir(paths.root, { recursive: true, mode: 0o700 })
    const lock = await SessionDaemon.acquireLock(id, paths.lock, env)
    try {
      const existing = await readLease(id, env)
      if (existing && processAlive(existing.pid)) throw new Error(`session '${id}' is already owned by pid ${existing.pid}`)
      const state = await loadSession(id, env) ?? { version: 1, id, createdAt: Date.now(), updatedAt: Date.now(), attached: false, spaces: [] }
      state.attached = false
      const daemon = new SessionDaemon(id, state, env)
      daemon.#lock = lock
      return daemon
    } catch (error) {
      await lock.close()
      await rm(paths.lock, { force: true }).catch(() => {})
      throw error
    }
  }

  #lock: Awaited<ReturnType<typeof open>> | null = null

  static async acquireLock(id: string, path: string, env: NodeJS.ProcessEnv) {
    for (;;) {
      try {
        const lock = await open(path, "wx", 0o600)
        await lock.writeFile(`${process.pid}\n`)
        return lock
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error
        try {
          const owner = Number.parseInt(await readFile(path, "utf8"), 10)
          if (processAlive(owner)) throw new Error(`session '${id}' is already being opened`)
        } catch (readError: any) {
          if (readError.message?.includes("already being opened")) throw readError
          // A directory or malformed file is a stale marker; lease validation
          // below still protects a running daemon from being removed.
        }
        const lease = await readLease(id, env)
        if (lease && processAlive(lease.pid)) throw new Error(`session '${id}' is already owned by pid ${lease.pid}`)
        // Recover a lock left by a dead daemon, including the old directory
        // marker written by the previous metadata-only implementation.
        await rm(path, { recursive: true, force: true })
      }
    }
  }

  get state(): SessionState { return structuredClone(this.#state) }

  async start(): Promise<void> {
    if (this.#server) return
    const lease: SessionLease = { version: 1, session: this.id, pid: process.pid, socket: this.paths.socket, startedAt: Date.now(), heartbeatAt: Date.now() }
    try {
      await this.#persist()
      await writeLease(lease, this.#env)
      try { await unlink(this.paths.socket) } catch (error: any) { if (error.code !== "ENOENT") throw error }
      this.#server = Bun.serve({ unix: this.paths.socket, fetch: async (request) => this.#fetch(request) })
      this.#heartbeat = setInterval(() => void writeLease({ ...lease, heartbeatAt: Date.now() }), 1000)
      this.#heartbeat.unref?.()
    } catch (error) {
      await this.#releaseLock()
      throw error
    }
  }

  async #fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") return new Response("not found", { status: 404 })
    try {
      const body = await request.json() as DaemonRequest
      return Response.json(await this.handle(body))
    } catch (error) { return Response.json({ ok: false, error: String(error) }, { status: 400 }) }
  }

  async handle(request: DaemonRequest): Promise<DaemonResponse> {
    switch (request.command) {
      case "ping": return { ok: true, attached: this.#state.attached }
      case "status": return { ok: true, session: this.state, attached: this.#state.attached }
      case "attach":
        if (!request.client) return { ok: false, error: "attach requires a client id" }
        if (this.#attachedClient && this.#attachedClient !== request.client) return { ok: false, error: "session is already attached" }
        this.#attachedClient = request.client
        this.#state.attached = true
        await this.#persist()
        return { ok: true, attached: true }
      case "detach":
        if (!request.client || this.#attachedClient !== request.client) return { ok: false, error: "client does not own the attachment" }
        this.#attachedClient = null
        this.#state.attached = false
        await this.#persist()
        return { ok: true, attached: false }
      case "stop": await this.stop(); return { ok: true }
      default: return { ok: false, error: "unknown command" }
    }
  }

  async stop(): Promise<void> {
    this.#heartbeat && clearInterval(this.#heartbeat)
    this.#heartbeat = null
    this.#server?.stop()
    this.#server = null
    await removeSession(this.id, this.#env)
    await this.#releaseLock()
  }

  /** Release the daemon process while preserving metadata for a restart. */
  async close(): Promise<void> {
    this.#heartbeat && clearInterval(this.#heartbeat)
    this.#heartbeat = null
    this.#server?.stop()
    this.#server = null
    await unlink(this.paths.socket).catch(() => {})
    await rm(this.paths.lease, { force: true }).catch(() => {})
    await this.#releaseLock()
  }

  async #releaseLock() {
    await this.#lock?.close().catch(() => {})
    this.#lock = null
    await rm(this.#lockPath, { force: true }).catch(() => {})
  }

  #persist(): Promise<void> {
    const next = this.#save.then(() => saveSession(this.#state, this.#env))
    this.#save = next.catch(() => {})
    return next
  }
}

/** Client used by CLI commands and tests; HTTP keeps framing and errors explicit. */
export function daemonRequest(id: string, body: DaemonRequest): Promise<DaemonResponse> {
  const socketPath = sessionPaths(id).socket
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path: "/rpc", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      let text = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => text += chunk)
      response.on("end", () => { try { resolve(JSON.parse(text)) } catch (error) { reject(error) } })
    })
    request.on("error", reject)
    request.end(JSON.stringify(body))
  })
}

export async function startDaemon(id = process.argv[2] || randomUUID()): Promise<void> {
  const daemon = await SessionDaemon.open(id)
  await daemon.start()
  process.once("SIGTERM", () => void daemon.stop().finally(() => process.exit(143)))
  process.once("SIGINT", () => void daemon.stop().finally(() => process.exit(130)))
}
