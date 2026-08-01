import { mkdir, open, readFile, rm, unlink } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { randomUUID } from "node:crypto"
import { Effect, ManagedRuntime } from "effect"
import { AttachHost, layerAttachHost, type AttachHostService } from "./effect/AttachHost.ts"
import type { AttachServerError } from "./effect/AttachServer.ts"
import type { ManagedPty, PtySpec } from "./effect/PtyRegistry.ts"
import {
  loadSession, processAlive, readLease, removeSession, saveSession,
  sessionPaths, writeLease, type SessionAttachment, type SessionLease, type SessionState,
} from "./session.ts"

export type DaemonCommand =
  | "ping" | "status" | "stop" | "spawn" | "kill" | "save"

/**
 * A request to start an agent, in the shape the wire can carry.
 *
 * The same fields as PtySpec, except that the caller chooses the id: the layout
 * the client is about to persist is written in terms of agent ids, so an id the
 * daemon invented would have to be round-tripped back before anything could
 * refer to it.
 */
export interface DaemonSpawn { id: string; cmd: string[]; cwd?: string; cols: number; rows: number }

export interface DaemonRequest {
  command: DaemonCommand
  client?: string
  /** The agent to start, for `spawn`. */
  spawn?: DaemonSpawn
  /** The agent to stop, for `kill`. */
  agent?: string
  /**
   * The workspace to record, for `save`.
   *
   * The client knows the shape of the workspace and the daemon owns the file,
   * so the client sends what it sees and never writes session.json itself.
   * That is what keeps a single writer while the daemon is also updating
   * attachment state underneath it.
   */
  workspace?: Pick<SessionState, "spaces"> & { activeSpace?: string | null }
}

export interface DaemonResponse {
  ok: boolean
  error?: string
  session?: SessionState
  attached?: boolean
  /** Earliest start among current attachments; absent when detached. */
  attachedSince?: number
  /** Most recent activity among current attachments. */
  attachLastSeen?: number
  /** Agents with a live process right now. Not the same as the agents in
   *  `session`, which include ones that have already exited. */
  agents?: string[]
}

/**
 * A single owner for one session's lifecycle, persistence, and PTYs.
 *
 * There are two sockets and they do different jobs. The RPC socket answers
 * questions about the session and hangs up. The attach socket *is* an
 * attachment: a client holds it open, PTY bytes flow both ways over it, and its
 * EOF is how the daemon learns the client died — which request/response RPC
 * structurally could not tell it.
 *
 * The PTYs live in an Effect scope owned by this object (see AttachHost), not
 * by any client and not by the UI process. That is what makes closing the
 * terminal a detach rather than a kill.
 */
export class SessionDaemon {
  readonly id: string
  readonly paths: ReturnType<typeof sessionPaths>
  #state: SessionState
  #server: ReturnType<typeof Bun.serve> | null = null
  #heartbeat: Timer | null = null
  /** Attachments are keyed by transport connection so each socket has its own liveness. */
  #attachments = new Map<string, SessionAttachment>()
  #save: Promise<void> = Promise.resolve()
  #lockPath: string
  #env: NodeJS.ProcessEnv
  #runtime: ManagedRuntime.ManagedRuntime<AttachHost, AttachServerError> | null = null
  #host: AttachHostService | null = null

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

  /**
   * Record the workspace the client is showing.
   *
   * The daemon owns the file, so the UI hands it a snapshot (see snapshot.ts)
   * rather than writing session.json behind its back — which is what makes the
   * write atomic and single-writer even while a client is attaching. What is
   * stored is metadata only; it is not, and does not pretend to be, the
   * terminals' contents.
   */
  async saveWorkspace(workspace: Pick<SessionState, "spaces"> & { activeSpace?: string | null }): Promise<void> {
    this.#state.spaces = structuredClone(workspace.spaces)
    this.#state.activeSpace = workspace.activeSpace ?? null
    await this.#persist()
  }

