import { Cause, Effect, ExecutionStrategy, Exit, FiberMap, Match, Runtime, Scope, Stream } from "effect"
import { AttachHub } from "./AttachHub.ts"
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./AttachProtocol.ts"

export class AttachServerError extends Error {}

export interface AttachServerOptions {
  readonly path: string
  /** Seconds without inbound traffic before the attach is considered dead. */
  readonly idleTimeoutSeconds?: number
  readonly onFrame?: (client: string, frame: AttachFrame) => Effect.Effect<void, unknown>
  /**
   * Called when a client's hello has been accepted by the hub, before any
   * output is forwarded. Failing it rejects the attachment: the client is sent
   * the error and disconnected, and its subscription is torn down.
   *
   * This is the hook that lets an owner outside the data plane — the daemon's
   * single-attachment rule — have the final say on who is attached, without the
   * transport needing to know what that rule is.
   */
  readonly onAttach?: (client: string) => Effect.Effect<void, unknown>
  /**
   * Called when an accepted client goes away, for any reason: clean EOF, socket
   * error, or idle timeout. Together with onAttach this makes the *stream* the
   * authority on attachment state — a client that dies without detaching is
   * indistinguishable from one that never attached, which is exactly the
   * property request/response RPC could not provide.
   */
  readonly onDetach?: (client: string) => Effect.Effect<void, unknown>
}

interface ClientState {
  buffer: string
  client: string | null
  scope: Scope.CloseableScope | null
}

const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

/**
 * Native Bun Unix-socket adapter for the Effect attach protocol.
 *
 * The listener is scoped. Each hello creates a child scope whose finalizers
 * unregister the client and shut down its queue; socket close closes that child
 * scope, which is the ownership/liveness boundary for an attachment.
 */
export const startAttachServer = (
  options: AttachServerOptions,
): Effect.Effect<Bun.UnixSocketListener<ClientState>, AttachServerError, Scope.Scope | AttachHub> =>
  Effect.gen(function* () {
    const hub = yield* AttachHub
    const root = yield* Scope.Scope
    const clientFibers = yield* FiberMap.make<string>()
    const runClient = yield* FiberMap.runtime(clientFibers)<never>()

    // The ambient runtime, not the default one: fibers forked for socket
    // callbacks then inherit this scope's services, logger and fiber refs, and
    // are interrupted when it closes instead of outliving it as orphans.
    const runtime = yield* Effect.runtime<never>()
    const run = (effect: Effect.Effect<void, unknown>) =>
      Runtime.runFork(runtime)(Effect.catchAllCause(effect, () => Effect.void))

    const closeClient = (socket: Bun.Socket<ClientState>) => {
      const state = socket.data
      const client = state.client
      const scope = state.scope
      state.client = null
      state.scope = null
      if (!client && !scope) return
      run(
        // Order matters, and it is the reverse of the obvious one. onDetach is
        // what tells the owner the session is free, so everything that would
        // refuse a new client must already be undone when it runs — the hub's
        // registration of this client id is released by closing the scope. The
        // other way round leaves a window where the daemon says "not attached"
        // and the hub still says "that id is taken", and a client reconnecting
        // promptly under its own id lands in it.
        Effect.gen(function* () {
          if (client) yield* FiberMap.remove(clientFibers, client)
          if (scope) yield* Scope.close(scope, Exit.succeed(undefined))
          if (client) yield* options.onDetach?.(client) ?? Effect.void
        }),
      )
    }

    /** Accept a hello, or tell the client why it was refused and hang up. */
    const attach = (socket: Bun.Socket<ClientState>, client: string) =>
      Effect.gen(function* () {
        const child = yield* Scope.fork(root, ExecutionStrategy.sequential)
        const accepted = yield* Scope.extend(hub.subscribe(client), child).pipe(
          // The hub decides whether this id is free; the owner decides whether
          // anyone may attach at all. Both must pass before a byte is sent, and
          // both unwind through the same child scope if either refuses.
          Effect.tap(() => options.onAttach?.(client) ?? Effect.void),
          Effect.exit,
        )

        if (Exit.isFailure(accepted)) {
          yield* Scope.close(child, Exit.succeed(undefined))
          socket.write(encodeAttachFrame({ _tag: "error", message: reason(accepted.cause) }))
          socket.end()
          return
        }

        socket.data.client = client
        socket.data.scope = child
        // Deliberately not awaited: a Fiber is an Effect, so yielding it here
        // would park the frame loop on the client's output stream and drop
        // every frame batched behind this hello in the same read.
        runClient(client, Stream.runForEach(accepted.value.frames, (outgoing) =>
          Effect.sync(() => {
            // A negative write means the peer is closed or its kernel buffer
            // is full. The queue remains bounded; drain-aware socket writing
            // is the next transport hardening slice.
            socket.write(encodeAttachFrame(outgoing))
          }),
        ))
      })

    const handleFrame = (socket: Bun.Socket<ClientState>, frame: AttachFrame): Effect.Effect<void, unknown> =>
      Match.value(frame).pipe(
        Match.tag("hello", (hello) =>
          Effect.gen(function* () {
            if (socket.data.client) {
              socket.write(encodeAttachFrame({ _tag: "error", message: "hello already received" }))
              return
            }
            yield* attach(socket, hello.client)
          })),
        Match.tag("ping", (ping) =>
          Effect.sync(() => {
            if (!socket.data.client) {
              socket.write(encodeAttachFrame({ _tag: "error", message: "hello is required first" }))
              socket.end()
              return
            }
            socket.write(encodeAttachFrame({ _tag: "pong", nonce: ping.nonce }))
          })),
        Match.orElse((clientFrame) =>
          Effect.gen(function* () {
            if (!socket.data.client) {
              socket.write(encodeAttachFrame({ _tag: "error", message: "hello is required first" }))
              socket.end()
              return
            }
            yield* options.onFrame?.(socket.data.client, clientFrame) ?? Effect.void
          })),
      )

    const listener = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.listen<ClientState>({
            unix: options.path,
            data: { buffer: "", client: null, scope: null },
            socket: {
              binaryType: "buffer",
              open(socket) {
                // Listener data is shared as a template; each connection
                // needs independent framing and attachment state.
                socket.data = { buffer: "", client: null, scope: null }
                socket.timeout(options.idleTimeoutSeconds ?? 60)
              },
              data(socket, data) {
                socket.timeout(options.idleTimeoutSeconds ?? 60)
                run(
                  Effect.gen(function* () {
                    const state = socket.data
                    state.buffer += data.toString("utf8")
                    const decoded = decodeAttachFrames(state.buffer)
                    state.buffer = decoded.rest
                    for (const frame of decoded.frames) yield* handleFrame(socket, frame)
                  }).pipe(
                    Effect.catchAll((error) =>
                      Effect.sync(() => {
                        socket.write(encodeAttachFrame({ _tag: "error", message: String(error) }))
                        socket.end()
                      }),
                    ),
                  ),
                )
              },
              close(socket) {
                closeClient(socket)
              },
              error(socket) {
                closeClient(socket)
              },
              timeout(socket) {
                closeClient(socket)
                socket.end()
              },
            },
          }),
        catch: (error) => new AttachServerError(String(error)),
      }),
      (server) => Effect.sync(() => server.stop(true)),
    )

    return listener
  })
