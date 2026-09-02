import { test, type TestOptions } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>);

const toEffect = <A, E, R>(value: Body<A, E, R>) =>
  Effect.suspend(() => (typeof value === "function" ? value() : value));

/** Run an effect to its exit, deconstructing a failure into pretty error lines. */
const scopedRun = <A, E, R, E2>(
  value: Body<A, E, R | Scope.Scope>,
  layer: Layer.Layer<R, E2, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const exit = yield* toEffect(value).pipe(Effect.provide(layer), Effect.scoped, Effect.exit);
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err);
      }
    }
    return yield* exit;
  }).pipe(Effect.runPromise);

const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer());
const liveEnv = TestConsole.layer;
const defaultOptions = { timeout: 30_000 } satisfies TestOptions;
const optionsOrDefault = (opts?: number | TestOptions) => opts ?? defaultOptions;

export interface BoundEffectTests<R> {
  <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions): void;
  only: <A, E2>(
    name: string,
    value: Body<A, E2, R | Scope.Scope>,
    opts?: number | TestOptions,
  ) => void;
  skip: <A, E2>(
    name: string,
    value: Body<A, E2, R | Scope.Scope>,
    opts?: number | TestOptions,
  ) => void;
}

export interface TestEffectSet<R> {
  /** Runs on TestClock + TestConsole. */
  effect: BoundEffectTests<R>;
  /** Runs on the real clock (TestConsole only). */
  live: BoundEffectTests<R>;
}

const bound = <R, E>(layer: Layer.Layer<R, E, Scope.Scope>): BoundEffectTests<R> => {
  const run = <A, E2>(
    name: string,
    value: Body<A, E2, R | Scope.Scope>,
    opts?: number | TestOptions,
  ) => test(name, () => scopedRun(value, layer), optionsOrDefault(opts));
  const only = <A, E2>(
    name: string,
    value: Body<A, E2, R | Scope.Scope>,
    opts?: number | TestOptions,
  ) => test.only(name, () => scopedRun(value, layer), optionsOrDefault(opts));
  const skip = <A, E2>(
    name: string,
    value: Body<A, E2, R | Scope.Scope>,
    opts?: number | TestOptions,
  ) => test.skip(name, () => scopedRun(value, layer), optionsOrDefault(opts));
  return Object.assign(run, { only, skip });
};

const make = <R, E>(
  testLayer: Layer.Layer<R, E, Scope.Scope>,
  liveLayer: Layer.Layer<R, E, Scope.Scope>,
): TestEffectSet<R> => ({
  effect: bound(testLayer),
  live: bound(liveLayer),
});

/**
 * Bind a layer to effect test runners, in opencode's shape.
 *
 * `effect` runs on TestClock + TestConsole; `live` runs on the real clock.
 * Either returns an Effect written as `Effect.gen`, with the layer provided
 * for the entire test and its scope closed when the test completes. Failures
 * are deconstructed into pretty error lines so a failing Effect is readable.
 * Both sides expose `.only` and `.skip`.
 *
 * Prefer `live` for anything that depends on real time, the filesystem, child
 * processes, sockets, or other OS behaviour.
 */
export function testEffect<R, E>(layer: Layer.Layer<R, E, Scope.Scope>): TestEffectSet<R>;
/**
 * Run one effect in a scope that is closed when the test completes.
 *
 * The single-argument form, for tests that provide their own layer inside the
 * body rather than binding one at file scope.
 */
export function testEffect<A, E, R>(
  name: string,
  effect: Body<A, E, R | Scope.Scope>,
  opts?: number | TestOptions,
): void;
export function testEffect(
  nameOrLayer: string | Layer.Layer<any, any, Scope.Scope>,
  effect?: Body<unknown, unknown, any>,
  opts?: number | TestOptions,
): TestEffectSet<any> | void {
  if (typeof nameOrLayer === "string") {
    test(
      nameOrLayer,
      () => scopedRun(effect as Body<unknown, unknown, Scope.Scope>, Layer.empty),
      optionsOrDefault(opts),
    );
    return;
  }
  return make(Layer.provideMerge(nameOrLayer, testEnv), Layer.provideMerge(nameOrLayer, liveEnv));
}
