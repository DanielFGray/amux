import { Effect, Queue, Ref, Schema as S, Scope, Stream } from "effect"
import { type AttachFrame } from "./AttachProtocol.ts"

export class AttachHubError extends S.TaggedError<AttachHubError>()("AttachHubError", {
  message: S.String,
}) {}

export interface AttachSubscription {
  readonly client: string
  readonly frames: Stream.Stream<AttachFrame>
}

/**
 * Scoped fan-out for attach clients.
 *
 * Each client gets a bounded backpressured queue. A slow client therefore
 * slows publication instead of silently losing terminal output; the socket
 * writer is responsible for draining the queue at wire speed.
 */
export class AttachHub extends Effect.Service<AttachHub>()("AttachHub", {
  effect: Effect.gen(function* () {
    const clients = yield* Ref.make<ReadonlyMap<string, Queue.Queue<AttachFrame>>>(new Map())

    const subscribe = (client: string): Effect.Effect<AttachSubscription, AttachHubError, Scope.Scope> =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<AttachFrame>(256)
        const registered = yield* Ref.modify(clients, (current) => {
          if (current.has(client)) {
            return [false, current] as const
          }
          const next = new Map(current)
          next.set(client, queue)
          return [true, next] as const
        })

        if (!registered) {
          yield* Queue.shutdown(queue)
          return yield* Effect.fail(new AttachHubError({ message: `client '${client}' is already attached` }))
        }

        yield* Effect.addFinalizer(() =>
          Queue.shutdown(queue).pipe(
            Effect.zipRight(
              Ref.update(clients, (current) => {
                const next = new Map(current)
                next.delete(client)
                return next
              }),
            ),
          ),
        )

        return {
          client,
          frames: Stream.fromQueue(queue),
        }
      })

    const publish = (frame: AttachFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        const queues = yield* Ref.get(clients)
        yield* Effect.forEach(queues.values(), (queue) => Queue.offer(queue, frame), { discard: true })
      })

    /**
     * Send a frame to one client's queue only.
     *
     * The replay an adopting client asks for belongs to it alone: broadcasting
     * it would rewind every other client's view of the same agent. Offering to
     * a specific queue keeps the frame ordered against that client's live
     * output, which is exactly what a full-state replay needs.
     */
    const publishTo = (client: string, frame: AttachFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        const queue = (yield* Ref.get(clients)).get(client)
        if (!queue) return
        yield* Queue.offer(queue, frame)
      })

    return { subscribe, publish, publishTo }
  }),
}) {}
