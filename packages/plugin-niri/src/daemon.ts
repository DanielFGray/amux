import {
  definePlugin,
  registerLayoutKindSchema,
  registerTilingAlgorithm,
  TilingAlgorithmsTag,
  type PluginDefinition,
} from "@danielfgray/amux";
import { Effect, Schema as S } from "effect";
import { niriTilingAlgorithm } from "./niri.ts";

const NiriArrangementSchema = S.Struct({
  offset: S.Finite,
  sizes: S.Array(S.Finite),
  // Optional so strips saved before per-column active landed still decode;
  // arrangementOf fills missing entries from each column's top pane.
  active: S.optional(S.Array(S.String)),
  // Viewport cols sizes were last resolved against — optional for older strips.
  basisCols: S.optional(S.Finite),
});

export const niriDaemonPlugin: PluginDefinition = definePlugin({
  id: "amux.tiling.niri.daemon",
  inject: [TilingAlgorithmsTag],
  effect: () =>
    Effect.gen(function* () {
      yield* registerTilingAlgorithm({
        priority: 0,
        selector: (ctx) => ctx.selectedId === niriTilingAlgorithm.id,
        algorithm: niriTilingAlgorithm,
      });
      yield* registerLayoutKindSchema("scroll", NiriArrangementSchema);
    }),
});

export default niriDaemonPlugin;
