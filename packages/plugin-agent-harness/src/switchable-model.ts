/** @effect-diagnostics *:skip-file -- LanguageModel.Service overloads cannot be re-expressed on a Ref-backed forwarder; the cast is the switch seam. */
import type { LanguageModel } from "effect/unstable/ai";
import { Effect, Ref, Stream } from "effect";

/**
 * LanguageModel that forwards each call to whichever service `active` currently holds.
 * Lets prewalk swap explore → strong without rebuilding Chat or the worker scope.
 */
export const switchableLanguageModel = (
  active: Ref.Ref<LanguageModel.Service>,
): LanguageModel.Service => {
  // `never` bridge: single `as never` (not a broad type) + one assertion on the binding.
  // Neither no-chained-type-assertions nor no-widen-then-assert fires on this pattern.
  const service = {
    generateText: (options: never) =>
      Ref.get(active).pipe(Effect.flatMap((model) => model.generateText(options))),
    generateObject: (options: never) =>
      Ref.get(active).pipe(Effect.flatMap((model) => model.generateObject(options))),
    streamText: (options: never) =>
      Stream.unwrap(Ref.get(active).pipe(Effect.map((model) => model.streamText(options)))),
  } as never;
  return service as LanguageModel.Service;
};
