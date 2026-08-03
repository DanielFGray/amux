import { mkdir, open, readFile, rm, unlink } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { randomUUID } from "node:crypto"
import { Cause, Clock, Data, Effect, Exit, Fiber, ManagedRuntime, Schedule, Scope } from "effect"
import { AttachHost, layerAttachHost, type AttachHostService } from "./effect/AttachHost.ts"
import type { PreparedSession } from "./effect/SessionSupervisor.ts"
import { MAX_RPC_BYTES } from "./limits.ts"
import type { AttachServerError } from "./effect/AttachServer.ts"
import type { BufferEntry } from "./effect/BufferStore.ts"
import type { ManagedSession, SessionSpec } from "./effect/SessionRegistry.ts"
import {
  isSessionId, loadSession, processAlive, readLease, removeSession, saveSession, SessionEnv,
  sessionPaths, writeLease, type SessionAttachment, type SessionLease, type SessionState, type SessionPaths,
} from "./session.ts"
import { command, decodeCommand, type Command } from "./commands.ts"
import {
  applyWorkspaceCommand,
  isWorkspaceCommand,
  markAgentExited,
  parseWorkspaceCommandContext,
  workspaceFromSession,
  workspaceSession,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
} from "./workspace.ts"

export type DaemonCommand =
  | "ping" | "status" | "stop" | "workspace-command"
  | "set-buffer" | "paste-buffer" | "list-buffers" | "delete-buffer" | "show-buffer"

export class SessionDaemonError extends Data.TaggedError("SessionDaemonError")<{
  message: string
}> {}

/** A failure's message, without the Effect error tag the tagged errors also
 *  carry (String() of one prints "BufferError: no buffers"). */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export interface DaemonRequest {
  command: DaemonCommand
  /** Existing command value executed against the daemon-owned workspace. */
  workspaceCommand?: unknown
  /** Commands from an obsolete generation are rejected, never rebased silently. */
  expectedRevision?: number
  workspaceContext?: unknown
  /**
   * The buffer a buffer verb acts on, for set-buffer/paste-buffer/
   * delete-buffer/show-buffer. Absent means "the top of the stack" except for
   * set-buffer, where it means "a new numbered buffer".
   */
  bufferName?: string
  /** The data to store, for set-buffer. */
  bufferData?: string
  /** The session to write into, for paste-buffer (the focused pane's agent). */
  bufferTarget?: string
  /** paste-buffer -d: drop the buffer after pasting it. */
  bufferDelete?: boolean
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
  /** list-buffers: the paste buffer stack, top first. */
  buffers?: readonly BufferEntry[]
  /** set-buffer: the name the data landed in. */
  bufferName?: string
  /** show-buffer: the buffer's contents, decoded as text. */
  bufferData?: string
  workspace?: WorkspaceSnapshot
}

export interface SessionDaemonOptions {
  /** Persistence seam used by fault-injection tests; production uses saveSession. */
  readonly saveState?: (state: SessionState) => Effect.Effect<void, unknown>
}

