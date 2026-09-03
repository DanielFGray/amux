/**
 * The amux plugin API: everything a plugin needs to be a plugin, and nothing else.
 *
 * This is the surface the host registers under the specifier `amux`, so it is
 * also the only thing a plugin file outside this repo can name. Adding to it is
 * a promise; the surface is deliberately narrow and grows only when a real
 * consumer justifies a specific name.
 *
 * Two neighbours deliberately excluded:
 * - Test helpers live behind `@danielfgray/amux/testing`. A plugin author must
 *   not meet them on the authoring path.
 * - The attach wire format lives behind `@danielfgray/amux/protocol`. A plugin
 *   that decodes frames is reading the transport, not writing a plugin.
 */

// The shape of a plugin, and how one is declared.
export {
  definePlugin,
  type PluginDefinition,
  type PluginHostContext,
  type PluginKV,
  type PluginKVKey,
  type PluginSettingsSection,
  type PluginStatus,
  type PluginErrorEvent,
  type PluginErrorPhase,
  type SpawnProvider,
} from "./plugin/types.ts";

// The registries a plugin contributes to. Each is acquired through
// `CurrentPlugin` and a `Scope`, so disabling a plugin is releasing its scope.
export {
  CurrentPlugin,
  RegionsTag,
  SessionViewsTag,
  ProcessDisplayTag,
  BindingsTag,
  SettingsTag,
  OptionsTag,
  SpawnProvidersTag,
  CommandsTag,
  SessionFactsTag,
  PanelTag,
  SessionStreamTag,
  CliCommandsTag,
  intercept,
  registerCommand,
  type CommandRegistration,
  type CliCommandRegistration,
  type CliCommandsService,
  type RegistryService,
  type PluginService,
  type PluginDependency,
  type InterceptedDependency,
  type InterceptablePluginService,
  type ServiceInterception,
  type SessionStreamService,
} from "./plugin/services.ts";

export {
  type ForegroundProcessFact,
  type SessionFact,
  type SessionFactsInvalidation,
  type SessionFactsObservation,
  type SessionFactsService,
  type SessionFactsSnapshot,
} from "./session-facts.ts";
export { type ScreenRegion } from "./screen-regions.ts";

// Commands: constructing one, and the failure a handler reports.
export {
  command,
  CommandError,
  type Command,
  type CommandTag,
  type CommandOf,
  type CommandResult,
} from "./commands.ts";

// Where a panel can be put, and what it is told about where it landed.
export {
  type Region,
  type Anchor,
  type DockSlot,
  type SlotName,
  type DockSlotProps,
  type OverlaySlotProps,
  type FloatSlotProps,
  type Panel,
  type DockPanel,
  type OverlayPanel,
  type FloatPanel,
} from "./ui/regions.tsx";

// What a panel is handed at render time.
export { type PanelContext, type SidebarDisplay, type SidebarDisplayRow } from "./ui/panel.ts";

// What a plugin-owned pane is handed.
export { type PaneViewProps } from "./component-pane.tsx";

// What a process-display contribution is asked, and what it may answer.
export { type ProcessDisplayFacts, type ProcessDisplayResult } from "./plugin/process-display.ts";

// Options a plugin declares, reads, or edits.
export {
  resolveOptions,
  coerceOption,
  type OptionSpec,
  type OptionValue,
  type OptionName,
  type OptionDeltas,
} from "./options.ts";

// The vocabulary of what a session is doing. Four consumers share it — the most
// widely held type in the repo.
export { ProcessState, ProcessStateSchema, isProcessState } from "./process-state.ts";
export { ProcessStateAuthority, type ProcessStateSource } from "./process-state-arbiter.ts";

// The pieces of the layout a plugin reads or describes. The layout algebra
// itself — splitting, collapsing, appending — stays in core.
export {
  type JsonValue,
  type PaneContent,
  type PaneRef,
  type LayoutPane,
  type Placement,
  type DockSide,
} from "./layout.ts";

// Drawing.
export { theme } from "./ui/theme.ts";
export { POLL_MS } from "./ui/state.ts";
