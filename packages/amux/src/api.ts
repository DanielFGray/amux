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
  SlotsTag,
  SessionViewsTag,
  ProcessDisplayTag,
  BindingsTag,
  ContextsTag,
  SettingsTag,
  OptionsTag,
  SpawnProvidersTag,
  CommandsTag,
  SessionFactsTag,
  PanelTag,
  SessionStreamTag,
  RemoteEventsTag,
  CliCommandsTag,
  DaemonCommandsTag,
  TilingAlgorithmsTag,
  intercept,
  registerCommand,
  registerDaemonCommand,
  registerTilingAlgorithm,
  registerEnumValue,
  type CommandRegistration,
  type CliCommandRegistration,
  type CliCommandsService,
  type DaemonCommandRegistration,
  type DaemonCommandsService,
  type EnumValueRegistration,
  type TilingAlgorithmRegistration,
  type TilingAlgorithmsService,
  type DaemonSessionCommandContext,
  type RegistryService,
  type PluginService,
  type PluginDependency,
  type InterceptedDependency,
  type InterceptablePluginService,
  type ServiceInterception,
  type SessionStreamService,
  type RemoteEventsService,
} from "./plugin/services.ts";
export {
  ForeignHarnessAdaptersTag,
  ForeignHarnessAdapterTable,
  ForeignHarnessHookError,
  ForeignHarnessPlanResumeError,
  makeForeignHarnessAdapters,
  registerForeignHarnessAdapter,
  type ForeignHarnessAdapter,
  type ForeignHarnessAdapterLookup,
  type ForeignHarnessAdaptersService,
} from "./foreign-harness.ts";
export {
  planResumeWithForm,
  agentResumeDedupeKey,
  PLAN_RESUME_TIMEOUT_MS,
  askPlanResume,
  AgentResumePlanSchema,
  type AgentResumePlan,
  type ResumeArgvForm,
} from "./agent-resume.ts";
export {
  AgentSessionRefSchema,
  type AgentSessionRef,
  type AgentSessionRefKind,
  type OfficialAgentSource,
} from "./agent-session.ts";
export type { TilingAlgorithm, TilingAlgorithmMethods } from "./tiling-algorithm.ts";
export { tilingAlgorithmFromMethods, TilingAlgorithmError } from "./tiling-algorithm.ts";
export {
  TilingOperationSchema,
  TilingAnswerSchema,
  type TilingOperation,
  type TilingAnswer,
} from "./tiling-operation.ts";
export { defaultTilingAlgorithm, defaultTilingMethods } from "./tiling-algorithm-default.ts";
export {
  LayoutRuleSchema,
  LayoutRuleWhenSchema,
  resolveTilingAlgorithm,
  type LayoutRule,
  type LayoutRuleWhen,
  type LayoutElectionViewport,
} from "./layout-rules.ts";
export type { Meta } from "./commands.ts";
export type {
  CoreWorkspaceAction,
  WorkspaceSnapshot,
  PluginWorkspaceReducer,
  WorkspaceCommandContext,
} from "./workspace.ts";
export type { PermissionAnswer, JsonValue } from "./effect/AttachProtocol.ts";
export { JsonValueSchema } from "./effect/AttachProtocol.ts";
export {
  definePluginAction,
  preparePluginCommandApply,
  reducePluginCommand,
  workspaceTransactionPluginsFromRegistrations,
  WorkspaceTransactionError,
} from "./effect/WorkspaceTransaction.ts";
export type {
  PluginActionHandle,
  PluginActionRegistration,
  PreparedPluginCommand,
} from "./effect/WorkspaceTransaction.ts";
export {
  DaemonSessions,
  DaemonSessionsError,
  buildDaemonSessions,
  makeDaemonSessions,
  type DaemonSessionsService,
  type DaemonSessionsHost,
} from "./daemon-sessions.ts";
export type { PromptOptions } from "./effect/SessionRegistry.ts";
export { PromptOptionsSchema } from "./effect/SessionRegistry.ts";
export {
  PLUGIN_REDUCE_TIMEOUT_MS,
  PLUGIN_TILING_TIMEOUT_MS,
  PLUGIN_DESCRIPTOR_CHECK_TIMEOUT_MS,
  PluginReducerError,
  WorkspaceChangeError,
  WorkspaceChangeSchema,
  WorkspaceReducerAnswerSchema,
  type WorkspaceChange,
  type WorkspaceReducerAnswer,
  type WorkspaceReadPackage,
  type QueuedPluginAction,
} from "./workspace-changes.ts";
export {
  SessionIdSchema,
  PaneIdSchema,
  NewPaneIdSchema,
  makeSessionId,
  makePaneId,
  type SessionId,
  type PaneId,
  type NewPaneId,
} from "./workspace-ids.ts";
export {
  encodeOwner,
  workspaceChangeBuild,
  EncodedFirstMessage,
  type WorkspaceChangeBuild,
} from "./workspace-change-builders.ts";
export { defineDaemonCommand } from "./define-daemon-command.ts";
export {
  definePaneType,
  type PaneTypeHandle,
  type PaneTypeRegistration,
} from "./pane-descriptors.ts";
export {
  defineSessionProvider,
  type SessionProviderHandle,
  type ProviderMessageRegistration,
} from "./session-provider-messages.ts";
export { creationResultSchema } from "./creation-result.ts";
export { AgentEntrySchema, AgentListResultSchema, AgentGetResultSchema } from "./read-model.ts";

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
  runtimeCommand,
  CommandError,
  type Command,
  type CommandTag,
  type CommandOf,
  type CommandResult,
  type RuntimeCommand,
} from "./commands.ts";

