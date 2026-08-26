import { test } from "bun:test";
import { Effect } from "effect";
import type { Scope } from "effect/Scope";

/** Run an Effect test in a scope that is closed when the test completes. */
export function testEffect<A, E>(
  name: string,
  effect: Effect.Effect<A, E, Scope> | (() => Effect.Effect<A, E, Scope>),
): void {
  test(
    name,
    () => Effect.runPromise(Effect.scoped(typeof effect === "function" ? effect() : effect)),
    {
      timeout: 30_000,
    },
  );
}
