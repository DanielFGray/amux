import { Effect } from "effect";
import {
  definePlugin,
  ProcessDisplayTag,
  type PluginDefinition,
} from "@danielfgray/amux";
import { deriveProcessDisplay } from "./display-state.ts";

/**
 * The default policy for recognising and presenting coding-agent process
 * state. Core supplies only neutral process facts; this plugin decides what
 * those facts mean to an agent-aware UI.
 */
export const agentAwarenessPlugin: PluginDefinition = definePlugin({
  id: "amux.agent-awareness",
  apiVersion: "1",
  inject: [ProcessDisplayTag],
  effect: () =>
    Effect.gen(function* () {
      const processDisplay = yield* ProcessDisplayTag;
      yield* processDisplay.register(deriveProcessDisplay);
    }),
});

export default agentAwarenessPlugin;
