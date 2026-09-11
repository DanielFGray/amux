import type { Layer } from "effect";
import { Effect, Exit, ManagedRuntime, Scope, Stream } from "effect";
import type { Accessor } from "solid-js";
import { createSignal, onCleanup } from "solid-js";

/**
 * Build a `ManagedRuntime` parented to a `Scope`: the runtime, and every
 * service's finalizer in `layer`, disposes when the scope closes. The Scope
 * is always the parent (decision 3 of ep-6e69df): a plugin's own Scope
 * acquires its Solid root through this, so disabling the plugin -- closing
 * its Scope -- is what disposes the runtime and, in turn, unmounts the UI.
 *
 * Pass `parent` to share its `MemoMap`: layers common to both runtimes are
 * built once and refcounted by Effect itself, so a service used by both an
 * ancestor and a descendant runtime is finalized only when the last runtime
 * holding it disposes.
 */
export function createRuntime<R>(
  layer: Layer.Layer<R>,
  parent?: ManagedRuntime.ManagedRuntime<any, never>,
): Effect.Effect<ManagedRuntime.ManagedRuntime<R, never>, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => ManagedRuntime.make(layer, parent && { memoMap: parent.memoMap })),
    (runtime) => Effect.promise(() => runtime.dispose()),
  );
}

/**
 * A signal writable only from inside the Scope that acquired it. The
 * low-level primitive the Solid/Effect bridge is built from: the Scope owns
 * the signal, a fiber forked within that Scope writes into it, and Solid
 * components only ever read the `Accessor` half. Components import no
 * Effect -- see `fromStream` for the component-facing wrapper.
 */
export function scopedSignal<A>(
  initial: A,
): Effect.Effect<readonly [Accessor<A>, (next: A | ((prev: A) => A)) => void], never, Scope.Scope> {
  return Effect.sync(() => createSignal(initial));
}

/** Empty context for Solid↔Effect bridge exits (`Scope.close` is `R = never`). */
const bridgeRuntime = Effect.runSync(Effect.context<never>());
const runBridgeFork = Effect.runForkWith(bridgeRuntime);
const runBridgeSync = Effect.runSyncWith(bridgeRuntime);

/**
 * Run `effect` in a freshly acquired Scope that closes on the calling
 * component's Solid cleanup. The one place in this module where an
 * `onCleanup` is allowed to drive an Effect lifetime -- every other pane
 * view gets that behavior for free through `fromStream` instead of writing
 * `onCleanup(() => Effect.runFork(...))` itself.
 */
function runScoped<A>(effect: Effect.Effect<A, never, Scope.Scope>): A {
  const scope = Scope.makeUnsafe();
  const result = runBridgeSync(Scope.provide(effect, scope));
  onCleanup(() => void runBridgeFork(Scope.close(scope, Exit.void)));
  return result;
}

/**
 * Fold a Stream into a Solid `Accessor`, one Solid signal update per stream
 * event. The stream is run on a fiber forked into a Scope that this
 * component owns for its whole lifetime; the fiber is interrupted when the
 * component unmounts. `f` may perform side effects (e.g. appending to a
 * retained model) -- its return value becomes the signal's next value.
 */
export function fromStream<A, B>(
  stream: Stream.Stream<A, never, never>,
  initial: B,
  f: (acc: B, value: A) => B,
): Accessor<B> {
  return runScoped(
    Effect.gen(function* () {
      const [get, set] = yield* scopedSignal(initial);
      yield* Effect.forkScoped(
        stream.pipe(Stream.runForEach((value) => Effect.sync(() => set((acc) => f(acc, value))))),
      );
      return get;
    }),
  );
}
