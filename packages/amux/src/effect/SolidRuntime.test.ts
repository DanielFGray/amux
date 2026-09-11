import { expect } from "bun:test";
import { createRoot, createSignal, createEffect, on } from "solid-js";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { createRuntime } from "./SolidRuntime.ts";
import { testEffect } from "../test-effect.ts";

testEffect(
  "runtime finalizer runs when its scope closes, not before",
  Effect.callback<void, string>((resume) => {
    let finalized = false;
    const layer = Layer.effectDiscard(
      Effect.addFinalizer(() => Effect.sync(() => (finalized = true))),
    );
    const [mounted, setMounted] = createSignal(true);

    createRoot((dispose) => {
      let ran = Promise.resolve();
      let scope: Scope.Closeable | undefined;
      createEffect(
        on(mounted, (isMounted) => {
          if (isMounted) {
            scope = Scope.makeUnsafe();
            ran = Effect.runPromise(
              Effect.provideService(createRuntime(layer), Scope.Scope, scope).pipe(
                Effect.flatMap((runtime) => Effect.promise(() => runtime.runPromise(Effect.void))),
              ),
            );
          }
        }),
      );
      ran.then(() => {
        try {
          expect(finalized).toBe(false);
          setMounted(false);
          dispose();
          Effect.runFork(Scope.close(scope!, Exit.void));
          expect(finalized).toBe(true);
          resume(Effect.void);
        } catch (error) {
          resume(Effect.fail(String(error)));
        }
      });
    });
  }),
);

testEffect(
  "nested runtime sharing a parent's MemoMap builds a common layer once",
  Effect.callback<void, string>((resume) => {
    let builds = 0;
    class Shared extends Context.Service<Shared, { readonly n: number }>()(
      "amux/effect/SolidRuntime.test/Shared",
    ) {
      static readonly layer = Layer.effect(
        Shared,
        Effect.sync(() => ({ n: ++builds })),
      );
    }

    const scope = Scope.makeUnsafe();
    Effect.runPromise(
      Effect.provideService(
        Effect.gen(function* () {
          const parent = yield* createRuntime(Shared.layer);
          const child = yield* createRuntime(Shared.layer, parent);
          yield* Effect.promise(() =>
            Promise.all([parent.runPromise(Shared), child.runPromise(Shared)]),
          );
        }),
        Scope.Scope,
        scope,
      ),
    ).then(() => {
      try {
        Effect.runFork(Scope.close(scope, Exit.void));
        expect(builds).toBe(1);
        resume(Effect.void);
      } catch (error) {
        resume(Effect.fail(String(error)));
      }
    });
  }),
);
