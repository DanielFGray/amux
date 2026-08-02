import { Effect, Queue, Ref, Schema as S, Scope, Stream } from "effect"
import { encodeAttachFrame, type AttachFrame } from "./AttachProtocol.ts"

const MAX_PENDING_BYTES = 4 * 1024 * 1024
const frameBytes = (frame: AttachFrame) => new TextEncoder().encode(encodeAttachFrame(frame)).byteLength

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
 * Each client gets a bounded queue. Offers are deliberately nonblocking: a
 * client whose socket cannot keep up is evicted rather than making a PTY
 * publisher wait behind it or silently dropping terminal bytes.
 */
export class AttachHub extends Effect.Service<AttachHub>()("AttachHub", {
  effect: Effect.gen(function* () {
    const clients = yield* Ref.make<ReadonlyMap<string, { connection: string; queue: Queue.Queue<AttachFrame>; pendingBytes: number; replaying: boolean; replayPending: number; replayLock: Effect.Semaphore; deferred: AttachFrame[]; deferredBytes: number; onOverflow?: () => void }>>(new Map())

    const subscribe = (client: string, connection = "", onOverflow?: () => void): Effect.Effect<AttachSubscription, AttachHubError, Scope.Scope> =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<AttachFrame>(256)
        const replayLock = yield* Effect.makeSemaphore(1)
        const registered = yield* Ref.modify(clients, (current) => {
          if (current.has(client)) {
            return [false, current] as const
          }
          const next = new Map(current)
          next.set(client, { connection, queue, pendingBytes: 0, replaying: false, replayPending: 0, replayLock, deferred: [], deferredBytes: 0, onOverflow })
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
                if (next.get(client)?.queue === queue) next.delete(client)
                return next
              }),
            ),
          ),
        )

        const target = (yield* Ref.get(clients)).get(client)!
        return {
          client,
          frames: Stream.fromQueue(queue).pipe(
            Stream.mapEffect((frame) => Effect.sync(() => {
              target.pendingBytes -= frameBytes(frame)
              return frame
            })),
          ),
        }
      })

    const publish = (frame: AttachFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        const queues = yield* Ref.get(clients)
        const size = frameBytes(frame)
        for (const [client, target] of queues) {
          if (target.replaying || target.replayPending > 0) {
            if (target.pendingBytes + target.deferredBytes + size <= MAX_PENDING_BYTES) {
              target.deferred.push(frame)
              target.deferredBytes += size
              continue
            }
          }
          if (target.pendingBytes + size <= MAX_PENDING_BYTES && target.queue.unsafeOffer(frame)) {
            target.pendingBytes += size
            continue
          }
          yield* Queue.shutdown(target.queue)
          yield* Ref.update(clients, (current) => {
            const next = new Map(current)
            if (next.get(client)?.queue === target.queue) next.delete(client)
            return next
          })
          target.onOverflow?.()
        }
      })

    /**
     * Send a frame to one client's queue only.
     *
     * The replay an adopting client asks for belongs to it alone: broadcasting
     * it would rewind every other client's view of the same session. Offering
     * to a specific queue keeps the frame ordered against that client's live
     * output, which is exactly what a full-state replay needs.
     */
    const publishTo = (client: string, connection: string, frame: AttachFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        const target = (yield* Ref.get(clients)).get(client)
        if (!target || target.connection !== connection) return
        const size = frameBytes(frame)
        if (target.pendingBytes + size > MAX_PENDING_BYTES || !target.queue.unsafeOffer(frame)) {
          yield* Queue.shutdown(target.queue)
          yield* Ref.update(clients, (current) => {
            const next = new Map(current)
            if (next.get(client)?.queue === target.queue) next.delete(client)
            return next
          })
          target.onOverflow?.()
        } else target.pendingBytes += size
      })

    const beginReplay = (client: string, connection: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const target = (yield* Ref.get(clients)).get(client)
        if (target?.connection !== connection) return
        target.replayPending += 1
        yield* target.replayLock.take(1)
        target.replaying = true
      })

    const endReplay = (client: string, connection: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const target = (yield* Ref.get(clients)).get(client)
        if (!target || target.connection !== connection || !target.replaying) return
        const size = target.deferredBytes
        const frames = target.deferred
        target.replayPending = Math.max(0, target.replayPending - 1)
        if (target.replayPending > 0) {
          yield* target.replayLock.release(1)
          return
        }
        target.replaying = false
        target.deferred = []
        target.deferredBytes = 0
        if (target.pendingBytes + size > MAX_PENDING_BYTES || !frames.every((item) => target.queue.unsafeOffer(item))) {
          yield* Queue.shutdown(target.queue)
          yield* Ref.update(clients, (current) => {
            const next = new Map(current)
            if (next.get(client)?.queue === target.queue) next.delete(client)
            return next
          })
          target.onOverflow?.()
        } else target.pendingBytes += size
        yield* target.replayLock.release(1)
      })

    return { subscribe, publish, publishTo, beginReplay, endReplay }
  }),
}) {}