export { quoteSendKeysLiteral } from "./send.ts";

export {
  evalScratch,
  materializeScratch,
  promoteScratch,
  sendSelectionScratchSource,
  sendTopBufferToPane,
  pluginScratchDir,
  scratchEntryPath,
  scratchEntryFilePath,
  managedPluginSpecPath,
  managedPluginEntryPath,
} from "./plugin/scratch.ts";

export {
  inspect,
  formatInspectResult,
  parsePluginCommandTag,
  provenanceFor,
  InspectResultSchema,
  type InspectCatalog,
  type InspectQuery,
  type InspectResult,
  type PluginProvenance,
} from "./plugin/inspect.ts";

export { NO_REALM, paneRealm, Realm, realmOf, type RealmValue } from "./realm.ts";

// Where a panel can be put, and what it is told about where it landed.
export {
  type Anchor,
  type DockSlotName,
  type SlotKind,
  type SlotDeclaration,
  type SlotContext,
  type SlotRegistration,
  SlotConflictError,
  type Slots,
  type SlotReader,
  type ChromeOccupant,
  type DockOccupant,
  type OverlayOccupant,
  type FloatOccupant,
  type DockSlotProps,
  type OverlaySlotProps,
  type FloatSlotProps,
} from "./ui/slots.ts";

// A key context: what a plugin registers through `ContextsTag` so its own
// modal (an overlay, a pane's own mode) claims keys the same way core's does
// — `CONTEXT_PRIORITY` names the bands core claims, so a plugin picks a
// number between two of them rather than guessing at one.
export { CONTEXT_PRIORITY, type ContextSpec, type ContextPriorityConflict } from "./key-context.ts";
// overlayBlocksPane stays internal to amux core (onUnhandled); pane plugins
// must not call it from their own `active()` — that recurses through every
// context including the caller.
export {
  contextCommand,
  createPendingTable,
  keyToBinding,
  pendingStrokes,
  type CommandSpec,
  type PendingRole,
  type PendingSource,
  type PendingTable,
} from "./bindings.ts";
export {
  combineConstraintRules,
  createConstraintTable,
  CONSTRAINT_RANKS,
  refuseIfDenied,
  type ConstraintEffect,
  type ConstraintRank,
  type ConstraintRule,
  type ConstraintSource,
  type ConstraintTable,
} from "./constraint.ts";
export {
  createChordMatcher,
  DEFAULT_CHORD_TIMEOUTLEN,
  DEFAULT_CHORD_TIMEOUTLEN_MS,
  type ChordBinding,
  type ChordFork,
  type ChordMatcher,
  type ChordMode,
  type ChordPushResult,
  type ChordStroke,
} from "./chord-matcher.ts";
export {
  createCountAccumulator,
  KeyInvocation,
  type KeyInvocationValue,
} from "./key-invocation.ts";

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

// The pieces of the layout a plugin reads or describes. Most of the layout
// algebra — splitting, collapsing, appending — stays in core: a plugin
// describes placement, it does not reimplement tree surgery. The exception is
// what a TilingAlgorithm implementation needs to build and rewrite the tree
// it owns (ts-e8fa74's proof that a tiling algorithm can genuinely live
// out-of-tree, niri included) — `makeLayout`, `layoutPanes`, `collapse`, and
// the handover fallback `closeLayout`, plus the tree/container node shapes
// themselves.
export {
  type PaneContent,
  type PaneRef,
  type LayoutPane,
  type Layout,
  type LayoutNode,
  type LayoutSplit,
  type LayoutContainer,
  type Placement,
  type DockSide,
  closeLayout,
  collapse,
  DOCK_SIDES,
  emptyDockStrips,
  layoutPanes,
  makeLayout,
} from "./layout.ts";
export { type LayoutSize } from "./geometry.ts";
export { type Direction, type SplitDirection } from "./window.ts";

// A container node's `kind` is an open, plugin-registered fact rather than a
// closed union member — see docs/adr/0004-arrangement-kind-is-an-open-registry.md.
export {
  type LayoutKindRenderer,
  type LayoutKindChrome,
  registerLayoutKindSchema,
  registerLayoutKindRenderer,
  layoutKindSchema,
  layoutKindRenderer,
} from "./layout-kinds.ts";

// Drawing.
export {
  theme,
  themeName,
  setTheme,
  hasTheme,
  onThemeChange,
  THEME_NAMES,
  DEFAULT_THEME_NAME,
  type ThemeColors,
  type ThemeName,
} from "./ui/theme.ts";
export { POLL_MS } from "./ui/state.ts";

// Pane approval prompt (agent tools and constrained commands).
export {
  ApprovalPrompt,
  type ApprovalPromptProps,
  type ApprovalPromptRequest,
} from "./ui/ApprovalPrompt.tsx";

// Host overlay shared by settings / command palette (stable across reload).
export { OverlayTag, type OverlayKind, type OverlayService } from "./plugin/overlay.ts";
