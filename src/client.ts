import { spawn } from "node:child_process"
import { Data, Effect, Layer, Schedule } from "effect"
import { AttachClient } from "./attach.ts"
import { daemonBackend, type BackendOptions, type DaemonSession, type SpawnBackend } from "./backend.ts"
import { daemonRequest, type DaemonResponse } from "./daemon.ts"
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
  readonly backend: () => SpawnBackend
  readonly close: () => void
  readonly stop: () => Effect.Effect<void, unknown, never>
  readonly save: (workspace: Pick<SessionState, "spaces"> & { activeSpace?: string | null }) => Effect.Effect<void, unknown, never>
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
    let service!: SessionClientShape
    service = {
      id,
      attach,
      stream: (agent: string) => attach.stream(agent),
      session: status.session ?? null,
      live: new Set(status.agents ?? []),
      backend: () => daemonBackend(service, service.live),
      spawn: (spec: BackendOptions) => daemonRequest(id, { command: "spawn", spawn: { id: spec.id, cmd: spec.cmd, cwd: spec.cwd, cols: spec.cols, rows: spec.rows } }).pipe(Effect.provideService(SessionEnv, env),
        Effect.flatMap((response) => response.ok ? Effect.void : Effect.fail(new SessionClientError({ message: response.error ?? "spawn refused" }))),
      ),
      kill: (agent: string) => daemonRequest(id, { command: "kill", agent }).pipe(Effect.provideService(SessionEnv, env), Effect.catchAll(() => Effect.void), Effect.asVoid),
      save: (workspace: Pick<SessionState, "spaces"> & { activeSpace?: string | null }) => daemonRequest(id, { command: "save", workspace }).pipe(Effect.provideService(SessionEnv, env),
        Effect.flatMap((response) => response.ok ? Effect.void : Effect.fail(new SessionClientError({ message: response.error ?? "save refused" }))),
      ),
      close: () => attach.close(),
      stop: () => daemonRequest(id, { command: "stop" }).pipe(Effect.provideService(SessionEnv, env), Effect.catchAll(() => Effect.void), Effect.asVoid),
    }
    return service
  })

export function daemonAlive(id: string): Effect.Effect<boolean, never, SessionEnv> {
  return Effect.gen(function* () {
    const lease = yield* readLease(id)
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