  async start(): Promise<void> {
    if (this.#server) return
    const lease: SessionLease = { version: 1, session: this.id, pid: process.pid, socket: this.paths.socket, startedAt: Date.now(), heartbeatAt: Date.now() }
    try {
      await this.#persist()
      await writeLease(lease, this.#env)
      await this.#startAttachHost()
      try { await unlink(this.paths.socket) } catch (error: any) { if (error.code !== "ENOENT") throw error }
      this.#server = Bun.serve({ unix: this.paths.socket, fetch: async (request) => this.#fetch(request) })
      this.#heartbeat = setInterval(() => void writeLease({
        ...lease,
        heartbeatAt: Date.now(),
        ...this.#attachInfo(),
      }, this.#env), 1000)
      this.#heartbeat.unref?.()
    } catch (error) {
      await this.#disposeHost()
      await this.#releaseLock()
      throw error
    }
  }

  /**
   * Bring up the PTY/attach plane before the RPC socket exists.
   *
   * Order matters: once /rpc answers, a client is entitled to believe the
   * session is usable, and a session whose attach socket is not listening yet
   * is not. Building the runtime here also means a socket that cannot be bound
   * fails `start` — the caller then releases the lock rather than leaving a
   * half-live daemon holding it.
   */
  async #startAttachHost(): Promise<void> {
    try { await unlink(this.paths.attach) } catch (error: any) { if (error.code !== "ENOENT") throw error }
    const runtime = ManagedRuntime.make(layerAttachHost({
      path: this.paths.attach,
      // The stream is the authority on attachment; the daemon records every
      // accepted connection rather than imposing an exclusive owner.
      onAttach: (client, connection) => Effect.suspend(() =>
        this.#claim(client, connection)
          ? Effect.promise(() => this.#persist())
          : Effect.fail(new Error("attachment is already registered")),
      ),
      onDetach: (client, connection) => Effect.suspend(() => {
        this.#release(client, connection)
        return Effect.promise(() => this.#persist())
      }),
       onActivity: (client, connection) => Effect.sync(() => this.#touch(client, connection)),
    }))
    this.#runtime = runtime
    this.#host = await runtime.runPromise(AttachHost)
  }

  /** Register one transport connection as an independent attachment. */
  #claim(client: string, connection: string): boolean {
    if (this.#attachments.has(connection)) return false
    const now = Date.now()
    this.#attachments.set(connection, { client, attachedSince: now, attachLastSeen: now })
    this.#state.attached = true
    return true
  }

  /** Release only this connection; other clients remain attached. */
  #release(client: string, connection: string): boolean {
    const attachment = this.#attachments.get(connection)
    if (!attachment || attachment.client !== client) return false
    this.#attachments.delete(connection)
    this.#state.attached = this.#attachments.size > 0
    return true
  }

  /** Refresh only this connection's liveness. */
  #touch(client: string, connection: string): void {
    const attachment = this.#attachments.get(connection)
    if (attachment?.client === client) attachment.attachLastSeen = Date.now()
  }

  /** Aggregate status plus per-client detail for the lease heartbeat. */
  #attachInfo(): Pick<SessionLease, "attachedSince" | "attachLastSeen" | "attachments"> {
    const attachments = [...this.#attachments.values()]
    return {
      ...(attachments.length ? {
        attachedSince: Math.min(...attachments.map(({ attachedSince }) => attachedSince)),
        attachLastSeen: Math.max(...attachments.map(({ attachLastSeen }) => attachLastSeen)),
        attachments: attachments.map((attachment) => ({ ...attachment })),
      } : {}),
    }
  }

  /** Start an agent the daemon owns. It outlives every client by construction:
   *  see the note on AttachHost.spawn. */
  spawnAgent(spec: PtySpec): Promise<ManagedPty> {
    if (!this.#host || !this.#runtime) return Promise.reject(new Error("daemon is not started"))
    return this.#runtime.runPromise(this.#host.spawn(spec))
  }

  /** Stop an agent. Clients learn about it from the exit frame, exactly as they
   *  would for a process that ended on its own. */
  killAgent(id: string): Promise<void> {
    if (!this.#host || !this.#runtime) return Promise.reject(new Error("daemon is not started"))
    return this.#runtime.runPromise(this.#host.kill(id))
  }

  /** Agent ids with a live process behind them. */
  liveAgents(): Promise<readonly string[]> {
    if (!this.#host || !this.#runtime) return Promise.resolve([])
    return this.#runtime.runPromise(this.#host.live)
  }

  /** Every client currently attached, in the order they arrived. */
  get attachedClients(): string[] { return [...this.#attachments.values()].map((a) => a.client) }

  /**
   * The earliest-arrived attachment, or null when nothing is attached.
   *
   * Only meaningful when at most one client is attached, which is the common
   * case and what the single-client status paths want. With several attached
   * this is arrival order, not ownership — there is no owner any more. Use
   * `attachedClients` when more than one may be present.
   */
  get attachedClient(): string | null { return this.#attachments.values().next().value?.client ?? null }

  async #fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") return new Response("not found", { status: 404 })
    try {
      const body = await request.json() as DaemonRequest
      return Response.json(await this.handle(body))
    } catch (error) { return Response.json({ ok: false, error: String(error) }, { status: 400 }) }
  }

  async handle(request: DaemonRequest): Promise<DaemonResponse> {
    switch (request.command) {
      case "ping": return { ok: true, attached: this.#state.attached, ...this.#attachInfo() }
      case "status": return { ok: true, session: this.state, attached: this.#state.attached, ...this.#attachInfo(), agents: [...(await this.liveAgents())] }
      // Spawn and kill are control, not data: they change what agents exist,
      // which is a fact about the session rather than a byte in a stream. Bytes
      // go over the attach socket; the shape of the session goes over RPC,
      // where a failure has somewhere to be reported.
      case "spawn": {
        if (!request.spawn) return { ok: false, error: "spawn requires an agent spec" }
        try {
          await this.spawnAgent(request.spawn)
          return { ok: true, agents: [...(await this.liveAgents())] }
        } catch (error) { return { ok: false, error: String(error) } }
      }
      case "kill": {
        if (!request.agent) return { ok: false, error: "kill requires an agent id" }
        try {
          await this.killAgent(request.agent)
          return { ok: true, agents: [...(await this.liveAgents())] }
        } catch (error) { return { ok: false, error: String(error) } }
      }
      case "save": {
        if (!request.workspace) return { ok: false, error: "save requires a workspace" }
        try {
          await this.saveWorkspace(request.workspace)
          return { ok: true }
        } catch (error) { return { ok: false, error: String(error) } }
      }
      case "stop": await this.stop(); return { ok: true }
      default: return { ok: false, error: "unknown command" }
    }
  }

  async stop(): Promise<void> {
    this.#heartbeat && clearInterval(this.#heartbeat)
    this.#heartbeat = null
    this.#server?.stop()
    this.#server = null
    await this.#disposeHost()
    await removeSession(this.id, this.#env)
    await this.#releaseLock()
  }

  /** Release the daemon process while preserving metadata for a restart. */
  async close(): Promise<void> {
    this.#heartbeat && clearInterval(this.#heartbeat)
    this.#heartbeat = null
    this.#server?.stop()
    this.#server = null
    await this.#disposeHost()
    // `close` preserves the session for restart, so publish the detached
    // marker after the attach scope has been torn down rather than leaving a
    // stale attachment for metadata-only readers.
    let persistError: unknown
    try {
      await this.#persist()
    } catch (error) {
      persistError = error
    } finally {
      await unlink(this.paths.socket).catch(() => {})
      await rm(this.paths.lease, { force: true }).catch(() => {})
      await this.#releaseLock()
    }
    if (persistError) throw persistError
  }

  /**
   * Tear down the PTY plane.
   *
   * Disposing the runtime closes the host scope, which runs PtyRegistry's
   * finalizers: every agent is killed and every master fd closed. There is no
   * kinder option — the PTYs are children of this process, so a daemon that
   * exits without this leaves them orphaned rather than saved.
   */
  async #disposeHost(): Promise<void> {
    const runtime = this.#runtime
    this.#runtime = null
    this.#host = null
    this.#attachments.clear()
    this.#state.attached = false
    await runtime?.dispose().catch(() => {})
    await unlink(this.paths.attach).catch(() => {})
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
export function daemonRequest(id: string, body: DaemonRequest, env?: NodeJS.ProcessEnv): Promise<DaemonResponse> {
  const socketPath = sessionPaths(id, env).socket
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

/**
 * Open and start a daemon, and hand it back still running.
 *
 * No signal handling here: the caller owns the lifetime and is the one that
 * knows how it wants to be torn down. daemon-main.ts holds it in a scope, so
 * SIGTERM and SIGINT release it through the same path as any other exit rather
 * than through two handlers that could only race `stop()` against `exit()`.
 */
export async function startDaemon(id = process.argv[2] || randomUUID()): Promise<SessionDaemon> {
  const daemon = await SessionDaemon.open(id)
  await daemon.start()
  return daemon
}