const SHUTDOWN_SAVE_TIMEOUT_MS = 500

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
  readonly paths: SessionPaths
  #state: SessionState
  #workspace: WorkspaceSnapshot
  #server: ReturnType<typeof Bun.serve> | null = null
  #heartbeat: Fiber.RuntimeFiber<unknown, never> | null = null
  #heartbeatError: string | null = null
  /** Attachments are keyed by transport connection so each socket has its own liveness. */
  #attachments = new Map<string, SessionAttachment>()
  #lockPath: string
  #env: NodeJS.ProcessEnv
  #runtime: ManagedRuntime.ManagedRuntime<AttachHost, AttachServerError> | null = null
  #host: AttachHostService | null = null
  #mutations: Promise<void> = Promise.resolve()
  #closing = false
  #shutdown: Promise<void>
  #resolveShutdown!: () => void
  #exitCommits = new Map<string, (code: number | null) => Promise<void>>()
  #durableObligations = new Map<symbol, string>()
  #writeState: (state: SessionState) => Effect.Effect<void, unknown>
  #activeSave: Fiber.RuntimeFiber<void, unknown> | null = null
  #cancelPersistence = false
  #scope: Scope.CloseableScope
  #termination: Promise<void> | null = null
  readonly stopped: Promise<void>
  #resolveStopped!: () => void

  private constructor(id: string, state: SessionState, env: NodeJS.ProcessEnv, paths: SessionPaths, options: SessionDaemonOptions) {
    this.id = id
    this.paths = paths
    this.#lockPath = this.paths.lock
    this.#env = env
    this.#state = state
    this.#workspace = workspaceFromSession(state)
    this.#writeState = options.saveState ?? ((next) => saveSession(next).pipe(Effect.provideService(SessionEnv, env)))
    this.#scope = Effect.runSync(Scope.make())
    this.stopped = new Promise((resolve) => { this.#resolveStopped = resolve })
    this.#shutdown = new Promise((resolve) => { this.#resolveShutdown = resolve })
  }

  static open(id = "default", options: SessionDaemonOptions = {}): Effect.Effect<SessionDaemon, unknown, SessionEnv> {
    return Effect.gen(function* () {
      if (!isSessionId(id)) {
        return yield* Effect.fail(new SessionDaemonError({ message: `invalid session id ${JSON.stringify(id)}` }))
      }
      const env = yield* SessionEnv
      const paths = yield* sessionPaths(id)
      yield* Effect.promise(() => mkdir(paths.root, { recursive: true, mode: 0o700 }))
      const lock = yield* Effect.promise(() => SessionDaemon.acquireLock(id, paths.lock, env))
      try {
        const existing = yield* readLease(id)
        if (existing && processAlive(existing.pid)) return yield* Effect.fail(new Error(`session '${id}' is already owned by pid ${existing.pid}`))
        const state = (yield* loadSession(id)) ?? { version: 1, id, createdAt: Date.now(), updatedAt: Date.now(), attached: false, spaces: [] }
        state.attached = false
        const daemon = new SessionDaemon(id, state, env, paths, options)
        daemon.#lock = lock
        return daemon
      } catch (error) {
        yield* Effect.promise(() => lock.close())
        yield* Effect.promise(() => rm(paths.lock, { force: true }).catch(() => {}))
        return yield* Effect.fail(error)
      }
    })
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
        const lease = await Effect.runPromise(readLease(id).pipe(Effect.provideService(SessionEnv, env)))
        if (lease && processAlive(lease.pid)) throw new Error(`session '${id}' is already owned by pid ${lease.pid}`)
        // Recover a lock left by a dead daemon, including the old directory
        // marker written by the previous metadata-only implementation.
        await rm(path, { recursive: true, force: true })
      }
    }
  }

  get state(): SessionState { return structuredClone(this.#state) }
  get workspace(): WorkspaceSnapshot { return structuredClone(this.#workspace) }

  async start(): Promise<void> {
    if (this.#server) return
    const lease: SessionLease = { version: 1, session: this.id, pid: process.pid, socket: this.paths.socket, startedAt: Date.now(), heartbeatAt: Date.now() }
    try {
      await this.#enqueueModelChange(() => this.#persistState(this.#state))
      await Effect.runPromise(writeLease(lease).pipe(Effect.provideService(SessionEnv, this.#env)))
      await this.#startAttachHost()
      await this.#enqueueModelChange(() => this.#restoreWorkspaceSessions())
      if (this.#workspace.spaces.length === 0) {
        await this.runWorkspaceCommand(command("space.new"), this.#workspace.revision, {
          size: { cols: 80, rows: 24 },
          shell: [this.#env.SHELL || "bash"],
          cwd: process.cwd(),
        })
      }
      try { await unlink(this.paths.socket) } catch (error: any) { if (error.code !== "ENOENT") throw error }
      this.#server = Bun.serve({ unix: this.paths.socket, fetch: async (request) => this.#fetch(request) })
      const heartbeat = Effect.sleep("1 second").pipe(
        Effect.andThen(Effect.repeat(this.#heartbeatBeat(lease), Schedule.fixed("1 second"))),
      )
      this.#heartbeat = await this.#fork(heartbeat)
    } catch (error) {
      await this.#disposeHost()
      await this.#releaseLock()
      await Effect.runPromise(Scope.close(this.#scope, Exit.void))
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
        Effect.promise(() => this.#attach(client, connection)),
      ),
      onDetach: (client, connection) => Effect.suspend(() =>
        Effect.promise(() => this.#detach(client, connection)),
      ),
       onActivity: (client, connection) => Effect.sync(() => this.#touch(client, connection)),
       onSessionExit: (session, code) => Effect.tryPromise({
         try: () => this.#beforeSessionExit(session, code),
         catch: (error) => error,
       }),
    }))
    this.#runtime = runtime
    this.#host = await runtime.runPromise(AttachHost)
  }

  /** Attachment metadata is a model mutation and shares its serialization. */
  #attach(client: string, connection: string): Promise<void> {
    return this.#enqueueModelChange(async () => {
      if (this.#attachments.has(connection)) throw new Error("attachment is already registered")
      const now = Date.now()
      const attachments = new Map(this.#attachments)
      attachments.set(connection, { client, attachedSince: now, attachLastSeen: now })
      const state = { ...this.#state, attached: true, updatedAt: now }
      await this.#persistState(state)
      this.#attachments = attachments
      this.#state = state
    })
  }

  /** Release only this connection; other clients remain attached. */
  #detach(client: string, connection: string): Promise<void> {
    return this.#enqueueModelChange(async () => {
      const attachment = this.#attachments.get(connection)
      if (!attachment || attachment.client !== client) return
      const attachments = new Map(this.#attachments)
      attachments.delete(connection)
      const state = { ...this.#state, attached: attachments.size > 0, updatedAt: Date.now() }
      await this.#persistUntilSuccess(state, "attachment detach")
      this.#attachments = attachments
      this.#state = state
    })
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

  /** Lease metadata is a view of the model, so it takes its snapshot only when
   * its turn in the model queue begins. The scheduled effect awaits this whole
   * operation, which keeps fixed cadence without overlapping lease writes. */
  #heartbeatBeat(lease: SessionLease): Effect.Effect<void, never> {
    return Effect.promise(() => this.#enqueueModelChange(() => {
      if (this.#closing) return
      return this.#run(Effect.gen(this, function* () {
        const heartbeatAt = yield* Clock.currentTimeMillis
        yield* writeLease({ ...lease, heartbeatAt, ...this.#attachInfo() }).pipe(
          Effect.provideService(SessionEnv, this.#env),
        )
        this.#heartbeatError = null
      }))
    })).pipe(
      Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
        ? Effect.interrupt
        : Effect.sync(() => {
          this.#heartbeatError = `lease heartbeat failed: ${Cause.pretty(cause)}`
        })),
    )
  }

  /** Start an agent the daemon owns. It outlives every client by construction:
   *  see the note on AttachHost.spawn. */
  spawnAgent(spec: SessionSpec): Promise<ManagedSession> {
    if (!this.#host || !this.#runtime) return Promise.reject(new Error("daemon is not started"))
    return this.#runtime.runPromise(this.#host.spawn(spec))
  }

  async #spawnWorkspaceAgent(spec: SessionSpec): Promise<ManagedSession> {
    return this.spawnAgent(spec)
  }

  async #prepareWorkspaceAgent(spec: SessionSpec): Promise<PreparedSession> {
    if (!this.#host || !this.#runtime) throw new Error("daemon is not started")
    return this.#runtime.runPromise(this.#host.prepare(spec))
  }

  async #restoreWorkspaceSessions(): Promise<void> {
    let next = this.#workspace
    let changed = false
    for (const space of next.spaces) {
      for (const window of space.windows) {
        for (const agent of window.agents) {
          if (agent.exited) continue
          try {
            await this.#spawnWorkspaceAgent(agent)
          } catch {
            next = markAgentExited(next, agent.id, null)
            changed = true
          }
        }
      }
    }
    const state = workspaceSession(next, this.#state)
    if (changed) await this.#persistState(state)
    this.#workspace = next
    this.#state = state
  }

  /** One serialized authority decides command order and the next revision. */
  runWorkspaceCommand(
    value: Command,
    expectedRevision: number,
    context: WorkspaceCommandContext,
  ): Promise<WorkspaceSnapshot> {
    return this.#enqueueModelChange(async () => {
      if (expectedRevision !== this.#workspace.revision) {
        throw new Error(`stale workspace revision ${expectedRevision}; current revision is ${this.#workspace.revision}`)
      }
      if (!isWorkspaceCommand(value)) throw new Error(`command '${value._tag}' is not a workspace command`)
      const mutation = applyWorkspaceCommand(this.#workspace, value, context)
      const candidateState = workspaceSession(mutation.snapshot, this.#state)
      const prepared: PreparedSession[] = []
      let settleExits!: (committed: boolean) => void
      const exitsSettled = new Promise<boolean>((resolve) => { settleExits = resolve })
      const killed = mutation.actions.filter((action) => action._tag === "kill").map((action) => action.agent)
      try {
        // Prepared PTYs are private acquisitions. Fast exits stop at their
        // activation gate and abort terminates them without entering this queue.
        for (const action of mutation.actions) {
          if (action._tag !== "spawn") continue
          prepared.push(await this.#prepareWorkspaceAgent(action.agent))
        }
        // Destructive exits are externally gated. killAgent waits for process
        // completion only, never for the callback waiting on this transaction.
        for (const id of killed) this.#exitCommits.set(id, async (code) => {
          if (!await exitsSettled) await this.#beforeSessionExit(id, code)
        })
        for (const action of mutation.actions) {
          if (action._tag !== "kill") continue
          await this.killAgent(action.agent)
        }
        for (const action of mutation.actions) {
          if (action._tag === "input" && this.#host && this.#runtime) {
            await this.#runtime.runPromise(this.#host.write(action.agent, action.data))
          }
        }
        if (mutation.changed) {
          // A spawn-only candidate is reversible and may reject on write
          // failure. Once a process has been destroyed, fail-stop retry is the
          // only coherent option: neither disk nor process state may roll back.
          if (killed.length > 0) await this.#persistUntilSuccess(candidateState, "destructive workspace command")
          else await this.#persistState(candidateState)
          this.#workspace = mutation.snapshot
          this.#state = candidateState
          await this.#publishWorkspace()
        }
        settleExits(true)
        for (const session of prepared) await this.#runtime!.runPromise(session.activate)
        return this.workspace
      } catch (error) {
        settleExits(false)
        for (const session of prepared) await this.#runtime?.runPromise(session.abort).catch(() => {})
        throw error
      } finally {
        for (const id of killed) this.#exitCommits.delete(id)
      }
    })
  }

  #enqueueModelChange<A>(change: () => A | Promise<A>): Promise<A> {
    const result = this.#mutations.then(change, change)
    this.#mutations = result.then(() => {}, () => {})
    return result
  }

  async #beforeSessionExit(id: string, code: number | null): Promise<void> {
    if (this.#closing) return Promise.resolve()
    const commit = this.#exitCommits.get(id)
    if (commit) {
      this.#exitCommits.delete(id)
      return commit(code)
    }
    await this.#enqueueModelChange(() => this.#recordAgentExit(id, code))
  }

  async #recordAgentExit(id: string, code: number | null): Promise<void> {
    // Host disposal ends every local PTY, but close() means "restart this
    // session", not "all of its modeled agents exited". A later daemon respawns
    // those persisted live agents.
    if (this.#closing) return
    const next = markAgentExited(this.#workspace, id, code)
    if (next === this.#workspace) return
    const state = workspaceSession(next, this.#state)
    await this.#persistUntilSuccess(state, `natural exit for '${id}'`)
    this.#workspace = next
    this.#state = state
    await this.#publishWorkspace()
  }

  async #publishWorkspace(): Promise<void> {
    if (!this.#host || !this.#runtime) return
    await this.#runtime.runPromise(this.#host.publish({
      _tag: "workspace",
      revision: this.#workspace.revision,
      state: JSON.stringify(this.#workspace),
    }))
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

  /**
   * The paste buffer stack's verbs, tmux's set-buffer family.
   *
   * The stack is server state, living beside the PTYs in the attach host, so a
   * copy and a paste both work with no client attached at all — the daemon
   * writes the bytes into its own PTY. These are thin doors into the host;
   * see the buffer verbs in handle() for the wire shape.
   */
  setBuffer(name: string | undefined, data: string): Promise<string> {
    if (!this.#host || !this.#runtime) return Promise.reject(new Error("daemon is not started"))
    return Promise.resolve(this.#host.buffers.set(name, data))
  }

  pasteBuffer(name: string | undefined, target: string, deleteAfter: boolean): Promise<void> {
    const host = this.#host
    if (!host || !this.#runtime) return Promise.reject(new Error("daemon is not started"))
    return this.#runtime.runPromise(Effect.gen(function* () {
      const bytes = host.buffers.show(name)
      yield* host.paste(target, bytes)
      // The delete happens only after the paste went through: -d must not
      // lose a buffer because the write failed.
      if (deleteAfter) host.buffers.delete(name)
    }))
  }

  listBuffers(): Promise<readonly BufferEntry[]> {
    if (!this.#host || !this.#runtime) return Promise.resolve([])
    return Promise.resolve(this.#host.buffers.list())
  }

  deleteBuffer(name: string | undefined): Promise<void> {
    if (!this.#host || !this.#runtime) return Promise.reject(new Error("daemon is not started"))
    return Promise.resolve(this.#host.buffers.delete(name))
  }

  showBuffer(name: string | undefined): Promise<string> {
    if (!this.#host || !this.#runtime) return Promise.reject(new Error("daemon is not started"))
    return Promise.resolve(new TextDecoder().decode(this.#host.buffers.show(name)))
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
      const body = await boundedJson(request, MAX_RPC_BYTES) as DaemonRequest
      return Response.json(await this.handle(body))
    } catch (error) { return Response.json({ ok: false, error: String(error) }, { status: 400 }) }
  }

  async handle(request: DaemonRequest): Promise<DaemonResponse> {
    switch (request.command) {
      case "ping": return { ok: true, attached: this.#state.attached, ...this.#attachInfo() }
      case "status": {
        const persistenceError = this.#durableObligations.values().next().value as string | undefined
        const healthError = persistenceError ?? this.#heartbeatError ?? undefined
        return {
          ok: healthError === undefined,
          ...(healthError ? { error: healthError } : {}),
          session: this.state,
          workspace: this.workspace,
          attached: this.#state.attached,
          ...this.#attachInfo(),
          agents: [...(await this.liveAgents())],
        }
      }
      case "workspace-command": {
        if (request.expectedRevision === undefined || !request.workspaceContext) {
          return { ok: false, error: "workspace-command requires a revision and context", workspace: this.workspace }
        }
        try {
          const value = await Effect.runPromise(decodeCommand(request.workspaceCommand))
          const context = parseWorkspaceCommandContext(request.workspaceContext, this.#workspace)
          const workspace = await this.runWorkspaceCommand(value, request.expectedRevision, context)
          return { ok: true, workspace }
        } catch (error) { return { ok: false, error: describe(error), workspace: this.workspace } }
      }
      // The buffer verbs are the tmux paste-buffer family over the socket:
      // the stack lives here, so copy/paste work over ssh and from a script
      // with no client attached at all.
      case "set-buffer": {
        if (request.bufferData === undefined) return { ok: false, error: "set-buffer requires data" }
        try {
          const name = await this.setBuffer(request.bufferName, request.bufferData)
          return { ok: true, bufferName: name }
        } catch (error) { return { ok: false, error: describe(error) } }
      }
      case "paste-buffer": {
        if (!request.bufferTarget) return { ok: false, error: "paste-buffer requires a target session" }
        try {
          await this.pasteBuffer(request.bufferName, request.bufferTarget, request.bufferDelete === true)
          return { ok: true }
        } catch (error) { return { ok: false, error: describe(error) } }
      }
      case "list-buffers": {
        try {
          return { ok: true, buffers: await this.listBuffers() }
        } catch (error) { return { ok: false, error: describe(error) } }
      }
      case "delete-buffer": {
        try {
          await this.deleteBuffer(request.bufferName)
          return { ok: true }
        } catch (error) { return { ok: false, error: describe(error) } }
      }
      case "show-buffer": {
        try {
          return { ok: true, bufferData: await this.showBuffer(request.bufferName) }
        } catch (error) { return { ok: false, error: describe(error) } }
      }
      case "stop": await this.stop(); return { ok: true }
      default: return { ok: false, error: "unknown command" }
    }
  }

  async stop(): Promise<void> {
    return this.#terminate("stop")
  }

  /** Release the daemon process while preserving metadata for a restart. */
  async close(): Promise<void> {
    return this.#terminate("close")
  }

  #terminate(mode: "stop" | "close"): Promise<void> {
    if (this.#termination) return this.#termination
    this.#closing = true
    this.#resolveShutdown()
    this.#termination = this.#runTermination(mode)
    return this.#termination
  }

  async #runTermination(mode: "stop" | "close"): Promise<void> {
    let failure: unknown
    try {
      await this.#stopHeartbeat()
      this.#server?.stop()
      this.#server = null
      await this.#drainMutationsForShutdown()
      await this.#disposeHost()
      await this.#mutations

      if (mode === "stop") {
        await Effect.runPromise(removeSession(this.id).pipe(Effect.provideService(SessionEnv, this.#env)))
      } else {
        await this.#enqueueModelChange(async () => {
          const state = { ...this.#state, attached: false, updatedAt: Date.now() }
          await this.#persistState(state, { allowClosing: true, timeoutMs: SHUTDOWN_SAVE_TIMEOUT_MS })
          this.#attachments.clear()
          this.#state = state
        })
      }
    } catch (error) {
      failure = error
    } finally {
      await unlink(this.paths.socket).catch(() => {})
      await rm(this.paths.lease, { force: true }).catch(() => {})
      await this.#releaseLock()
      await Effect.runPromise(Scope.close(this.#scope, Exit.void))
      this.#resolveStopped()
    }
    if (failure) throw failure
  }

  /**
   * Tear down the PTY plane.
   *
   * Disposing the runtime closes the host scope, which runs SessionRegistry's
   * finalizers: every agent is killed and every master fd closed. There is no
   * kinder option — the PTYs are children of this process, so a daemon that
   * exits without this leaves them orphaned rather than saved.
   */
  async #disposeHost(): Promise<void> {
    const runtime = this.#runtime
    this.#runtime = null
    this.#host = null
    await runtime?.dispose().catch(() => {})
    await unlink(this.paths.attach).catch(() => {})
  }

  async #releaseLock() {
    await this.#lock?.close().catch(() => {})
    this.#lock = null
    await rm(this.#lockPath, { force: true }).catch(() => {})
  }

  async #interruptPersistence(): Promise<void> {
    const fiber = this.#activeSave
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber))
  }

  async #stopHeartbeat(): Promise<void> {
    const fiber = this.#heartbeat
    this.#heartbeat = null
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber))
  }

  /** Let an ordinary in-flight mutation finish, but cancel and join persistence
   * once the shutdown budget is exhausted. The queue itself is still awaited;
   * no mutation or write is abandoned in the background. */
  async #drainMutationsForShutdown(): Promise<void> {
    const drained = await this.#run(Effect.promise(() => this.#mutations).pipe(
      Effect.as(true),
      Effect.timeout(`${SHUTDOWN_SAVE_TIMEOUT_MS} millis`),
      Effect.orElseSucceed(() => false),
    ))
    if (drained) return
    this.#cancelPersistence = true
    await this.#interruptPersistence()
    await this.#mutations
  }

  async #persistState(
    state: SessionState,
    options: { allowClosing?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.#cancelPersistence && !options.allowClosing) throw new Error("daemon is shutting down")
    const write = options.timeoutMs === undefined
      ? this.#writeState(state)
      : this.#writeState(state).pipe(Effect.timeout(`${options.timeoutMs} millis`))
    const fiber = await this.#fork(write)
    this.#activeSave = fiber
    try {
      await Effect.runPromise(Fiber.join(fiber))
    } finally {
      if (this.#activeSave === fiber) this.#activeSave = null
    }
  }

  /**
   * Irreversible process changes cannot be rolled back. Keep their terminal
   * exits gated and retry the sole candidate write until disk recovers. Status
   * remains available and reports the unhealthy state; model mutations stop
   * behind this fail-stop barrier rather than diverging from durable state.
   */
  async #persistUntilSuccess(state: SessionState, reason: string): Promise<void> {
    const obligation = Symbol(reason)
    this.#durableObligations.set(obligation, `${reason} is waiting for durable storage`)
    let delay = 10
    try {
      for (;;) {
        if (this.#closing) throw new Error(`daemon shut down with outstanding durable obligation: ${reason}`)
        try {
          await this.#persistState(state)
          return
        } catch (error) {
          this.#durableObligations.set(obligation, `${reason} is waiting for durable storage: ${describe(error)}`)
          if (this.#closing) throw error
          await this.#run(Effect.raceFirst(
            Effect.sleep(`${delay} millis`),
            Effect.promise(() => this.#shutdown),
          ))
          delay = Math.min(delay * 2, 1_000)
        }
      }
    } finally {
      this.#durableObligations.delete(obligation)
    }
  }

  /** Native daemon callbacks only bridge far enough to fork work into the
   * daemon scope; the child fiber, its Clock sleeps, and its finalizers all
   * remain owned by that scope. */
  #fork<A, E>(effect: Effect.Effect<A, E>): Promise<Fiber.RuntimeFiber<A, E>> {
    return Effect.runPromise(Effect.forkIn(effect, this.#scope))
  }

  async #run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    const fiber = await this.#fork(effect)
    return Effect.runPromise(Fiber.join(fiber))
  }
}

async function boundedJson(request: Request, limit: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) throw new Error("request body is too large")
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel()
      throw new Error("request body is too large")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Client used by CLI commands and tests; HTTP keeps framing and errors explicit. */
export function daemonRequest(id: string, body: DaemonRequest): Effect.Effect<DaemonResponse, unknown, SessionEnv> {
  return Effect.flatMap(sessionPaths(id), (paths) => Effect.tryPromise({
    try: () => new Promise((resolve, reject) => {
      const request = httpRequest({ socketPath: paths.socket, path: "/rpc", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        let text = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => text += chunk)
        response.on("end", () => { try { resolve(JSON.parse(text) as DaemonResponse) } catch (error) { reject(error) } })
      })
      request.on("error", reject)
      request.end(JSON.stringify(body))
    }),
    catch: (error) => error,
  }))
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
  const daemon = await Effect.runPromise(SessionDaemon.open(id).pipe(Effect.provideService(SessionEnv, process.env)))
  await daemon.start()
  return daemon
}
