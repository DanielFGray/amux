import {
  definePlugin,
  registerTilingAlgorithm,
  TilingAlgorithmsTag,
  type PluginDefinition,
} from "@danielfgray/amux";
import { niriTilingAlgorithm } from "./niri.ts";

export const niriDaemonPlugin: PluginDefinition = definePlugin({
  id: "amux.tiling.niri.daemon",
  inject: [TilingAlgorithmsTag],
  effect: () =>
    registerTilingAlgorithm({
      algorithm: niriTilingAlgorithm,
    }),
});

export default niriDaemonPlugin;
