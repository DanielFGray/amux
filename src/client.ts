import { spawn } from "node:child_process"
import { Data, Effect, Layer, Schedule, Stream } from "effect"
import { AttachClient } from "./attach.ts"
import { daemonBackend, type DaemonSession, type SpawnBackend } from "./backend.ts"
import { daemonRequest, type DaemonResponse } from "./daemon.ts"
import type { BufferEntry } from "./effect/BufferStore.ts"
import type { Command } from "./commands.ts"
import { parseWorkspace, type WorkspaceCommandContext, type WorkspaceSnapshot } from "./workspace.ts"
import { readLease, processAlive, sessionPaths, SessionEnv, type SessionState } from "./session.ts"

const START_TIMEOUT_MS = 10_000
const POLL_MS = 25

export interface SessionClientOptions {
  client?: string
  autostart?: boolean
}

export class SessionClientError extends Data.TaggedError("SessionClientError")<{
  message: string
}> {}

export interface SessionClientShape extends DaemonSession {
  readonly id: string
  readonly session: SessionState | null
  readonly live: ReadonlySet<string>
  readonly workspace: () => WorkspaceSnapshot
  readonly models: Stream.Stream<WorkspaceSnapshot>
  readonly runWorkspace: (command: Command, context: WorkspaceCommandContext) => Effect.Effect<WorkspaceSnapshot, unknown, never>
  readonly backend: () => SpawnBackend
  readonly close: () => void
  readonly stop: () => Effect.Effect<void, unknown, never>
  /** tmux's buffer verbs, all server-side: the stack lives in the daemon
   *  beside the PTYs, so a copy and a paste work with no client attached. */
  readonly setBuffer: (name: string | undefined, data: string) => Effect.Effect<string, unknown, never>
  readonly pasteBuffer: (name: string | undefined, target: string, deleteAfter?: boolean) => Effect.Effect<void, unknown, never>
  readonly listBuffers: () => Effect.Effect<readonly BufferEntry[], unknown, never>
  readonly deleteBuffer: (name: string | undefined) => Effect.Effect<void, unknown, never>
  readonly showBuffer: (name: string | undefined) => Effect.Effect<string, unknown, never>
}

export class SessionClient extends Effect.Service<SessionClientShape>()("SessionClient", {
  scoped: (id: string, options: SessionClientOptions = {}) => Effect.acquireRelease(
    make(id, options),
    (client) => Effect.sync(() => client.close()),
  ),
}) {
  static layer(id: string, options: SessionClientOptions = {}) {
    return Layer.scoped(SessionClient, Effect.acquireRelease(
      make(id, options),
      (client) => Effect.sync(() => client.close()),
    ))
  }

  static connect(id: string, options: SessionClientOptions = {}): Effect.Effect<SessionClientShape, unknown, SessionEnv> {
    return make(id, options)
  }
}

export interface SessionClient extends SessionClientShape {}

