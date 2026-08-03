import { Cause, Data, Duration, Effect, Exit, Fiber, FiberId, FiberMap, Match, Scope, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { AttachHub } from "./AttachHub.ts"
import { createSocketWriter } from "../attach-write.ts"
import { MAX_ATTACH_FRAME_BYTES } from "../limits.ts"
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
  writer: { readonly closed: boolean; send(frame: AttachFrame): boolean; drain(): void; close(): void; closeAfterFlush(onFlushed: () => void): void } | null
  run: ClientRun | null
  owner: Fiber.RuntimeFiber<void, unknown> | null
  lanes: Map<string, Fiber.RuntimeFiber<void, unknown>>
  pending: Buffer[]
  nextFiber: number
  closed: boolean
}

type ClientRun = (
  key: string,
  effect: Effect.Effect<void, unknown>,
  options?: { readonly onlyIfMissing?: boolean },
) => Fiber.RuntimeFiber<void, unknown>

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
    closeAfterFlush: (onFlushed: () => void) => writer.closeAfterFlush(onFlushed),
  }
}

const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

/**
 * Native Bun Unix-socket adapter for the Effect attach protocol.
 *
 * The listener is scoped. Each socket has an owner fiber whose child fibers
 * process callbacks, output, and its idle deadline. Owner shutdown joins those
 * fibers before releasing the client's hub subscription and socket.
 */
