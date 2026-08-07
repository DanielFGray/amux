import { Effect, Queue, Ref, Schema as S, Scope, Stream } from "effect";
import { encodeAttachFrame, type AttachFrame } from "./AttachProtocol.ts";

const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

interface QueuedFrame {
  readonly frame: AttachFrame;
  readonly bytes: Uint8Array;
}

const queuedFrame = (frame: AttachFrame): QueuedFrame => ({
  frame,
  bytes: encoder.encode(encodeAttachFrame(frame)),
});

export class AttachHubError extends S.TaggedError<AttachHubError>()("AttachHubError", {
  message: S.String,
}) {}

export interface AttachSubscription {
  readonly client: string;
  readonly frames: Stream.Stream<AttachFrame>;
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
    const clients = yield* Ref.make<
      ReadonlyMap<
        string,
        {
          connection: string;
          queue: Queue.Queue<QueuedFrame>;
          pendingBytes: number;
          replaying: boolean;
          replayPending: number;
          replayLock: Effect.Semaphore;
          deferred: QueuedFrame[];
          deferredBytes: number;
          onOverflow?: () => void;
        }
      >
    >(new Map());

    const subscribe = (
      client: string,
      connection = "",
      onOverflow?: () => void,
    ): Effect.Effect<AttachSubscription, AttachHubError, Scope.Scope> =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<QueuedFrame>(256);
        const replayLock = yield* Effect.makeSemaphore(1);
        const registered = yield* Ref.modify(clients, (current) => {
          if (current.has(client)) {
            return [false, current] as const;
          }
          const next = new Map(current);
          next.set(client, {
            connection,
            queue,
            pendingBytes: 0,
            replaying: false,
            replayPending: 0,
            replayLock,
            deferred: [],
            deferredBytes: 0,
            onOverflow,
          });
          return [true, next] as const;
        });

        if (!registered) {
          yield* Queue.shutdown(queue);
          return yield* new AttachHubError({ message: `client '${client}' is already attached` });
        }

        yield* Effect.addFinalizer(() =>
          Queue.shutdown(queue).pipe(
            Effect.zipRight(
              Ref.update(clients, (current) => {
                const next = new Map(current);
                if (next.get(client)?.queue === queue) next.delete(client);
                return next;
              }),
            ),
          ),
        );

        const target = (yield* Ref.get(clients)).get(client)!;
        return {
          client,
          frames: Stream.fromQueue(queue).pipe(
            Stream.mapEffect((frame) =>
              Effect.sync(() => {
                target.pendingBytes -= frame.bytes.byteLength;
                return frame.frame;
              }),
            ),
          ),
        };
      });

    const evict = (
      client: string,
      target: { queue: Queue.Queue<QueuedFrame>; onOverflow?: () => void },
    ): Effect.Effect<void> =>
      Queue.shutdown(target.queue).pipe(
        Effect.zipRight(
          Ref.update(clients, (current) => {
            const next = new Map(current);
            if (next.get(client)?.queue === target.queue) next.delete(client);
            return next;
          }),
        ),
        Effect.tap(() => Effect.sync(() => target.onOverflow?.())),
      );

    const publish = Effect.fnUntraced(function* (frame: AttachFrame) {
      const queues = yield* Ref.get(clients);
      const item = queuedFrame(frame);
      const size = item.bytes.byteLength;
      for (const [client, target] of queues) {
        if (target.replaying || target.replayPending > 0) {
          if (target.pendingBytes + target.deferredBytes + size <= MAX_PENDING_BYTES) {
            target.deferred.push(item);
            target.deferredBytes += size;
            continue;
          }
        }
        if (target.pendingBytes + size <= MAX_PENDING_BYTES && target.queue.unsafeOffer(item)) {
          target.pendingBytes += size;
          continue;
        }
        yield* evict(client, target);
      }
    });

    /**
     * Send a frame to one client's queue only.
     *
     * The replay an adopting client asks for belongs to it alone: broadcasting
     * it would rewind every other client's view of the same session. Offering
     * to a specific queue keeps the frame ordered against that client's live
     * output, which is exactly what a full-state replay needs.
     */
    const publishTo = Effect.fnUntraced(function* (
      client: string,
      connection: string,
      frame: AttachFrame,
    ) {
      const target = (yield* Ref.get(clients)).get(client);
      if (!target || target.connection !== connection) return;
      const item = queuedFrame(frame);
      const size = item.bytes.byteLength;
      if (target.pendingBytes + size > MAX_PENDING_BYTES || !target.queue.unsafeOffer(item)) {
        yield* evict(client, target);
      } else target.pendingBytes += size;
    });

    const beginReplay = Effect.fnUntraced(function* (client: string, connection: string) {
      const target = (yield* Ref.get(clients)).get(client);
      if (target?.connection !== connection) return;
      target.replayPending += 1;
      yield* target.replayLock.take(1);
      target.replaying = true;
    });

    const endReplay = Effect.fnUntraced(function* (client: string, connection: string) {
      const target = (yield* Ref.get(clients)).get(client);
      if (!target || target.connection !== connection || !target.replaying) return;
      const size = target.deferredBytes;
      const frames = target.deferred;
      target.replayPending = Math.max(0, target.replayPending - 1);
      if (target.replayPending > 0) {
        yield* target.replayLock.release(1);
        return;
      }
      target.replaying = false;
      target.deferred = [];
      target.deferredBytes = 0;
      if (
        target.pendingBytes + size > MAX_PENDING_BYTES ||
        !frames.every((item) => target.queue.unsafeOffer(item))
      ) {
        yield* evict(client, target);
      } else target.pendingBytes += size;
      yield* target.replayLock.release(1);
    });

    return { subscribe, publish, publishTo, beginReplay, endReplay };
  }),
}) {}
