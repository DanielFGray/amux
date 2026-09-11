import { Effect } from "effect";
import { definePlugin, type PluginDefinition } from "@danielfgray/amux";
import { CompletionSourcesTag, makeCompletionSources } from "./registry.ts";

export const COMPLETION_PLUGIN_ID = "amux.completion";

/**
 * The shared picker as a plugin: it owns the completion-source registry and
 * publishes it for others to register into. The picker UI itself
 * (`Picker.tsx`) renders in consumers — the inline menu inside chat and the
 * editor, the modal through each owner's overlay occupant — because only the
 * consumer's layout knows where a popup belongs.
 */
export const completionPlugin: PluginDefinition = definePlugin({
  id: COMPLETION_PLUGIN_ID,
  provide: [CompletionSourcesTag],
  effect: (ctx) =>
    Effect.sync(() => {
      ctx.provide(CompletionSourcesTag, makeCompletionSources());
    }).pipe(Effect.asVoid),
});

export default completionPlugin;
