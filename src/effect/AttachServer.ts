import { Cause, Data, Effect, ExecutionStrategy, Exit, FiberMap, Match, Runtime, Scope, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { AttachHub } from "./AttachHub.ts"
import { createSocketWriter } from "../attach-write.ts"
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./AttachProtocol.ts"

export class AttachServerError extends Data.TaggedError("AttachServerError")<{
  message: string
}> {}

export interface AttachServerOptions {
  readonly path: string
  /** Seconds without inbound traffic before the attach is considered dead. */
  readonly idleTimeoutSeconds?: number
  readonly onFrame?: (client: string, frame: AttachFrame) => Effect.Effect<void, unknown>
  /**
   * A client adopted a session and asked for its screen to be replayed to it
   * alone. The owner serializes the session's current screen and answers with
   * `publishTo`, keeping the replay ordered ahead of the session's live output.
   */
  readonly onSync?: (client: string, connection: string, session: string) => Effect.Effect<void, unknown>
  /**
   * Called once per inbound frame from an accepted client — pings included,
   * which is exactly what onFrame does not see. This is the transport's proof
   * of life for an attachment: a client that sends anything, even a heartbeat
   * for an otherwise idle session, has not gone away. The owner uses it to
   * keep a last-seen timestamp rather than having to reimplement frame
   * accounting at the daemon boundary.
   */
  readonly onActivity?: (client: string, connection: string) => Effect.Effect<void, unknown>
  /**
   * Called when a client's hello has been accepted by the hub, before any
   * output is forwarded. Failing it rejects the attachment: the client is sent
   * the error and disconnected, and its subscription is torn down.
   *
   * This is the hook that lets an owner outside the data plane record or reject
   * an attachment, without the transport needing to know that policy.
   */
  readonly onAttach?: (client: string, connection: string) => Effect.Effect<void, unknown>
  /**
   * Called when an accepted client goes away, for any reason: clean EOF, socket
   * error, or idle timeout. Together with onAttach this makes the *stream* the
   * authority on attachment state — a client that dies without detaching is
   * indistinguishable from one that never attached, which is exactly the
   * property request/response RPC could not provide.
   */
  readonly onDetach?: (client: string, connection: string) => Effect.Effect<void, unknown>
}

interface ClientState {
  buffer: string
  client: string | null
  connection: string
  scope: Scope.CloseableScope | null
  processing: Promise<void>
  idleTimer: Timer | null
  writer: { readonly closed: boolean; send(frame: AttachFrame): boolean; drain(): void; close(): void } | null
  lanes: Map<string, Promise<void>>
}

export const createAttachWriter = (
  socket: Pick<Bun.Socket, "write">,
  onOverload: () => void,
  maxPendingBytes?: number,
) => {
  const writer = createSocketWriter(
    socket as { write(data: Uint8Array, offset: number, length: number): number },
    onOverload,
    maxPendingBytes,
  )
  return {
    get closed() { return writer.closed },
    send: (frame: AttachFrame) => writer.send(new TextEncoder().encode(encodeAttachFrame(frame))),
    drain: () => writer.drain(),
    close: () => writer.close(),
  }
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
      if (state.idleTimer) clearTimeout(state.idleTimer)
      state.idleTimer = null
      const client = state.client
      const connection = state.connection
      const scope = state.scope
      state.client = null
      state.scope = null
      state.writer?.close()
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
           if (client) yield* options.onDetach?.(client, connection) ?? Effect.void
        }),
      )
    }

    // Error rejection is intentionally abrupt: once a protocol error is known,
    // do not claim the queued error frame was delivered before ending a
    // potentially partial socket write.
    const terminate = (socket: Bun.Socket<ClientState>, frame?: AttachFrame) => {
      if (frame) socket.data.writer?.send(frame)
      socket.data.writer?.close()
      closeClient(socket)
      socket.end()
    }

    /** Accept a hello, or tell the client why it was refused and hang up. */
    const attach = (socket: Bun.Socket<ClientState>, client: string) =>
      Effect.gen(function* () {
        const child = yield* Scope.fork(root, ExecutionStrategy.sequential)
        const accepted = yield* Scope.extend(hub.subscribe(client, socket.data.connection, () => {
          closeClient(socket)
          socket.end()
        }), child).pipe(
          // The hub decides whether this id is free; the owner decides whether
          // anyone may attach at all. Both must pass before a byte is sent, and
          // both unwind through the same child scope if either refuses.
          Effect.tap(() => options.onAttach?.(client, socket.data.connection) ?? Effect.void),
          Effect.exit,
        )

        if (Exit.isFailure(accepted)) {
          yield* Scope.close(child, Exit.succeed(undefined))
          terminate(socket, { _tag: "error", message: reason(accepted.cause) })
          return
        }

        socket.data.client = client
        socket.data.scope = child
        // Deliberately not awaited: a Fiber is an Effect, so yielding it here
        // would park the frame loop on the client's output stream and drop
        // every frame batched behind this hello in the same read.
        runClient(client, Stream.runForEach(accepted.value.frames, (outgoing) =>
          Effect.sync(() => {
            socket.data.writer?.send(outgoing)
          }),
        ).pipe(
          Effect.ensuring(Effect.sync(() => {
            closeClient(socket)
            socket.end()
          })),
        ))
      })

    const handleFrame = (socket: Bun.Socket<ClientState>, frame: AttachFrame): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        if (socket.data.client) {
          yield* options.onActivity?.(socket.data.client, socket.data.connection) ?? Effect.void
        }
        yield* Match.value(frame).pipe(
          Match.tag("hello", (hello) =>
            Effect.gen(function* () {
              if (socket.data.client) {
                socket.data.writer?.send({ _tag: "error", message: "hello already received" })
                return
              }
              yield* attach(socket, hello.client)
            })),
          Match.tag("ping", (ping) =>
            Effect.sync(() => {
              if (!socket.data.client) {
                terminate(socket, { _tag: "error", message: "hello is required first" })
                return
              }
              socket.data.writer?.send({ _tag: "pong", nonce: ping.nonce })
            })),
          Match.tag("sync", (sync) =>
            Effect.gen(function* () {
              if (!socket.data.client) {
                terminate(socket, { _tag: "error", message: "hello is required first" })
                return
              }
              yield* hub.beginReplay(socket.data.client, socket.data.connection)
              yield* (options.onSync?.(socket.data.client, socket.data.connection, sync.session) ?? Effect.void).pipe(
                Effect.ensuring(hub.endReplay(socket.data.client, socket.data.connection)),
              )
            })),
          Match.orElse((clientFrame) =>
            Effect.gen(function* () {
              if (!socket.data.client) {
                terminate(socket, { _tag: "error", message: "hello is required first" })
                return
              }
              yield* options.onFrame?.(socket.data.client, clientFrame) ?? Effect.void
            })),
        )
      })

    const laneFor = (frame: AttachFrame): string =>
      frame._tag === "input" || frame._tag === "resize" || frame._tag === "sync"
        ? `session:${frame.session}`
        : frame._tag === "hello" ? "handshake" : "connection"

    const dispatchFrame = (socket: Bun.Socket<ClientState>, frame: AttachFrame) => {
      const state = socket.data
      const lane = laneFor(frame)
      const previous = state.lanes.get(lane) ?? Promise.resolve()
      const handshake = lane === "handshake" ? Promise.resolve() : state.lanes.get("handshake") ?? Promise.resolve()
      const current = Promise.all([previous, handshake]).then(() => Runtime.runPromise(runtime)(handleFrame(socket, frame))).catch((error) => {
        if (state.writer?.closed) return
        terminate(socket, { _tag: "error", message: String(error) })
      })
      state.lanes.set(lane, current)
      void current.finally(() => {
        if (state.lanes.get(lane) === current) state.lanes.delete(lane)
      })
    }

    const resetIdleTimer = (socket: Bun.Socket<ClientState>) => {
      const state = socket.data
      if (state.idleTimer) clearTimeout(state.idleTimer)
      const seconds = options.idleTimeoutSeconds ?? 60
      state.idleTimer = setTimeout(() => {
        closeClient(socket)
        socket.end()
      }, seconds * 1000)
      state.idleTimer.unref?.()
    }

    const listener = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.listen<ClientState>({
            unix: options.path,
            data: { buffer: "", client: null, connection: "", scope: null, processing: Promise.resolve(), idleTimer: null, writer: null, lanes: new Map() },
            socket: {
              binaryType: "buffer",
              open(socket) {
                // Listener data is shared as a template; each connection
                // needs independent framing and attachment state.
                socket.data = { buffer: "", client: null, connection: randomUUID(), scope: null, processing: Promise.resolve(), idleTimer: null, writer: null, lanes: new Map() }
                socket.data.writer = createAttachWriter(socket, () => {
                  closeClient(socket)
                  socket.end()
                })
                resetIdleTimer(socket)
              },
              data(socket, data) {
                resetIdleTimer(socket)
                const state = socket.data
                // Bun may invoke data callbacks concurrently. Keep complete
                // frames from one connection in wire order so resize->sync
                // adoption cannot serialize the old dimensions.
                state.processing = state.processing.then(() => Runtime.runPromise(runtime)(
                  Effect.gen(function* () {
                    state.buffer += data.toString("utf8")
                    const decoded = decodeAttachFrames(state.buffer)
                    state.buffer = decoded.rest
                    for (const frame of decoded.frames) dispatchFrame(socket, frame)
                  }).pipe(
                    Effect.catchAll((error) =>
                      Effect.sync(() => {
                        terminate(socket, { _tag: "error", message: String(error) })
                      }),
                    ),
                  ),
                )).catch(() => {})
              },
              close(socket) {
                closeClient(socket)
              },
              error(socket) {
                closeClient(socket)
              },
              drain(socket) {
                socket.data.writer?.drain()
              },
            },
          }),
        catch: (error) => new AttachServerError({ message: String(error) }),
      }),
      (server) => Effect.sync(() => server.stop(true)),
    )

    return listener
  })
