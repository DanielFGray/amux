import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { CommandError, CurrentInvocation } from "../commands.ts";
import type { CommandSpec } from "../bindings.ts";
import { getProcessPlugin, listProcessPlugins, type ProcessPluginRoots } from "./registry.ts";
import type { LinkedProcessPluginInfo } from "./registry.ts";

type Fs = FileSystem.FileSystem | Path.Path;

export interface ProcessPluginBindingRunners {
  readonly runAction: (
    pluginId: string,
    actionId: string,
  ) => Effect.Effect<unknown, CommandError, CurrentInvocation>;
  readonly runPane: (
    pluginId: string,
    entrypointId: string,
  ) => Effect.Effect<unknown, CommandError, CurrentInvocation>;
}

/** Binding name for one linked action — opaque; args live in `run`. */
export function processPluginActionBindingName(pluginId: string, actionId: string): string {
  return `process-plugin.action.${pluginId}.${actionId}`;
}

/** Binding name for one linked pane entrypoint. */
export function processPluginPaneBindingName(pluginId: string, entrypointId: string): string {
  return `process-plugin.pane.${pluginId}.${entrypointId}`;
}

/**
 * Build palette/keybind CommandSpecs from linked manifests.
 * Unbound by default — users assign keys in settings like any other command.
 */
export function processPluginBindingSpecs(
  plugins: readonly LinkedProcessPluginInfo[],
  runners: ProcessPluginBindingRunners,
): CommandSpec[] {
  const specs: CommandSpec[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    for (const action of plugin.manifest.actions) {
      const pluginId = plugin.pluginId;
      const actionId = action.id;
      specs.push({
        name: processPluginActionBindingName(pluginId, actionId),
        desc: `${plugin.name}: ${action.title}`,
        group: "process-plugin",
        run: runners.runAction(pluginId, actionId),
      });
    }
    for (const pane of plugin.manifest.panes) {
      const pluginId = plugin.pluginId;
      const entrypointId = pane.id;
      specs.push({
        name: processPluginPaneBindingName(pluginId, entrypointId),
        desc: `${plugin.name}: ${pane.title}`,
        group: "process-plugin",
        run: runners.runPane(pluginId, entrypointId),
      });
    }
  }
  return specs;
}

/** Load enabled linked plugins (re-read each manifest) and build binding specs. */
export const loadProcessPluginBindingSpecs = (
  runners: ProcessPluginBindingRunners,
  options: { readonly roots?: ProcessPluginRoots } = {},
): Effect.Effect<readonly CommandSpec[], never, Fs> =>
  Effect.gen(function* () {
    const listed = yield* listProcessPlugins(options).pipe(Effect.orElseSucceed(() => []));
    const plugins: LinkedProcessPluginInfo[] = [];
    for (const entry of listed) {
      if (!entry.enabled) continue;
      const info = yield* getProcessPlugin(entry.pluginId, options).pipe(
        Effect.orElseSucceed(() => null as LinkedProcessPluginInfo | null),
      );
      if (info !== null) plugins.push(info);
    }
    return processPluginBindingSpecs(plugins, runners);
  });