export const startAttachServer = (
  options: AttachServerOptions,
): Effect.Effect<Bun.UnixSocketListener<ClientState>, AttachServerError, Scope.Scope | AttachHub> =>
  Effect.gen(function* () {
    const hub = yield* AttachHub
    const connections = yield* FiberMap.make<string, void, unknown>()
    const runConnection = yield* FiberMap.runtime(connections)<never>()

    const requestClose = (socket: Bun.Socket<ClientState>) => {
      const state = socket.data
      if (state.closed) return
      state.closed = true
      state.owner?.unsafeInterruptAsFork(FiberId.none)
    }

    const terminate = (socket: Bun.Socket<ClientState>, frame?: AttachFrame) => {
      const writer = socket.data.writer
      if (!frame || !writer || writer.closed || !writer.send(frame)) {
        requestClose(socket)
        return
      }
      // Keep the error frame's suffix ahead of socket shutdown. A protocol
      // error is useful only if the peer receives one complete frame.
      writer.closeAfterFlush(() => {
        requestClose(socket)
      })
    }

    /** Accept a hello, or tell the client why it was refused and hang up. */
    const attach = (socket: Bun.Socket<ClientState>, client: string) =>
      Effect.gen(function* () {
        const child = yield* Scope.make()
        const subscribed = yield* Scope.extend(hub.subscribe(client, socket.data.connection, () => {
          requestClose(socket)
        }), child).pipe(Effect.exit)

        if (Exit.isFailure(subscribed)) {
          yield* Scope.close(child, Exit.succeed(undefined))
          terminate(socket, { _tag: "error", message: reason(subscribed.cause) })
          return
        }

        // The subscription is installed before onAttach so owner interruption
        // can always release this generation. Socket close interrupts onAttach;
        // cleanup then unregisters the hub generation before onDetach.
        if (socket.data.closed) {
          yield* Scope.close(child, Exit.succeed(undefined))
          return
        }
        socket.data.client = client
        socket.data.scope = child
        const attached = yield* (options.onAttach?.(client, socket.data.connection) ?? Effect.void).pipe(Effect.exit)
        if (Exit.isFailure(attached)) {
          if (socket.data.scope === child) {
            yield* Scope.close(child, Exit.succeed(undefined))
            socket.data.client = null
            socket.data.scope = null
          }
          terminate(socket, { _tag: "error", message: reason(attached.cause) })
          return
        }
        if (socket.data.closed || socket.data.scope !== child) {
          yield* Scope.close(child, Exit.succeed(undefined))
          return
        }
        socket.data.run?.("output", Stream.runForEach(subscribed.value.frames, (outgoing) =>
          Effect.sync(() => {
            if (!socket.data.closed) socket.data.writer?.send(outgoing)
          }),
        ).pipe(
          Effect.ensuring(Effect.sync(() => {
            requestClose(socket)
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
      if (state.closed || !state.run) return
      const lane = laneFor(frame)
      const dependencies = [state.lanes.get(lane)]
      if (lane !== "handshake") dependencies.push(state.lanes.get("handshake"))
      const current = state.run(`frame:${state.nextFiber++}`, Effect.forEach(
        dependencies,
        (fiber) => fiber ? Fiber.await(fiber) : Effect.void,
        { discard: true },
      ).pipe(
        Effect.andThen(handleFrame(socket, frame)),
        Effect.catchAllCause((cause) => Effect.sync(() => {
          if (!state.closed && !Cause.isInterruptedOnly(cause)) {
            terminate(socket, { _tag: "error", message: reason(cause) })
          }
        })),
      ))
      state.lanes.set(lane, current)
      current.addObserver(() => {
        if (state.lanes.get(lane) === current) state.lanes.delete(lane)
      })
    }

    const resetIdleDeadline = (socket: Bun.Socket<ClientState>) => {
      const state = socket.data
      if (state.closed || !state.run) return
      const seconds = options.idleTimeoutSeconds ?? 60
      state.run("deadline", Effect.sleep(Duration.seconds(seconds)).pipe(
        Effect.andThen(Effect.sync(() => {
          if (state.closed) return
          requestClose(socket)
        })),
      ))
    }

    const processData = (socket: Bun.Socket<ClientState>, data: Buffer) => {
      const state = socket.data
      if (state.closed || !state.run) return
      const previous = state.lanes.get("wire")
      const current = state.run(`wire:${state.nextFiber++}`, (previous ? Fiber.await(previous) : Effect.void).pipe(
        Effect.andThen(Effect.gen(function* () {
          if (Buffer.byteLength(state.buffer) + data.byteLength > MAX_ATTACH_FRAME_BYTES) {
            return yield* new AttachServerError({ message: "attach frame is too large" })
          }
          state.buffer += data.toString("utf8")
          const decoded = decodeAttachFrames(state.buffer)
          state.buffer = decoded.rest
          for (const frame of decoded.frames) dispatchFrame(socket, frame)
        })),
        Effect.catchAll((error) => Effect.sync(() => {
          if (!state.closed) terminate(socket, { _tag: "error", message: String(error) })
        })),
      ))
      state.lanes.set("wire", current)
      current.addObserver(() => {
        if (state.lanes.get("wire") === current) state.lanes.delete("wire")
      })
    }

    const closeClient = (socket: Bun.Socket<ClientState>) => Effect.uninterruptible(
      Effect.gen(function* () {
        const state = socket.data
        const client = state.client
        const connection = state.connection
        const scope = state.scope
        state.run = null
        state.owner = null
        state.client = null
        state.scope = null
        state.writer?.close()
        // Child callback/output fibers have already been joined by the inner
        // scope. End the transport before slower owner hooks can overlap other
        // host finalizers and expose daemon-shutdown exit frames to this client.
        // Protocol errors reach here only after closeAfterFlush has drained.
        socket.terminate()
        // The hub registration must be gone before onDetach advertises that
        // this client id can reconnect.
        if (scope) yield* Scope.close(scope, Exit.succeed(undefined))
        if (client) yield* (options.onDetach?.(client, connection) ?? Effect.void).pipe(Effect.exit)
      }),
    )

    const ownConnection = (socket: Bun.Socket<ClientState>) => Effect.scoped(
      Effect.gen(function* () {
        const state = socket.data
        const fibers = yield* FiberMap.make<string>()
        state.run = (yield* FiberMap.runtime(fibers)<never>()) as ClientRun
        // Registered after FiberMap.make, so this runs first when the owner
        // scope closes. Concurrent host finalizers may publish session exits;
        // mark the connection closed before output fibers can forward them.
        yield* Effect.addFinalizer(() => Effect.sync(() => { state.closed = true }))
        resetIdleDeadline(socket)
        for (const data of state.pending.splice(0)) processData(socket, data)
        if (!state.closed) yield* Effect.never
      }),
    ).pipe(Effect.ensuring(closeClient(socket)))

    const listener = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.listen<ClientState>({
            unix: options.path,
            data: { buffer: "", client: null, connection: "", scope: null, writer: null, run: null, owner: null, lanes: new Map(), pending: [], nextFiber: 0, closed: false },
            socket: {
              binaryType: "buffer",
              open(socket) {
                // Listener data is shared as a template; each connection
                // needs independent framing and attachment state.
                socket.data = { buffer: "", client: null, connection: randomUUID(), scope: null, writer: null, run: null, owner: null, lanes: new Map(), pending: [], nextFiber: 0, closed: false }
                socket.data.writer = createAttachWriter(socket, () => {
                  requestClose(socket)
                })
                socket.data.owner = runConnection(socket.data.connection, ownConnection(socket))
              },
              data(socket, data) {
                resetIdleDeadline(socket)
                const state = socket.data
                if (state.run) processData(socket, data)
                else state.pending.push(data)
              },
              close(socket) {
                requestClose(socket)
              },
              error(socket) {
                requestClose(socket)
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

    // Registered after the listener's release, this clear runs first and joins
    // every owner. FiberMap's earlier automatic shutdown is then a no-op.
    yield* Effect.addFinalizer(() => FiberMap.clear(connections))

    return listener
  })
