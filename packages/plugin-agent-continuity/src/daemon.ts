import { Effect } from "effect";
import {
  ForeignHarnessAdaptersTag,
  definePlugin,
  registerForeignHarnessAdapter,
  type PluginDefinition,
} from "@danielfgray/amux";
import { adapters } from "./adapters/index.ts";

/**
 * Daemon-side registration of foreign harness resume adapters. Restore planning
 * consults this registry; without it, persisted session refs yield no plan.
 */
export const agentContinuityDaemonPlugin: PluginDefinition = definePlugin({
  id: "amux.agent-continuity.daemon",
  inject: [ForeignHarnessAdaptersTag],
  effect: () =>
    Effect.gen(function* () {
      for (const adapter of adapters) yield* registerForeignHarnessAdapter(adapter);
    }),
});

export default agentContinuityDaemonPlugin;
