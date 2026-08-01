import { Effect, ExecutionStrategy, Exit, FiberMap, Runtime, Scope, Stream } from "effect"
import { AttachHub } from "./AttachHub.ts"
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./AttachProtocol.ts"

export class AttachServerError extends Error {}

export interface AttachServerOptions {
  readonly path: string
  readonly onFrame?: (client: string, frame: AttachFrame) => Effect.Effect<void, never>
}

interface ClientState {
  buffer: string
  client: string | null
  scope: Scope.CloseableScope | null
}

const isClientFrame = (frame: AttachFrame): frame is Exclude<AttachFrame, { _tag: "hello" }> =>
  frame._tag !== "hello"

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

    const run = (effect: Effect.Effect<void, unknown>) => Runtime.runFork(Runtime.defaultRuntime)(effect)

    const closeClient = (socket: Bun.Socket<ClientState>) => {
      const state = socket.data
      if (state.client) {
        run(FiberMap.remove(clientFibers, state.client))
      }
      if (state.scope) {
        const scope = state.scope
        state.scope = null
        run(Scope.close(scope, Exit.succeed(undefined)))
      }
      state.client = null
    }

    const handleFrame = (socket: Bun.Socket<ClientState>, frame: AttachFrame): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const state = socket.data
        if (frame._tag === "hello") {
          if (state.client) {
            socket.write(encodeAttachFrame({ _tag: "error", message: "hello already received" }))
            return
          }

          const child = yield* Scope.fork(root, ExecutionStrategy.sequential)
          const subscription = yield* Scope.extend(hub.subscribe(frame.client), child).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                socket.write(encodeAttachFrame({ _tag: "error", message: error.message }))
                socket.end()
              }).pipe(Effect.flatMap(() => Effect.fail(error))),
            ),
          )
          state.client = frame.client
          state.scope = child
          yield* runClient(frame.client, Stream.runForEach(subscription.frames, (outgoing) =>
            Effect.sync(() => {
              // A negative write means the peer is closed or its kernel buffer
              // is full. The queue remains bounded; drain-aware socket writing
              // is the next transport hardening slice.
              socket.write(encodeAttachFrame(outgoing))
            }),
          ))
          return
        }

        if (!state.client) {
          socket.write(encodeAttachFrame({ _tag: "error", message: "hello is required first" }))
          socket.end()
          return
        }

        if (frame._tag === "ping") {
          socket.write(encodeAttachFrame({ _tag: "pong", nonce: frame.nonce }))
          return
        }

        if (isClientFrame(frame)) yield* options.onFrame?.(state.client, frame) ?? Effect.void
      })

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
              },
              data(socket, data) {
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
            },
          }),
        catch: (error) => new AttachServerError(String(error)),
      }),
      (server) => Effect.sync(() => server.stop(true)),
    )

    return listener
  })
