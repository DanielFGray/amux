import { Cause, Effect, Exit, JSONSchema, ParseResult, Schema as S } from "effect";
import { LAYOUT_PRESETS } from "./layout.ts";
import { PermissionDecisionSchema } from "./permission.ts";
import { ProcessStateSchema } from "./process-state.ts";
import { creationResultSchema } from "./creation-result.ts";
import {
  AgentGetResultSchema,
  AgentListResultSchema,
  PaneCurrentResultSchema,
  PaneLayoutResultSchema,
  PaneListResultSchema,
  SpaceListResultSchema,
  WindowListResultSchema,
} from "./read-model.ts";

/**
 * The commands, as values.
 *
 * One `Schema.TaggedStruct` per verb, and that single declaration is what every
 * consumer derives from: the keymap (which supplies the arguments a binding
 * carries), the daemon socket, the CLI, and the agent tool surface. A verb
 * declared here cannot drift from the surfaces that expose it, because there is
 * nothing to drift *from* — they are all reading this table.
 *
 * The argument is the reason the table exists. `window.select-1..9` and
 * `window.select-layout.${preset}` used to be nine and five *commands*, because
 * `run: () => void` had nowhere to put a slot number or a preset name, so the
 * argument was encoded into the command's name. Here they are one command each.
 * They are still nine and five *bindings* — `^a 1..9` is how a human selects a
 * window, and tmux writes that binding as `bind-key 1 select-window -t 1` for
 * exactly the same reason. See bindings.ts for that split.
 */

/** What a command acts ON — the authority that owns the state it mutates. */
export const COMMAND_TARGETS = ["workspace", "session", "buffers", "server", "view"] as const;
export type CommandTarget = (typeof COMMAND_TARGETS)[number];

/** Who the command is exposed TO — a human or an agent. Exposure is the tool
 *  surface, not the policy: what an agent may do under a permission policy is
 *  decided above the command registry, never by this field alone (ts-e7dcbf). */
export type CommandExposure = "human" | "agent";

/** Derived from target: commands whose state is daemon-owned are remotely
 * invocable. workspace, session, buffers, and server are in the daemon; view
 * is client-only UI state (options, overlays). */
export const isRemoteCommand = (target: CommandTarget): boolean => target !== "view";

/** Derived from target: workspace-targeted commands go through the daemon's
 * model queue and mutate the renderer-free workspace tree. */
export const isWorkspaceCommandByTarget = (target: CommandTarget): boolean =>
  target === "workspace";

/**
 * A command that could not do what it was asked.
 *
 * Declared rather than thrown: the send-keys prompt keeps itself open with the
 * reason in it, which it can only do if a rejection is a value it can read. A
 * *missing* target is not one of these — pressing `^a z` with no window is a
 * no-op, the way it has always been.
 */
export class CommandError extends S.TaggedError<CommandError>()("CommandError", {
  message: S.String,
}) {}

interface Meta {
  readonly desc: string;
  readonly group: string;
  readonly target: CommandTarget;
  readonly exposure: CommandExposure;
}

type CommandDef<T extends string, Fields extends S.Struct.Fields, Sch extends S.Schema.All, R> = {
  readonly tag: T;
  readonly desc: string;
  readonly group: string;
  readonly target: CommandTarget;
  readonly exposure: CommandExposure;
  readonly argumentFields: Fields;
  readonly arguments: S.Schema<any, any, unknown>;
  readonly schema: Sch;
  readonly result: R;
};

const define = <const Tag extends string, Fields extends S.Struct.Fields, R = typeof S.Void>(
  tag: Tag,
  fields: Fields,
  meta: Meta,
  result?: R,
): CommandDef<
  Tag,
  Fields,
  ReturnType<typeof S.TaggedStruct<Tag, Fields>>,
  R extends S.Schema.All ? R : typeof S.Void
> => ({
  tag,
  desc: meta.desc,
  group: meta.group,
  target: meta.target,
  exposure: meta.exposure,
  argumentFields: fields,
  schema: S.TaggedStruct(tag, fields).annotations({
    identifier: tag,
    description: meta.desc,
  }) as any,
  arguments: S.Struct(fields),
  result: (result ?? S.Void) as any,
});

