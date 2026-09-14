/**
 * Daemon-side admission for plugin publication: invocations bind while a
 * publish is not in progress; publish waits until active admissions drain.
 *
 * Not a Semaphore: Effect's Semaphore wakes every waiter on release and cannot
 * keep new readers out behind a waiting publisher.
 */
import { Duration, Effect, Exit, Option, Schema as S, Stream, SubscriptionRef } from "effect";
import { PLUGIN_SESSION_RUN_TIMEOUT_MS } from "./plugin-behaviour.ts";

export class PluginPublishTimedOut extends S.TaggedError<PluginPublishTimedOut>()(
  "PluginPublishTimedOut",
  { waitedMs: S.Finite },
) {
  /** Derived from waitedMs — the string boundaries (ControlError / DaemonError) read. */
  override get message(): string {
    return `plugin publish timed out after ${this.waitedMs}ms`;
  }
}

export interface PublicationGateState {
  readonly active: number;
  readonly publishing: boolean;
  /** One publisher holds the serialize slot from prepare through reopen. */
  readonly publisher: boolean;
}

export interface PublicationGate {
  /**
   * Wait while publishing, then count this invocation as active for the whole
   * lifetime of `effect` (success, failure, or interruption).
   */
  readonly admit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Claim the publisher slot (wait while another holds it). Run `prepare` while
   * admissions still flow, then set publishing, drain active, run
   * `publish(prepared)`, and reopen. The slot is released on every exit. On
   * timeout/failure/interruption after publishing is set, runs `discard` and
   * reopens.
   */
  readonly withPublish: <P, A, E, R>(
    prepare: Effect.Effect<P, E, R>,
    publish: (prepared: P) => Effect.Effect<A, E, R>,
    discard: Effect.Effect<void, never, R>,
  ) => Effect.Effect<A, E | PluginPublishTimedOut, R>;
}

export const makePublicationGate = Effect.fnUntraced(function* () {
  const state = yield* SubscriptionRef.make<PublicationGateState>({
    active: 0,
    publishing: false,
    publisher: false,
  });

  const waitUntil = (predicate: (s: PublicationGateState) => boolean) =>
    SubscriptionRef.changes(state).pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain);

  const releaseAdmission = SubscriptionRef.update(state, (current) => ({
    ...current,
    active: Math.max(0, current.active - 1),
  }));

  const acquireAdmission = Effect.gen(function* () {
    yield* waitUntil((s) => !s.publishing);
    for (;;) {
      const admitted = yield* SubscriptionRef.modify(state, (current) => {
        if (current.publishing) return [false, current];
        return [true, { ...current, active: current.active + 1 }];
      });
      if (admitted) return;
      yield* waitUntil((s) => !s.publishing);
    }
  });

  const admit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(acquireAdmission);
        const exit = yield* restore(effect).pipe(Effect.exit);
        yield* releaseAdmission;
        return yield* Exit.isFailure(exit)
          ? Exit.failCause(exit.cause)
          : Effect.succeed(exit.value);
      }),
    );

  const claimPublisher = Effect.gen(function* () {
    yield* waitUntil((s) => !s.publisher);
    for (;;) {
      const claimed = yield* SubscriptionRef.modify(state, (current) => {
        if (current.publisher) return [false, current];
        return [true, { ...current, publisher: true }];
      });
      if (claimed) return;
      yield* waitUntil((s) => !s.publisher);
    }
  });

  const releasePublisher = SubscriptionRef.update(state, (current) => ({
    ...current,
    publishing: false,
    publisher: false,
  }));

  const withPublish = <P, A, E, R>(
    prepare: Effect.Effect<P, E, R>,
    publish: (prepared: P) => Effect.Effect<A, E, R>,
    discard: Effect.Effect<void, never, R>,
  ): Effect.Effect<A, E | PluginPublishTimedOut, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(claimPublisher);
        const exit = yield* Effect.gen(function* () {
          const prepared = yield* restore(prepare);
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            publishing: true,
          }));
          const drained = yield* restore(
            waitUntil((s) => s.active === 0).pipe(
              Effect.timeoutOption(Duration.millis(PLUGIN_SESSION_RUN_TIMEOUT_MS)),
            ),
          );
          if (Option.isNone(drained)) {
            return yield* new PluginPublishTimedOut({
              waitedMs: PLUGIN_SESSION_RUN_TIMEOUT_MS,
            });
          }
          return yield* restore(publish(prepared));
        }).pipe(Effect.exit);

        if (Exit.isFailure(exit)) {
          yield* discard;
          yield* releasePublisher;
          return yield* Exit.failCause(exit.cause);
        }
        yield* releasePublisher;
        return exit.value;
      }),
    );

  return { admit, withPublish } satisfies PublicationGate;
});