const make = (id: string, options: SessionClientOptions): Effect.Effect<SessionClientShape, unknown, SessionEnv> =>
  Effect.gen(function* () {
    const env = yield* SessionEnv
    if (options.autostart !== false) yield* ensureDaemon(id)
    const paths = yield* sessionPaths(id)
    const attach = yield* Effect.tryPromise({
      try: () => AttachClient.connect({ path: paths.attach, client: options.client ?? `pid-${process.pid}` }),
      catch: (error) => new SessionClientError({ message: String(error) }),
    })
    let status: DaemonResponse
    try {
      status = yield* daemonRequest(id, { command: "status" })
    } catch (error) {
      yield* Effect.sync(() => attach.close())
      return yield* Effect.fail(new SessionClientError({ message: `session '${id}' did not answer status: ${String(error)}` }))
    }
    if (!status.workspace) {
      yield* Effect.sync(() => attach.close())
      return yield* Effect.fail(new SessionClientError({ message: "daemon status returned no workspace" }))
    }
    let service!: SessionClientShape
    const initialWorkspace = yield* Effect.try({
      try: () => parseWorkspace(status.workspace),
      catch: (error) => new SessionClientError({ message: `daemon returned an invalid workspace: ${String(error)}` }),
    })
    let workspace = initialWorkspace
    let commandQueue: Promise<void> = Promise.resolve()
    const accept = (next: WorkspaceSnapshot) => {
      if (next.revision > workspace.revision) workspace = next
      for (const space of next.spaces) {
        for (const window of space.windows) {
          for (const agent of window.agents) if (!agent.exited) (service.live as Set<string>).add(agent.id)
        }
      }
      return workspace
    }
    service = {
      id,
      attach,
      session: status.session ?? null,
      live: new Set(status.agents ?? []),
      workspace: () => structuredClone(workspace),
      models: attach.workspace().pipe(Stream.map(accept)),
      runWorkspace: (command, context) => Effect.tryPromise({
        try: () => {
          const request = async () => {
            const response = await Effect.runPromise(daemonRequest(id, {
              command: "workspace-command",
              workspaceCommand: command,
              expectedRevision: workspace.revision,
              workspaceContext: context,
            }).pipe(Effect.provideService(SessionEnv, env)))
            if (!response.ok) throw new SessionClientError({ message: response.error ?? "workspace command refused" })
            if (!response.workspace) throw new SessionClientError({ message: "workspace command returned no generation" })
            accept(parseWorkspace(response.workspace))
            return structuredClone(workspace)
          }
          const queued = commandQueue.then(request)
          commandQueue = queued.then(() => {}, () => {})
          return queued
        },
        catch: (error) => error,
      }),
      backend: () => daemonBackend(service, service.live),
      setBuffer: (name: string | undefined, data: string) => daemonRequest(id, { command: "set-buffer", bufferName: name, bufferData: data }).pipe(Effect.provideService(SessionEnv, env),
        Effect.flatMap((response) => response.ok
          ? Effect.succeed(response.bufferName ?? name ?? "")
          : Effect.fail(new SessionClientError({ message: response.error ?? "set-buffer refused" }))),
      ),
      pasteBuffer: (name: string | undefined, target: string, deleteAfter = false) => daemonRequest(id, { command: "paste-buffer", bufferName: name, bufferTarget: target, bufferDelete: deleteAfter }).pipe(Effect.provideService(SessionEnv, env),
        Effect.flatMap((response) => response.ok ? Effect.void : Effect.fail(new SessionClientError({ message: response.error ?? "paste-buffer refused" }))),
      ),
      listBuffers: () => daemonRequest(id, { command: "list-buffers" }).pipe(Effect.provideService(SessionEnv, env),
        Effect.flatMap((response) => response.ok
          ? Effect.succeed(response.buffers ?? [])
          : Effect.fail(new SessionClientError({ message: response.error ?? "list-buffers refused" }))),
      ),
      deleteBuffer: (name: string | undefined) => daemonRequest(id, { command: "delete-buffer", bufferName: name }).pipe(Effect.provideService(SessionEnv, env),
        Effect.flatMap((response) => response.ok ? Effect.void : Effect.fail(new SessionClientError({ message: response.error ?? "delete-buffer refused" }))),
      ),
      showBuffer: (name: string | undefined) => daemonRequest(id, { command: "show-buffer", bufferName: name }).pipe(Effect.provideService(SessionEnv, env),
        Effect.flatMap((response) => response.ok
          ? Effect.succeed(response.bufferData ?? "")
          : Effect.fail(new SessionClientError({ message: response.error ?? "show-buffer refused" }))),
      ),
      close: () => attach.close(),
      stop: () => daemonRequest(id, { command: "stop" }).pipe(Effect.provideService(SessionEnv, env), Effect.catchAll(() => Effect.void), Effect.asVoid),
    }
    return service
  })

export function daemonAlive(id: string): Effect.Effect<boolean, never, SessionEnv> {
  return Effect.gen(function* () {
    const lease = yield* readLease(id).pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (!lease || !processAlive(lease.pid)) return false
    return yield* daemonRequest(id, { command: "ping" }).pipe(Effect.map((response) => response.ok), Effect.catchAll(() => Effect.succeed(false)))
  })
}

export function ensureDaemon(id: string): Effect.Effect<void, SessionClientError, SessionEnv> {
  return Effect.gen(function* () {
    if (yield* daemonAlive(id)) return
    const env = yield* SessionEnv
    const entry = new URL("./daemon-main.ts", import.meta.url).pathname
    const child = yield* Effect.try({
      try: () => spawn(process.execPath, [entry, id], { detached: true, stdio: "ignore", env }),
      catch: (error) => new SessionClientError({ message: String(error) }),
    })
    child.unref()
    const daemonReady = daemonAlive(id).pipe(Effect.filterOrFail(Boolean, () => new SessionClientError({ message: "daemon is not ready" })))
    yield* daemonReady.pipe(
      Effect.retry(Schedule.spaced(`${POLL_MS} millis`).pipe(Schedule.upTo(`${START_TIMEOUT_MS} millis`))),
      Effect.catchAll(() => Effect.fail(new SessionClientError({ message: `daemon for session '${id}' did not start within ${START_TIMEOUT_MS}ms` }))),
    )
  })
}