/**
 * Which window, space or agent a command acts on.
 *
 * Absent means "the active one", which is what a keybinding almost always
 * means. The sidebar is why the fields exist at all: its `x` kills the SELECTED
 * row, and before commands took arguments that was a second copy of
 * agent.kill / window.close / space.close aimed somewhere else.
 */
const Space = { space: S.optional(S.String) };
const Window = { ...Space, window: S.optional(S.Int) };
const SessionTarget = { session: S.optional(S.String) };

/**
 * Where a pane command acts: a named pane, the caller's own pane (resolved
 * server-side from the command context, never substituted by the CLI), or —
 * absent both — the focused pane. On the command schema, so the harness tool
 * surface and every other surface inherit the target.
 */
const PaneTarget = {
  pane: S.optional(S.String.pipe(S.minLength(1))),
  current: S.optional(S.Boolean),
};

const Axis = S.Literal("row", "column");
const Direction = S.Literal("left", "right", "up", "down");

// Panes.
const PaneSplit = define(
  "pane.split",
  { axis: Axis, cwd: S.optional(S.String), ...PaneTarget },
  {
    desc: "split the focused pane",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  creationResultSchema("pane.split"),
);
const PaneNext = define(
  "pane.next",
  {},
  {
    desc: "focus the next pane",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneLast = define(
  "pane.last",
  {},
  {
    desc: "toggle to the last-focused pane",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneFocus = define(
  "pane.focus",
  { direction: Direction },
  {
    desc: "focus the pane in a direction, or move the focused float",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneSelect = define(
  "pane.select",
  { pane: S.String },
  {
    desc: "focus a pane by id",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneResize = define(
  "pane.resize",
  { direction: Direction, ...PaneTarget },
  {
    desc: "resize the focused pane",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneResizeDivider = define(
  "pane.resize-divider",
  { path: S.Array(S.Int), index: S.Int, delta: S.Int },
  {
    desc: "move a layout divider",
    group: "panes",
    target: "workspace",
    exposure: "human",
  },
);
const PaneZoom = define(
  "pane.zoom",
  { ...PaneTarget },
  {
    desc: "zoom the focused pane",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneFloat = define(
  "pane.float",
  { ...PaneTarget },
  {
    desc: "toggle the focused pane between floating and tiled",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneDock = <
  const Tag extends "pane.dock-left" | "pane.dock-right" | "pane.dock-top" | "pane.dock-bottom",
>(
  tag: Tag,
  side: string,
) =>
  define(
    tag,
    { ...PaneTarget },
    {
      desc: `dock the focused pane on the ${side}`,
      group: "panes",
      target: "workspace",
      exposure: "human",
    },
  );
const PaneDockLeft = PaneDock("pane.dock-left", "left");
const PaneDockRight = PaneDock("pane.dock-right", "right");
const PaneDockTop = PaneDock("pane.dock-top", "top");
const PaneDockBottom = PaneDock("pane.dock-bottom", "bottom");
const PaneUndock = define(
  "pane.undock",
  { ...PaneTarget },
  {
    desc: "undock the focused pane",
    group: "panes",
    target: "workspace",
    exposure: "human",
  },
);
const PaneSwap = define(
  "pane.swap",
  { to: S.Literal("previous", "next"), ...PaneTarget },
  {
    desc: "swap the focused pane with its neighbour",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneClose = define(
  "pane.close",
  { ...PaneTarget },
  {
    desc: "close the focused pane and stop its backend if it has no other view",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneBreak = define(
  "pane.break",
  { ...PaneTarget },
  {
    desc: "break the focused pane into its own window",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneJoin = define(
  "pane.join",
  { source: S.optional(S.Int), ...PaneTarget },
  {
    desc: "join a pane from another window into the focused window",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
/**
 * A pane moved to another space gets a new space-qualified id. The move
 * reports the new id and the old one, so a caller holding the stale handle can
 * re-anchor deterministically rather than guessing that the pane it knew is
 * gone.
 */
const PaneMoveResult = S.Struct({
  pane: S.String,
  previous_pane_id: S.String,
});
export type PaneMoveResult = S.Schema.Type<typeof PaneMoveResult>;

const PaneMove = define(
  "pane.move",
  { space: S.String, ...PaneTarget },
  {
    desc: "move the focused pane into another space",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  PaneMoveResult,
);
const PaneSendKeys = define(
  "pane.send-keys",
  { keys: S.String, ...PaneTarget },
  {
    desc: "send keys to the focused pane",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
// Capture and copy mode open a local overlay. The remote way to read a pane is
// a daemon-side terminal capture: pane.capture's result is the text.
const PaneCapture = define(
  "pane.capture",
  { session: S.optional(S.String), ...PaneTarget },
  {
    desc: "capture the focused pane",
    group: "panes",
    target: "session",
    exposure: "agent",
  },
  S.String,
);
// The machine-facing read surface (ts-33067b). These are pure projections of
// the daemon's model: they mutate nothing, publish no frame, and mark nothing
// seen, so an observing agent cannot hide a blocked agent from the human.
const PaneList = define(
  "pane.list",
  {},
  {
    desc: "list panes and where they live",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  PaneListResultSchema,
);
const PaneCurrent = define(
  "pane.current",
  { ...PaneTarget },
  {
    desc: "the caller's pane, or a named one",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  PaneCurrentResultSchema,
);
const PaneLayout = define(
  "pane.layout",
  { ...PaneTarget },
  {
    desc: "a pane's geometry, for choosing a split direction",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  PaneLayoutResultSchema,
);
const PaneCopyMode = define(
  "pane.copy-mode",
  {},
  {
    desc: "review pane history",
    group: "panes",
    target: "view",
    exposure: "human",
  },
);

// Buffers — tmux's paste-buffer family. The stack itself lives on the daemon,
// next to the PTYs it pastes into; these verbs are the surfaces' door to it.
// paste and choose need a screen (the focused pane / an overlay), the rest are
// pure server operations and therefore scriptable.
const BufferSet = define(
  "buffer.set",
  { name: S.optional(S.String), data: S.String },
  {
    desc: "set a paste buffer (a copy pushes onto the stack automatically)",
    group: "buffers",
    target: "buffers",
    exposure: "agent",
  },
  S.String,
);
const BufferPaste = define(
  "buffer.paste",
  { name: S.optional(S.String) },
  {
    desc: "paste the top paste buffer into the focused pane",
    group: "buffers",
    target: "view",
    exposure: "human",
  },
);
const BufferList = define(
  "buffer.list",
  {},
  {
    desc: "list the paste buffers",
    group: "buffers",
    target: "buffers",
    exposure: "agent",
  },
  S.Array(S.Struct({ name: S.String, bytes: S.Int, preview: S.String })),
);
const BufferDelete = define(
  "buffer.delete",
  { name: S.optional(S.String) },
  {
    desc: "delete the top paste buffer (or a named one)",
    group: "buffers",
    target: "buffers",
    exposure: "agent",
  },
);
const BufferShow = define(
  "buffer.show",
  { name: S.optional(S.String) },
  {
    desc: "show a paste buffer's contents",
    group: "buffers",
    target: "buffers",
    exposure: "agent",
  },
  S.String,
);
const BufferChoose = define(
  "buffer.choose",
  {},
  {
    desc: "choose a paste buffer to paste",
    group: "buffers",
    target: "view",
    exposure: "human",
  },
);

// Windows.
const WindowNew = define(
  "window.new",
  {},
  {
    desc: "new window",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
  creationResultSchema("window.new"),
);
const WindowNext = define(
  "window.next",
  {},
  {
    desc: "next window",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
);
const WindowPrevious = define(
  "window.previous",
  {},
  {
    desc: "previous window",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
);
const WindowLast = define(
  "window.last",
  {},
  {
    desc: "toggle to the last window",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
);
const WindowSelect = define(
  "window.select",
  { ...Space, number: S.Int },
  {
    desc: "select a window by its number",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
);
const WindowRename = define(
  "window.rename",
  { ...Window, name: S.String },
  {
    desc: "rename a window; an empty name restores the running command's title",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
);
const WindowClose = define("window.close", Window, {
  desc: "kill a window and its agents",
  group: "windows",
  target: "workspace",
  exposure: "agent",
});
const WindowNextLayout = define(
  "window.next-layout",
  {},
  {
    desc: "cycle through the preset layouts",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
);
const WindowSelectLayout = define(
  "window.select-layout",
  { preset: S.Literal(...LAYOUT_PRESETS) },
  {
    desc: "arrange panes in a preset layout",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
);
const WindowSynchronize = define(
  "window.synchronize-panes",
  {},
  {
    desc: "toggle synchronize-panes (input to every pane)",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
);
const WindowList = define(
  "window.list",
  {},
  {
    desc: "list windows and the panes they hold",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
  WindowListResultSchema,
);

// Agents.
const SessionKill = define("session.kill", SessionTarget, {
  desc: "stop a session",
  group: "sessions",
  target: "workspace",
  exposure: "agent",
});
const AgentPrompt = define(
  "agent.prompt",
  {
    target: S.String,
    text: S.String,
    id: S.optional(S.String),
    delivery: S.optional(S.Literal("steer", "queue")),
    resume: S.optional(S.Boolean),
    wait: S.optional(S.Boolean),
    until: S.optional(ProcessStateSchema),
    timeout: S.optional(S.NonNegativeInt),
  },
  {
    desc: "send a prompt to an agent",
    group: "agents",
    target: "session",
    exposure: "agent",
  },
);
const AgentWatch = define(
  "agent.watch",
  { target: S.String, after: S.optional(S.NonNegativeInt) },
  {
    desc: "stream durable agent events from a replay cursor",
    group: "agents",
    target: "session",
    exposure: "agent",
  },
);
const AgentPermission = define(
  "agent.permission",
  {
    ...SessionTarget,
    request: S.String,
    decision: PermissionDecisionSchema,
    feedback: S.optional(S.String),
  },
  {
    desc: "answer an agent's permission request",
    group: "agents",
    target: "workspace",
    exposure: "human",
  },
);
const AgentList = define(
  "agent.list",
  {},
  {
    desc: "list agents and where they live",
    group: "agents",
    target: "workspace",
    exposure: "agent",
  },
  AgentListResultSchema,
);
const AgentGet = define(
  "agent.get",
  { target: S.String },
  {
    desc: "one agent, by its session id",
    group: "agents",
    target: "workspace",
    exposure: "agent",
  },
  AgentGetResultSchema,
);
const AgentInterrupt = define(
  "agent.interrupt",
  { ...SessionTarget, reason: S.optional(S.String) },
  {
    desc: "interrupt an agent turn",
    group: "agents",
    target: "session",
    exposure: "human",
  },
);
const Notify = define(
  "notify",
  { title: S.String, body: S.String, ...SessionTarget },
  {
    desc: "send a notification to a session",
    group: "notifications",
    target: "session",
    exposure: "agent",
  },
);
/** A prompt is optional: an agent pane exists, idle, before it has been asked
 *  anything, and the pane's own composer is the normal way to give it work. */
const AgentNew = define(
  "agent.new",
  {
    provider: S.optional(S.String.pipe(S.minLength(1))),
    prompt: S.optional(S.String),
  },
  {
    desc: "start a coding agent",
    group: "agents",
    target: "workspace",
    exposure: "agent",
  },
  creationResultSchema("agent.new"),
);
const SessionRestart = define("session.restart", SessionTarget, {
  desc: "restart an exited session",
  group: "sessions",
  target: "workspace",
  exposure: "agent",
});
const SessionReveal = define(
  "session.reveal",
  { session: S.String },
  {
    desc: "show and focus a session",
    group: "sessions",
    target: "workspace",
    exposure: "agent",
  },
);
const SessionNextBlocked = define(
  "session.next-blocked",
  {},
  {
    desc: "select the next blocked session",
    group: "sessions",
    target: "workspace",
    exposure: "agent",
  },
);

// Spaces.
const SpaceNew = define(
  "space.new",
  {
    name: S.optional(S.String),
    dir: S.optional(S.String),
    branch: S.optional(S.String),
    base: S.optional(S.String),
  },
  {
    desc: "new space",
    group: "spaces",
    target: "workspace",
    exposure: "agent",
  },
  creationResultSchema("space.new"),
);
const SpaceSelect = define(
  "space.select",
  { space: S.String },
  {
    desc: "select a space by id",
    group: "spaces",
    target: "workspace",
    exposure: "agent",
  },
);
const SpaceRename = define(
  "space.rename",
  { ...Space, name: S.String },
  {
    desc: "rename a space",
    group: "spaces",
    target: "workspace",
    exposure: "agent",
  },
);
const SpaceClose = define("space.close", Space, {
  desc: "close a space and everything in it",
  group: "spaces",
  target: "workspace",
  exposure: "agent",
});
const SpaceNext = define(
  "space.next",
  {},
  {
    desc: "next space",
    group: "spaces",
    target: "workspace",
    exposure: "agent",
  },
);
const SpacePrevious = define(
  "space.previous",
  {},
  {
    desc: "previous space",
    group: "spaces",
    target: "workspace",
    exposure: "agent",
  },
);
const SpaceList = define(
  "space.list",
  {},
  {
    desc: "list spaces",
    group: "spaces",
    target: "workspace",
    exposure: "agent",
  },
  SpaceListResultSchema,
);

/**
 * Settings, as verbs.
 *
 * Changing an option is a command and not a key handler in the settings window,
 * which is what makes one act reachable from every surface at once: scriptable
 * over the socket, bindable to a key, and offerable to an agent. It is also why
 * there is no `sidebar.toggle` command — that is `config.toggle sidebar.open`,
 * and a bespoke verb per option is the thing a name plus a table replaces.
 *
 * `set` and `adjust` are both here because the two callers genuinely differ: a
 * script names the value it wants, while ←/→ and a dragged divider only know
 * which way to move. Clamping the result to the option's bounds is the table's
 * job in both cases.
 */
const ConfigSet = define(
  "config.set",
  { name: S.String, value: S.Union(S.String, S.Number, S.Boolean) },
  { desc: "set an option", group: "config", target: "view", exposure: "human" },
);
const ConfigToggle = define(
  "config.toggle",
  { name: S.String },
  {
    desc: "flip a yes/no option",
    group: "config",
    target: "view",
    exposure: "human",
  },
);
const ConfigAdjust = define(
  "config.adjust",
  { name: S.String, by: S.Int },
  {
    desc: "move a numeric option by a step",
    group: "config",
    target: "view",
    exposure: "human",
  },
);
const ConfigReset = define(
  "config.reset",
  { name: S.String },
  {
    desc: "put an option back to its default",
    group: "config",
    target: "view",
    exposure: "human",
  },
);

/**
 * Plugins run in the client, not the daemon, so this is an announcement rather
 * than a mutation: the daemon carries it to everyone attached and each client
 * reloads its own. It targets the server because it names no session — the
 * agent that just edited a plugin runs `amux plugin.reload` and means all of
 * them — and it is not a view command because a view command never leaves the
 * client it was typed into, which is the one place the agent is not.
 */
const PluginReload = define(
  "plugin.reload",
  { plugin: S.optional(S.String) },
  {
    desc: "load a plugin's source again; all of them if none is named",
    group: "plugins",
    target: "server",
    exposure: "agent",
  },
);
const PluginEnable = define(
  "plugin.enable",
  { plugin: S.String },
  {
    desc: "enable a plugin in this client",
    group: "plugins",
    target: "view",
    exposure: "human",
  },
);
const PluginDisable = define(
  "plugin.disable",
  { plugin: S.String },
  {
    desc: "disable a plugin in this client",
    group: "plugins",
    target: "view",
    exposure: "human",
  },
);

// The app itself. These drive overlays and the local terminal.
const AppHelp = define(
  "app.help",
  {},
  { desc: "keybinds", group: "global", target: "view", exposure: "human" },
);
const AppPalette = define(
  "app.command-palette",
  {},
  {
    desc: "search and run commands",
    group: "global",
    target: "view",
    exposure: "human",
  },
);
const AppSettings = define(
  "app.settings",
  {},
  { desc: "settings", group: "global", target: "view", exposure: "human" },
);
const AppSendPrefix = define(
  "app.send-prefix",
  {},
  {
    desc: "send a literal prefix key",
    group: "global",
    target: "view",
    exposure: "human",
  },
);
/**
 * Leaving the app detaches from the session; it does not end it.
 *
 * A view target rather than a server one, because the daemon has nothing to do
 * here: the client closes its own scope, the attach socket drops, and the
 * daemon records the detach like any other. The session, its layout and its
 * agents outlive the client and are restored by the next attach. Ending a
 * session is a separate act — close its last pane, or `amux stop`.
 */
const AppQuit = define(
  "app.quit",
  {},
  {
    desc: "detach from the session",
    group: "global",
    target: "view",
    exposure: "human",
  },
);

/** Every verb, in the order the surfaces list them. */
export const COMMAND_DEFS = [
  PaneSplit,
  PaneNext,
  PaneLast,
  PaneFocus,
  PaneSelect,
  PaneResize,
  PaneResizeDivider,
  PaneZoom,
  PaneFloat,
  PaneDockLeft,
  PaneDockRight,
  PaneDockTop,
  PaneDockBottom,
  PaneUndock,
  PaneSwap,
  PaneClose,
  PaneBreak,
  PaneJoin,
  PaneMove,
  PaneSendKeys,
  PaneCapture,
  PaneList,
  PaneCurrent,
  PaneLayout,
  PaneCopyMode,
  BufferSet,
  BufferPaste,
  BufferList,
  BufferDelete,
  BufferShow,
  BufferChoose,
  WindowNew,
  WindowNext,
  WindowPrevious,
  WindowLast,
  WindowSelect,
  WindowRename,
  WindowClose,
  WindowNextLayout,
  WindowSelectLayout,
  WindowSynchronize,
  WindowList,
  AgentNew,
  AgentPrompt,
  AgentWatch,
  AgentInterrupt,
  AgentPermission,
  AgentList,
  AgentGet,
  Notify,
  SessionKill,
  SessionRestart,
  SessionReveal,
  SessionNextBlocked,
  SpaceNew,
  SpaceSelect,
  SpaceRename,
  SpaceClose,
  SpaceNext,
  SpacePrevious,
  SpaceList,
  ConfigSet,
  ConfigToggle,
  ConfigAdjust,
  ConfigReset,
  PluginReload,
  PluginEnable,
  PluginDisable,
  AppHelp,
  AppPalette,
  AppSettings,
  AppSendPrefix,
  AppQuit,
] as const;

export type AgentToolDefinition = {
  readonly name: CommandTag;
  readonly description: string;
  readonly parameters: ReturnType<typeof JSONSchema.make>;
};

/** Generate the model-facing tool surface from the command declarations. */
export function agentToolDefinitions(): readonly AgentToolDefinition[] {
  return COMMAND_DEFS.filter((def) => def.exposure === "agent").map((def) => ({
    name: def.tag,
    description: def.desc,
    parameters: JSONSchema.make(def.arguments),
  }));
}

export function commandDefinition(tag: CommandTag) {
  const def = COMMAND_DEFS.find((candidate) => candidate.tag === tag);
  if (!def) throw new Error(`unknown command: ${tag}`);
  return def;
}

type CommandDefs = typeof COMMAND_DEFS;

/**
 * The union, derived from the list rather than written out beside it.
 *
 * A member that is not in COMMAND_DEFS is not in the union and has no handler,
 * so there is no way to declare a verb and forget to expose it.
 */
export const Command = S.Union(...COMMAND_DEFS.map((def) => def.schema));
export type Command = typeof Command.Type;
export type CommandTag = Command["_tag"];

export type CommandOf<T extends CommandTag> = Extract<Command, { _tag: T }>;
type ArgsOf<T extends CommandTag> = Omit<CommandOf<T>, "_tag">;

type _DefByTag<T extends CommandTag> = Extract<CommandDefs[number], { tag: T }>;
export type CommandResult<T extends CommandTag> = S.Schema.Type<_DefByTag<T>["result"]>;

export type AnyCommandResult = CommandResult<CommandTag>;

/**
 * A command value, written the way a caller thinks of it.
 *
 * `command("window.select", { number: 3 })` — the tag picks the argument type,
 * so a binding that supplies the wrong shape is a type error at the table.
 */
export const command = <T extends CommandTag>(
  tag: T,
  ...args: {} extends ArgsOf<T> ? [args?: ArgsOf<T>] : [args: ArgsOf<T>]
): Command => ({ _tag: tag, ...args[0] }) as Command;

/** Decode a command off the wire — the socket and the CLI in ts-14b665. */
export const decodeCommand = S.decodeUnknown(Command);

/**
 * What a command is, for the palette, the help, and the agent tool surface.
 *
 * `name` is a plain string rather than `CommandTag` because a plugin verb
 * (`plugin.<pluginId>.<verb>`) is never a member of the core union — it is
 * registered at runtime, not declared in COMMAND_DEFS.
 */
export interface CommandMeta {
  readonly name: string;
  readonly desc: string;
  readonly group: string;
  readonly target: CommandTarget;
  readonly exposure: CommandExposure;
}

/** Metadata by tag, so a binding can take its group and its default
 *  description from the verb it invokes rather than restating them. */
export const COMMAND_META = Object.fromEntries(
  COMMAND_DEFS.map((def) => [
    def.tag,
    {
      name: def.tag,
      desc: def.desc,
      group: def.group,
      target: def.target,
      exposure: def.exposure,
    } satisfies CommandMeta,
  ]),
) as Record<CommandTag, CommandMeta>;

/**
 * What each verb actually does.
 *
 * Keyed by tag and total over the union, so adding a member to COMMAND_DEFS is
 * a type error until it does something. Return types are the per-command
 * result values defined in the COMMAND_DEFS table.
 */
export type CommandHandlers = {
  readonly [T in CommandTag]: (args: CommandOf<T>) => Effect.Effect<CommandResult<T>, CommandError>;
};

export type CommandHandlerTable = Readonly<
  Record<string, (args: Command) => Effect.Effect<AnyCommandResult, CommandError>>
>;

/** A command value arriving at runtime under a tag the compiler has never seen
 *  — a plugin verb, or one read off the wire before it is known to exist. */
export type RuntimeCommand = { readonly _tag: string } & Record<string, unknown>;

/** A plugin verb, as registered: the same `desc`/`group`/`target`/`exposure`
 *  metadata a core command carries, plus the schema and handler a core
 *  command gets from two separate places (COMMAND_DEFS and the handler
 *  table) because a plugin has no compile-time union to be total over. */
interface PluginCommandEntry {
  readonly meta: CommandMeta;
  readonly schema: S.Schema<any, any, unknown>;
  readonly handler: (args: any) => Effect.Effect<unknown, CommandError>;
}

export interface Commands {
  /** Run a command. Local dispatch, not a round trip: the keymap needs the
   *  effect's synchronous prefix to run in the keypress it was dispatched from.
   *  A plugin tag is looked up in the runtime map and its arguments decoded
   *  against the schema it registered with — the compile-time totality below
   *  only covers the core union. */
  readonly run: {
    (command: Command): Effect.Effect<AnyCommandResult, CommandError>;
    (command: RuntimeCommand): Effect.Effect<unknown, CommandError>;
  };
  /** Every verb and what it is — core plus whatever plugins have registered —
   *  for whichever surface is listing them. */
  readonly list: (filter?: { target?: CommandTarget; exposure?: CommandExposure }) => CommandMeta[];
  /** Whether a command tag targets the workspace. False for a tag naming no
   *  registered command — a disabled or missing plugin's verb acts on
   *  nothing, so it is never mistaken for a workspace mutation. */
  readonly isWorkspaceCommand: (tag: string) => boolean;
  /** Whether a command tag is remotely invocable. Same absent-tag behavior. */
  readonly isRemoteCommand: (tag: string) => boolean;
  /**
   * Claim `plugin.<pluginId>.<verb>` for the lifetime of the plugin instance.
   *
   * Args are validated on the way in here (the fields must form a real
   * `Schema.TaggedStruct`) and again on every `run` — a plugin binding, the
   * palette, or the socket surface bring no compile-time guarantee the way a
   * core `Command` value does. Returns the disposer a scope finalizer wants;
   * calling it frees the tag for reuse. A tag already claimed — by core or by
   * another plugin — is refused rather than silently shadowed.
   */
  readonly registerCommand: <Fields extends S.Struct.Fields>(
    pluginId: string,
    verb: string,
    fields: Fields,
    meta: Meta,
    handler: (args: S.Struct.Type<Fields>) => Effect.Effect<unknown, CommandError>,
  ) => () => void;
}

export const makeCommands = (handlers: CommandHandlers | CommandHandlerTable): Commands => {
  // The one map ts-996769 asks for: core registers into COMMAND_META eagerly
  // at module load (below), plugins register into this one at load time.
  // Two population paths, one place every other method reads from.
  const pluginCommands = new Map<string, PluginCommandEntry>();

  const metaFor = (tag: string): CommandMeta | undefined =>
    (COMMAND_META as Record<string, CommandMeta>)[tag] ?? pluginCommands.get(tag)?.meta;

  const registerCommand: Commands["registerCommand"] = (pluginId, verb, fields, meta, handler) => {
    const tag = `plugin.${pluginId}.${verb}`;
    if (metaFor(tag)) throw new Error(`command already registered: ${tag}`);
    const schema = S.TaggedStruct(tag, fields).annotations({
      identifier: tag,
      description: meta.desc,
    });
    pluginCommands.set(tag, {
      meta: {
        name: tag,
        desc: meta.desc,
        group: meta.group,
        target: meta.target,
        exposure: meta.exposure,
      },
      schema,
      handler,
    });
    return () => {
      pluginCommands.delete(tag);
    };
  };

  const run = ((command: RuntimeCommand) =>
    // Suspended, because a caller builds the effect once — a binding's `run` is
    // built when the table is built — and the handler has to read the workspace
    // at the moment it runs, not at the moment it was named.
    Effect.suspend(() => {
      const coreHandler = (handlers as CommandHandlerTable)[command._tag];
      if (coreHandler) return coreHandler(command as Command);
      const plugin = pluginCommands.get(command._tag);
      if (!plugin)
        return Effect.fail(new CommandError({ message: `unknown command: ${command._tag}` }));
      return S.decodeUnknown(plugin.schema)(command).pipe(
        Effect.mapError(
          (error) =>
            new CommandError({
              message: `${command._tag}: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
            }),
        ),
        Effect.flatMap(plugin.handler),
      );
    })) as Commands["run"];

  const list: Commands["list"] = (filter) => {
    const all = [
      ...COMMAND_DEFS.map((def) => COMMAND_META[def.tag]!),
      ...[...pluginCommands.values()].map((entry) => entry.meta),
    ];
    return all.filter(
      (m) =>
        (!filter?.target || m.target === filter.target) &&
        (!filter?.exposure || m.exposure === filter.exposure),
    );
  };

  return {
    run,
    list,
    isWorkspaceCommand: (tag) => {
      const meta = metaFor(tag);
      return meta ? isWorkspaceCommandByTarget(meta.target) : false;
    },
    isRemoteCommand: (tag) => {
      const meta = metaFor(tag);
      return meta ? isRemoteCommand(meta.target) : false;
    },
    registerCommand,
  };
};

/**
 * Start a command and let it finish on its own.
 *
 * Forked rather than `runSync`, because closing an agent interrupts its pump
 * fiber before freeing the terminal and `runSync` refuses to wait on an
 * interrupt. Forking still runs an effect's synchronous prefix *immediately*,
 * so a command that only touches the tree stays as synchronous as it was when
 * `run` was a plain callback — which is what the keymap's predicate contract
 * needs, and why dispatch does not have to become async.
 *
 * A failure in a forked fiber goes unnoticed unless somebody observes it. This
 * observes it. Interruption is not a failure worth reporting: it is what
 * shutting down looks like from in here.
 */
export function runDetached(
  label: string,
  effect: Effect.Effect<any, CommandError>,
  onError?: (message: string) => void,
): void {
  Effect.runFork(Effect.asVoid(effect)).addObserver((exit) => {
    if (Exit.isSuccess(exit) || Cause.isInterruptedOnly(exit.cause)) return;
    const message = `command ${label} failed: ${Cause.pretty(exit.cause)}`;
    console.error(message);
    onError?.(message);
  });
}

export const Commands = {
  PaneSplit,
  PaneNext,
  PaneLast,
  PaneFocus,
  PaneSelect,
  PaneResize,
  PaneResizeDivider,
  PaneZoom,
  PaneFloat,
  PaneSwap,
  PaneClose,
  PaneBreak,
  PaneJoin,
  PaneMove,
  PaneSendKeys,
  PaneCapture,
  PaneList,
  PaneCurrent,
  PaneLayout,
  PaneCopyMode,
  BufferSet,
  BufferPaste,
  BufferList,
  BufferDelete,
  BufferShow,
  BufferChoose,
  WindowNew,
  WindowNext,
  WindowPrevious,
  WindowLast,
  WindowSelect,
  WindowRename,
  WindowClose,
  WindowNextLayout,
  WindowSelectLayout,
  WindowSynchronize,
  WindowList,
  Notify,
  SessionKill,
  SessionRestart,
  SessionReveal,
  SessionNextBlocked,
  SpaceNew,
  SpaceSelect,
  SpaceRename,
  SpaceClose,
  SpaceNext,
  SpacePrevious,
  SpaceList,
  ConfigSet,
  ConfigToggle,
  ConfigAdjust,
  ConfigReset,
  PluginReload,
  AppHelp,
  AppPalette,
  AppSettings,
  AppSendPrefix,
  AppQuit,
};
