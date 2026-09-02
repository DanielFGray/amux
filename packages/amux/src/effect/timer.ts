import { Effect, Schedule } from "effect";

/**
 * A periodic callback whose timer is owned by the fiber that runs this effect:
 * interrupting the fiber, or closing the scope that holds it, clears the timer.
 *
 * Deliberately a platform timer rather than `Effect.repeat(_, Schedule)` or a
 * sleep loop. The UI's poll is the one loop that must cost nothing while the
 * user is not doing anything, and on Bun a scheduled *fiber* wakeup in an
 * otherwise idle process is 20-50x dearer than a timer callback — measured on
 * an empty process at 2Hz: 0.34% CPU for setInterval against 1.0-1.8% for
 * Effect.forever/Schedule.spaced/Schedule.fixed. Worse, the fiber's cost per
 * wakeup GROWS with the gap between wakeups (each long gap buys JSC a full GC
 * cycle a tighter cadence keeps amortised), so slowing the poll down to save
 * work spends more of it, not less.
 */
export function scheduledPoll(intervalMs: number, run: () => void): Effect.Effect<void> {
  return Effect.repeat(
    Effect.sleep(intervalMs).pipe(Effect.andThen(Effect.sync(run))),
    Schedule.forever,
  ).pipe(Effect.asVoid);
}
