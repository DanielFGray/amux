import {
  definePlugin,
  registerLayoutKindSchema,
  registerTilingAlgorithm,
  TilingAlgorithmsTag,
  type PluginDefinition,
} from "@danielfgray/amux";
import { Effect, Schema as S } from "effect";
import { niriTilingAlgorithm, type NiriArrangement } from "./niri.ts";

const NiriArrangementSchema = S.Struct({
  offset: S.Finite,
  sizes: S.Array(S.Finite),
}) satisfies S.Schema<NiriArrangement>;

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
