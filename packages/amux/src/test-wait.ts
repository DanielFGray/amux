/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { Clock, Effect } from "effect";

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * `waitFor`'s Effect-native counterpart, for a test that asserts on daemon
 * state reached over a real socket: the round trip settles asynchronously, so
 * a fixed sleep before asserting only holds up on a quiet machine. Accepts a
 * plain boolean, a Promise, or an Effect, so a predicate can read daemon
 * state directly (`daemon.getAttachedClient`) without a wrapping
 * `Effect.runPromise` that would run a child Effect outside the surrounding
 * services.
 */
export const until = <E = never>(
  predicate: () => boolean | Promise<boolean> | Effect.Effect<boolean, E>,
  what: string,
  timeoutMs = 5_000,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const result = predicate();
      const ok = Effect.isEffect(result)
        ? yield* result
        : yield* Effect.promise(async () => result);
      if (ok) return;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`));
  });
