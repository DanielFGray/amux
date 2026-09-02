import { expect } from "bun:test";
import { createRoot, createSignal, createEffect, on } from "solid-js";
import { Context, Effect, Layer } from "effect";
import { createRuntime } from "./SolidRuntime.ts";
import { testEffect } from "../test-effect.ts";

testEffect(
  "runtime finalizer runs when the owning computation cleans up, not before",
  Effect.callback<void, unknown>((resume) => {
    let finalized = false;
    const layer = Layer.effectDiscard(
      Effect.addFinalizer(() => Effect.sync(() => (finalized = true))),
    );
    const [mounted, setMounted] = createSignal(true);

    createRoot((dispose) => {
      let ran = Promise.resolve();
      createEffect(
        on(mounted, (isMounted) => {
          if (isMounted) ran = createRuntime(layer).runPromise(Effect.void);
        }),
      );
      ran.then(() => {
        try {
          expect(finalized).toBe(false);
          setMounted(false);
          dispose();
          expect(finalized).toBe(true);
          resume(Effect.void);
        } catch (error) {
          resume(Effect.fail(error));
        }
      });
    });
  }),
);

testEffect(
  "nested runtime sharing a parent's MemoMap builds a common layer once",
  Effect.callback<void, unknown>((resume) => {
    let builds = 0;
    class Shared extends Context.Service<Shared, { readonly n: number }>()(
      "amux/effect/SolidRuntime.test/Shared",
    ) {
      static readonly layer = Layer.effect(
        Shared,
        Effect.sync(() => ({ n: ++builds })),
      );
    }

    createRoot((dispose) => {
      const parent = createRuntime(Shared.layer);
      const child = createRuntime(Shared.layer, parent);
      Promise.all([parent.runPromise(Shared), child.runPromise(Shared)]).then(() => {
        try {
          dispose();
          expect(builds).toBe(1);
          resume(Effect.void);
        } catch (error) {
          resume(Effect.fail(error));
        }
      });
    });
  }),
);
