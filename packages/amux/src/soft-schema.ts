/**
 * Soft collections: each entry is decoded with its owner Schema; a failure
 * becomes a skipped entry rather than failing the whole collection
 * (hand-edited config / foreign catalog tolerance).
 */
import { Effect, Option, Schema as S, SchemaGetter } from "effect";

export function softArray<Item extends S.Top>(item: Item) {
  return S.Array(softItem(item)).pipe(
    S.decodeTo(S.mutable(S.Array(item)), {
      decode: SchemaGetter.transform((items: ReadonlyArray<Item["Type"] | null>) =>
        items.flatMap((entry) => (entry === null ? [] : [entry])),
      ),
      encode: SchemaGetter.transform((items: Item["Type"][]) => items),
    }),
  );
}

/** One entry that decodes to null instead of failing its collection. */
export function softItem<Item extends S.Top>(item: Item) {
  return S.Union([item, S.Null]).pipe(S.catchDecoding(() => Effect.succeed(Option.some(null))));
}
