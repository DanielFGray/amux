import { Cause, Context, Effect, Exit, JsonSchema, Schema as S, SchemaIssue } from "effect";

const formatSchemaIssue = SchemaIssue.makeFormatterDefault();
import { JsonValueSchema, type JsonValue } from "./effect/AttachProtocol.ts";
import { LAYOUT_PRESETS, DescriptorSchema } from "./layout.ts";
import { creationResultSchema } from "./creation-result.ts";
import {
  PaneCurrentResultSchema,
  PaneLayoutResultSchema,
  PaneListResultSchema,
  SpaceListResultSchema,
  WindowListResultSchema,
} from "./read-model.ts";
import type { RootRuntimeContext } from "./env.ts";
import { NO_REALM, Realm, type RealmValue } from "./realm.ts";

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
export const COMMAND_TARGETS = [
  "workspace",
  "session",
  "buffers",
  "server",
  "client",
  "view",
] as const;
export type CommandTarget = (typeof COMMAND_TARGETS)[number];

/** Who the command is exposed TO — a human or an agent. Exposure is the tool
 *  surface, not the policy: what an agent may do under a permission policy is
 *  decided above the command registry, never by this field alone (ts-e7dcbf). */
export type CommandExposure = "human" | "agent";

/** Derived from target: commands whose state is daemon-owned are remotely
 * invocable. A client command runs in one attached client because it targets
 * projection-local state; view is local-only UI state. */
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

export interface Meta {
  readonly desc: string;
  readonly group: string;
  readonly target: CommandTarget;
  readonly exposure: CommandExposure;
}

type CommandDef<T extends string, Fields extends S.Struct.Fields, Sch extends S.Top, R> = {
  readonly tag: T;
  readonly desc: string;
  readonly group: string;
  readonly target: CommandTarget;
  readonly exposure: CommandExposure;
  readonly argumentFields: Fields;
  readonly arguments: S.Codec<any>;
  readonly schema: Sch;
  readonly result: R;
  /** What the decoded args name — subjects a resource-scoped rule can match. */
  readonly resources: (args: S.Struct.Type<Fields>) => readonly string[];
};

/**
 * Present string/number args that name what the verb touches. Absent optionals
 * are omitted — never invent the focused pane, active space, or similar.
 */
const resourcesOf = (
  ...values: ReadonlyArray<string | number | undefined>
): readonly string[] => values.flatMap((value) => (value === undefined ? [] : [String(value)]));

/** A command whose decoded args name nothing a rule can scope. */
const noResources = (): readonly string[] => [];

const define = <const Tag extends string, Fields extends S.Struct.Fields, R = typeof S.Void>(
  tag: Tag,
  fields: Fields,
  meta: Meta,
  resources: (args: S.Struct.Type<Fields>) => readonly string[],
  result?: R,
): CommandDef<
  Tag,
  Fields,
  ReturnType<typeof S.TaggedStruct<Tag, Fields>>,
  R extends S.Top ? R : typeof S.Void
> => ({
  tag,
  desc: meta.desc,
  group: meta.group,
  target: meta.target,
  exposure: meta.exposure,
  argumentFields: fields,
  schema: S.TaggedStruct(tag, fields).annotate({
    identifier: tag,
    description: meta.desc,
  }) as any,
  arguments: S.Struct(fields) as any,
  result: (result ?? S.Void) as any,
  resources,
});

/**
 * Which window, space or agent a command acts on.
 *
 * Absent means "the active one", which is what a keybinding almost always
 * means. The sidebar is why the fields exist at all: its `x` kills the SELECTED
 * row, and before commands took arguments that was a second copy of
 * agent.kill / window.close / space.close aimed somewhere else.
 */
const Space = { space: S.optionalKey(S.String) };
const Window = { ...Space, window: S.optionalKey(S.Int) };
/** The session a notification addresses. Unlike AgentTarget below, this
 *  field really is a session selector — a caller-facing name Notify has
 *  always used — so it keeps the name "session" rather than "target". */
const NotifyTarget = { session: S.optionalKey(S.String) };
/** The agent a session.* command acts on, defaulting to the caller's own
 *  pane when omitted. Named "target" (matching agent.get/agent.prompt/
 *  agent.watch), not "session": the CLI's own `--session`/positional-session
 *  syntax already claims that name for "which daemon", and a command field
 *  sharing it collided with that resolution. */
const AgentTarget = { target: S.optionalKey(S.String) };

/**
 * Where a pane command acts: a named pane, the caller's own pane (resolved
 * server-side from the command context, never substituted by the CLI), or —
 * absent both — the focused pane. On the command schema, so the harness tool
 * surface and every other surface inherit the target.
 */
const PaneTarget = {
  pane: S.optionalKey(S.String.pipe(S.check(S.isMinLength(1)))),
  current: S.optionalKey(S.Boolean),
};

const Axis = S.Literals(["row", "column"]);
const Direction = S.Literals(["left", "right", "up", "down"]);

// Panes.
const paneTargetResources = (args: { pane?: string }): readonly string[] => resourcesOf(args.pane);

const PaneSplit = define(
  "pane.split",
  { axis: Axis, cwd: S.optionalKey(S.String), ...PaneTarget },
  {
    desc: "split the focused pane",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.cwd, args.pane),
  creationResultSchema("pane.split"),
);
/**
 * Open a client-rendered plugin pane with no daemon backend — the editor's
 * entry point (ts-96d6bf). Splits the focused pane like pane.split, but the
 * newcomer names a registered pane type and a descriptor instead of a session:
 * core places the pane and persists the descriptor; the plugin's view renders
 * from it. `type` selects which registered view fills the pane, `descriptor`
 * is the remount contract that pane type's view reads back.
 */
const PaneOpenPlugin = define(
  "pane.open-plugin",
  { type: S.String.pipe(S.check(S.isMinLength(1))), descriptor: DescriptorSchema, ...PaneTarget },
  {
    desc: "open a plugin-rendered pane (no backend session)",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.type, args.pane),
  creationResultSchema("pane.open-plugin"),
);
/**
 * Open an out-of-process plugin pane by linked plugin id + entrypoint id.
 * The daemon resolves the manifest (argv/env/cwd/title) and fills workspace
 * context before applying; callers never send raw command/env.
 * Cordis panes stay on pane.open-plugin.
 */
const ProcessPluginPaneOpen = define(
  "process-plugin.pane.open",
  {
    plugin: S.String.pipe(S.check(S.isMinLength(1))),
    entrypoint: S.String.pipe(S.check(S.isMinLength(1))),
    /** Filled by the daemon after manifest resolve; omit on the wire. */
    command: S.optionalKey(
      S.Array(S.String.pipe(S.check(S.isMinLength(1)))).pipe(S.check(S.isMinLength(1))),
    ),
    env: S.optionalKey(S.Record(S.String, S.String)),
    cwd: S.optionalKey(S.String),
    title: S.optionalKey(S.String),
    axis: S.optionalKey(Axis),
    /** Amux Placement; filled from the manifest (default tiled). */
    placement: S.optionalKey(S.Literals(["tiled", "floating", "left", "right", "top", "bottom"])),
    /** Restore prior focus when the session exits. */
    transient: S.optionalKey(S.Boolean),
    ...PaneTarget,
  },
  {
    desc: "open an out-of-process plugin pane",
    group: "process-plugin",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.plugin, args.entrypoint, args.cwd, args.pane),
  creationResultSchema("process-plugin.pane.open"),
);
/**
 * Run a linked process-plugin action on the daemon (fire-and-forget).
 * Keybinds and the control socket use this; the CLI `action invoke` waits locally.
 */
const ProcessPluginActionInvoke = define(
  "process-plugin.action.invoke",
  {
    plugin: S.String.pipe(S.check(S.isMinLength(1))),
    action: S.String.pipe(S.check(S.isMinLength(1))),
  },
  {
    desc: "run an out-of-process plugin action",
    group: "process-plugin",
    target: "server",
    exposure: "agent",
  },
  (args) => resourcesOf(args.plugin, args.action),
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
  noResources,
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
  noResources,
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
  noResources,
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
  (args) => resourcesOf(args.pane),
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
  paneTargetResources,
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
  noResources,
);
const PaneSetSize = define(
  "pane.set-size",
  {
    axis: S.Literals(["cols", "rows"]),
    /** Omit to maximize on that axis (vim `CTRL-W_|` with no count). */
    cells: S.optionalKey(S.Int),
    ...PaneTarget,
  },
  {
    desc: "set the focused pane's width or height in cells",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  paneTargetResources,
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
  paneTargetResources,
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
  paneTargetResources,
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
    paneTargetResources,
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
  paneTargetResources,
);
const PaneSwap = define(
  "pane.swap",
  { to: S.Literals(["previous", "next"]), ...PaneTarget },
  {
    desc: "swap the focused pane with its neighbour",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  paneTargetResources,
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
  paneTargetResources,
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
  paneTargetResources,
);
const PaneJoin = define(
  "pane.join",
  { source: S.optionalKey(S.Int), ...PaneTarget },
  {
    desc: "join a pane from another window into the focused window",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.source, args.pane),
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
  (args) => resourcesOf(args.space, args.pane),
  PaneMoveResult,
);
// "client" is the fallback the daemon reaches for a client-only pane (no
// session to write to) or an explicit --dispatch (needs a live keymap's
// binding resolution). A session-backed pane's default delivery never gets
// there: the daemon encodes and writes to its own pty directly, the same way
// TerminalPane.handleKey does at its boundary, so this needs no client
// attached at all — see daemon.ts's runRemote.
const PaneSendKeys = define(
  "pane.send-keys",
  { keys: S.String, dispatch: S.optionalKey(S.Boolean), ...PaneTarget },
  {
    desc: "send keys to the focused pane",
    group: "panes",
    target: "client",
    exposure: "agent",
  },
  paneTargetResources,
);
// Capture opens a local overlay when unbound from a target (human keybind).
// Remotely, a session-backed pane is captured by the daemon (pty grid); a
// client-only plugin pane falls through to the attached client, which crops
// the live OpenTUI frame — the same client-fallback send-keys uses when the
// pane has no session. See daemon.ts runRemote.
const PaneCapture = define(
  "pane.capture",
  { session: S.optionalKey(S.String), ...PaneTarget },
  {
    desc: "capture the focused pane",
    group: "panes",
    target: "client",
    exposure: "agent",
  },
  (args) => resourcesOf(args.session, args.pane),
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
  noResources,
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
  paneTargetResources,
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
  paneTargetResources,
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
  noResources,
);
const PaneSetDescriptor = define(
  "pane.set-descriptor",
  { descriptor: DescriptorSchema, ...PaneTarget },
  {
    desc: "set a plugin pane's descriptor (its remount contract)",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
  paneTargetResources,
);

// Buffers — tmux's paste-buffer family. The stack itself lives on the daemon,
// next to the PTYs it pastes into; these verbs are the surfaces' door to it.
// paste and choose need a screen (the focused pane / an overlay), the rest are
// pure server operations and therefore scriptable.
const BufferSet = define(
  "buffer.set",
  { name: S.optionalKey(S.String), data: S.String },
  {
    desc: "set a paste buffer (a copy pushes onto the stack automatically)",
    group: "buffers",
    target: "buffers",
    exposure: "agent",
  },
  (args) => resourcesOf(args.name),
  S.String,
);
const BufferPaste = define(
  "buffer.paste",
  { name: S.optionalKey(S.String) },
  {
    desc: "paste the top paste buffer into the focused pane",
    group: "buffers",
    target: "view",
    exposure: "human",
  },
  (args) => resourcesOf(args.name),
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
  noResources,
  S.Array(S.Struct({ name: S.String, bytes: S.Int, preview: S.String })),
);
const BufferDelete = define(
  "buffer.delete",
  { name: S.optionalKey(S.String) },
  {
    desc: "delete the top paste buffer (or a named one)",
    group: "buffers",
    target: "buffers",
    exposure: "agent",
  },
  (args) => resourcesOf(args.name),
);
const BufferShow = define(
  "buffer.show",
  { name: S.optionalKey(S.String) },
  {
    desc: "show a paste buffer's contents",
    group: "buffers",
    target: "buffers",
    exposure: "agent",
  },
  (args) => resourcesOf(args.name),
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
  noResources,
);

// Windows.
const windowTargetResources = (args: {
  space?: string;
  window?: number;
}): readonly string[] => resourcesOf(args.space, args.window);

const WindowNew = define(
  "window.new",
  {},
  {
    desc: "new window",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
  noResources,
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
  noResources,
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
  noResources,
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
  noResources,
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
  (args) => resourcesOf(args.space, args.number),
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
  (args) => resourcesOf(args.space, args.window, args.name),
);
const WindowClose = define(
  "window.close",
  Window,
  {
    desc: "kill a window and its agents",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
  windowTargetResources,
);
const WindowNextLayout = define(
  "window.next-layout",
  {},
  {
    desc: "cycle through the preset layouts",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
  noResources,
);
const WindowSelectLayout = define(
  "window.select-layout",
  { preset: S.Literals([...LAYOUT_PRESETS]) },
  {
    desc: "arrange panes in a preset layout",
    group: "windows",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.preset),
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
  noResources,
);
const WorkspaceRebuildTiling = define(
  "workspace.rebuild-tiling",
  Window,
  {
    desc: "rebuild tiled arrangements with the elected algorithm",
    group: "workspace",
    target: "workspace",
    exposure: "human",
  },
  windowTargetResources,
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
  noResources,
  WindowListResultSchema,
);

// Agents.
const SessionKill = define(
  "session.kill",
  AgentTarget,
  {
    desc: "stop a session",
    group: "sessions",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.target),
);
/** Opaque control payload for a plugin-owned component session. The daemon
 * orders and routes it; interpreting it is the component's responsibility. */
const SessionMessage = define(
  "session.message",
  { target: S.String, message: JsonValueSchema },
  {
    desc: "send a control message to a component session",
    group: "sessions",
    target: "session",
    exposure: "agent",
  },
  (args) => resourcesOf(args.target),
);
const Notify = define(
  "notify",
  { title: S.String, body: S.String, ...NotifyTarget },
  {
    desc: "send a notification to a session",
    group: "notifications",
    target: "session",
    exposure: "agent",
  },
  (args) => resourcesOf(args.session),
);
const SessionRestart = define(
  "session.restart",
  AgentTarget,
  {
    desc: "restart an exited session",
    group: "sessions",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.target),
);
const SessionReveal = define(
  "session.reveal",
  { target: S.String },
  {
    desc: "show and focus a session",
    group: "sessions",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.target),
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
  noResources,
);

// Spaces.
const SpaceNew = define(
  "space.new",
  {
    name: S.optionalKey(S.String),
    dir: S.optionalKey(S.String),
    branch: S.optionalKey(S.String),
    base: S.optionalKey(S.String),
  },
  {
    desc: "new space",
    group: "spaces",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.name, args.dir, args.branch, args.base),
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
  (args) => resourcesOf(args.space),
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
  (args) => resourcesOf(args.space, args.name),
);
const SpaceClose = define(
  "space.close",
  Space,
  {
    desc: "close a space and everything in it",
    group: "spaces",
    target: "workspace",
    exposure: "agent",
  },
  (args) => resourcesOf(args.space),
);
const SpaceNext = define(
  "space.next",
  {},
  {
    desc: "next space",
    group: "spaces",
    target: "workspace",
    exposure: "agent",
  },
  noResources,
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
  noResources,
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
  noResources,
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
  { name: S.String, value: S.Union([S.String, S.Finite, S.Boolean]) },
  { desc: "set an option", group: "config", target: "view", exposure: "human" },
  (args) => resourcesOf(args.name),
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
  (args) => resourcesOf(args.name),
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
  (args) => resourcesOf(args.name),
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
  (args) => resourcesOf(args.name),
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
  { plugin: S.optionalKey(S.String), disk: S.optionalKey(S.Boolean) },
  {
    desc: "load plugin source again; pass disk to retry a quarantined edit",
    group: "plugins",
    target: "server",
    exposure: "agent",
  },
  (args) => resourcesOf(args.plugin),
);
/**
 * In-session authorship: materialize `source` into the scratch plugin dir and
 * adopt/reload it on the attached client. Client-targeted because plugins run
 * in clients, not the daemon — same forwarding path as pane.send-keys.
 */
const PluginEval = define(
  "plugin.eval",
  {
    plugin: S.String.pipe(S.check(S.isMinLength(1))),
    source: S.String.pipe(S.check(S.isMinLength(1))),
  },
  {
    desc: "eval plugin source in-session (scratch adopt/reload)",
    group: "plugins",
    target: "client",
    exposure: "agent",
  },
  (args) => resourcesOf(args.plugin),
  S.Struct({ plugin: S.String, path: S.String }),
);
/**
 * Promote a live scratch plugin into `$configDir/plugins/` and the config
 * `plugins` array so the ordinary startup loader picks it up after restart.
 */
const PluginPromote = define(
  "plugin.promote",
  { plugin: S.String.pipe(S.check(S.isMinLength(1))) },
  {
    desc: "promote a scratch plugin into config plugins",
    group: "plugins",
    target: "client",
    exposure: "agent",
  },
  (args) => resourcesOf(args.plugin),
  S.Struct({ plugin: S.String, path: S.String }),
);
/**
 * Read-only describe-key / ownership query over the live contribution tables.
 * Client-targeted: bindings, generations, and source paths live on the client.
 */
const PluginInspect = define(
  "plugin.inspect",
  {
    command: S.optionalKey(S.String),
    binding: S.optionalKey(S.String),
    key: S.optionalKey(S.String),
    pane: S.optionalKey(S.String),
    plugin: S.optionalKey(S.String),
  },
  {
    desc: "describe what provides a command, binding, key, pane, or plugin",
    group: "plugins",
    target: "client",
    exposure: "agent",
  },
  (args) => resourcesOf(args.command, args.binding, args.key, args.pane, args.plugin),
  // Result shape lives in plugin/inspect.ts; duplicated fields here so the
  // command table stays the wire schema (commands.ts owns CLI/agent surfaces).
  S.Struct({
    kind: S.Literals(["command", "binding", "key", "pane", "plugin"]),
    name: S.String,
    found: S.Boolean,
    description: S.optional(S.String),
    provider: S.optional(
      S.Struct({
        pluginId: S.String,
        generation: S.optional(S.Int),
        source: S.optional(S.String),
        phase: S.optional(S.String),
        waitingFor: S.Array(S.String),
        active: S.Boolean,
      }),
    ),
    whyActive: S.optional(S.String),
    details: S.optional(S.Record(S.String, S.Unknown)),
  }),
);
/**
 * Human entry for {@link PluginInspect}: palette / bound key, defaulting to
 * the focused pane. Renders a float panel; the agent JSON path stays
 * `plugin.inspect`.
 */
const AppDescribeKey = define(
  "app.describe-key",
  {
    command: S.optionalKey(S.String),
    binding: S.optionalKey(S.String),
    key: S.optionalKey(S.String),
    pane: S.optionalKey(S.String),
    plugin: S.optionalKey(S.String),
  },
  {
    desc: "describe what provides the focused pane (or a named subject)",
    group: "global",
    target: "view",
    exposure: "human",
  },
  (args) => resourcesOf(args.command, args.binding, args.key, args.pane, args.plugin),
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
  (args) => resourcesOf(args.plugin),
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
  (args) => resourcesOf(args.plugin),
);

// The app itself. These drive overlays and the local terminal.
const AppHelp = define(
  "app.help",
  {},
  { desc: "keybinds", group: "global", target: "view", exposure: "human" },
  noResources,
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
  noResources,
);
const AppSettings = define(
  "app.settings",
  {},
  { desc: "settings", group: "global", target: "view", exposure: "human" },
  noResources,
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
  noResources,
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
  noResources,
);

/** Every verb, in the order the surfaces list them. */
export const COMMAND_DEFS = [
  PaneSplit,
  PaneOpenPlugin,
  ProcessPluginPaneOpen,
  ProcessPluginActionInvoke,
  PaneNext,
  PaneLast,
  PaneFocus,
  PaneSelect,
  PaneResize,
  PaneResizeDivider,
  PaneSetSize,
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
  PaneSetDescriptor,
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
  WorkspaceRebuildTiling,
  WindowList,
  Notify,
  SessionKill,
  SessionMessage,
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
  PluginEval,
  PluginPromote,
  PluginInspect,
  PluginEnable,
  PluginDisable,
  AppHelp,
  AppDescribeKey,
  AppPalette,
  AppSettings,
  AppSendPrefix,
  AppQuit,
] as const;

export type AgentToolDefinition = {
  readonly name: CommandTag;
  readonly description: string;
  /** A single self-contained JSON Schema, which is what a tool call declares. */
  readonly parameters: JsonSchema.JsonSchema;
};

/** Generate the model-facing tool surface from the command declarations. */
export function agentToolDefinitions(): readonly AgentToolDefinition[] {
  return COMMAND_DEFS.filter((def) => def.exposure === "agent").map((def) => ({
    name: def.tag,
    description: def.desc,
    parameters: toolParameters(def.arguments),
  }));
}

/**
 * A schema document splits the root from the definitions it references, but a
 * tool call carries one object. Fold the pool back in under `$defs`, which is
 * where the document's own `#/$defs/...` references already point.
 */
function toolParameters(schema: S.Top): JsonSchema.JsonSchema {
  const document = S.toJsonSchemaDocument(schema);
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
}

export function commandDefinition(tag: CommandTag) {
  const def = COMMAND_DEFS.find((candidate) => candidate.tag === tag);
  if (!def) throw new Error(`unknown command: ${tag}`);
  return def;
}

/** Whether a tag names a command core declares. Anything else reaching the
 *  daemon is either a daemon-plugin command (in the daemon's own table) or a
 *  client-plugin verb (forwarded to an attached client). */
export const isCoreCommandTag = (tag: string): tag is CommandTag =>
  Object.hasOwn(COMMAND_META, tag);

export const isCoreCommand = (command: Command | RuntimeCommand): command is Command =>
  isCoreCommandTag(command._tag);

type CommandDefs = typeof COMMAND_DEFS;

/**
 * The union, derived from the list rather than written out beside it.
 *
 * A member that is not in COMMAND_DEFS is not in the union and has no handler,
 * so there is no way to declare a verb and forget to expose it.
 */
export const Command = S.Union(COMMAND_DEFS.map((def) => def.schema));
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
export function command<T extends CommandTag>(
  tag: T,
  ...args: {} extends ArgsOf<T> ? [args?: ArgsOf<T>] : [args: ArgsOf<T>]
): Command;
export function command(tag: string, args?: Record<string, JsonValue>): RuntimeCommand;
export function command(tag: string, args?: Record<string, JsonValue>): Command | RuntimeCommand {
  return { _tag: tag, ...args } as Command | RuntimeCommand;
}

/** Decode a command off the wire — the socket and the CLI in ts-14b665. */
export const decodeCommand = S.decodeUnknownEffect(Command);

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
 * Who called: the surface that asked, and the calling session/pane when known.
 *
 * Every surface builds this record explicitly — key dispatch from focus,
 * socket/CLI from the batch context the daemon routes — so Realm has
 * exactly one provider ({@link Commands.run}) and cannot drift per path.
 * Names the caller, not the target; Realm still keys off `pane` until a
 * later task moves it to the resolved target.
 */
export const CommandInvocationSchema = S.Struct({
  source: S.Literals(["key", "socket", "cli"]),
  /** Calling session id (`AMUX_AGENT_ID` / `context.agent`), when there is one. */
  agent: S.optional(S.String),
  /** Calling pane id, when the call came from inside one. */
  pane: S.optional(S.String),
});
export type CommandInvocation = typeof CommandInvocationSchema.Type;

/** The invocation {@link Commands.run} is serving — nested handlers may read it. */
export class CurrentInvocation extends Context.Service<CurrentInvocation, CommandInvocation>()(
  "amux/CommandInvocation",
) {}

/** Build a caller record; omit `pane`/`agent` when the call has none. */
export const commandInvocation = (
  source: CommandInvocation["source"],
  pane?: string,
  agent?: string,
): CommandInvocation => {
  if (pane !== undefined && agent !== undefined) return { source, pane, agent };
  if (pane !== undefined) return { source, pane };
  if (agent !== undefined) return { source, agent };
  return { source };
};

/**
 * What each verb actually does.
 *
 * Keyed by tag and total over the union, so adding a member to COMMAND_DEFS is
 * a type error until it does something. Return types are the per-command
 * result values defined in the COMMAND_DEFS table.
 */
export type CommandHandlers = {
  readonly [T in CommandTag]: (
    args: CommandOf<T>,
  ) => Effect.Effect<CommandResult<T>, CommandError, Realm | CurrentInvocation>;
};

export type CommandHandlerTable = Readonly<
  Record<
    string,
    (args: Command) => Effect.Effect<AnyCommandResult, CommandError, Realm | CurrentInvocation>
  >
>;

/** A command value arriving at runtime under a tag the compiler has never seen
 *  — a plugin verb, or one read off the wire before it is known to exist. */
export type RuntimeCommand = { readonly _tag: string } & Record<string, JsonValue>;

/**
 * Build a runtime command value, the way a caller thinks of it.
 *
 * `command()` is total over the core union; this is the equivalent for tags
 * core never declared — daemon-plugin commands and client-plugin verbs.
 * Nothing is validated here: the receiving table decodes the arguments
 * against the schema the tag's owner registered.
 */
export const runtimeCommand = (tag: string, args?: Record<string, JsonValue>): RuntimeCommand => ({
  _tag: tag,
  ...args,
});

/**
 * The wire shape of a plugin verb: `Command` is a closed compile-time union,
 * so a control-socket payload needs a permissive fallback to admit
 * `plugin.<id>.<verb>` tags the daemon has never seen and cannot validate
 * beyond this shape. The `plugin.` prefix is what tells the daemon a tag it
 * does not recognise is worth forwarding to an attached client rather than
 * rejecting outright.
 */
export const RuntimeCommandSchema = S.StructWithRest(S.Struct({ _tag: S.String }), [
  S.Record(S.String, JsonValueSchema),
]);

interface CommandEntry {
  readonly meta: CommandMeta;
  readonly schema: S.Codec<any>;
  readonly resources: (args: any) => readonly string[];
  readonly handler: (
    args: any,
  ) => Effect.Effect<unknown, CommandError, Realm | CurrentInvocation>;
}

export interface Commands {
  /** Run a command. Local dispatch, not a round trip: the keymap needs the
   *  effect's synchronous prefix to run in the keypress it was dispatched from.
   *  Arguments are decoded against the registered schema for both core and
   *  plugin tags. Compile-time totality only covers the core union.
   *
   *  `invocation` names who asked and which pane's {@link Realm} to provide —
   *  the one place every surface (key, socket, CLI, agent) goes through. */
  readonly run: {
    (
      command: Command,
      invocation: CommandInvocation,
    ): Effect.Effect<AnyCommandResult, CommandError>;
    (
      command: RuntimeCommand,
      invocation: CommandInvocation,
    ): Effect.Effect<unknown, CommandError>;
  };
  /**
   * Provide {@link Realm} (and {@link CurrentInvocation}) for a key-dispatched
   * body that is not itself a `run` call — editor context verbs that still
   * yield Realm directly. Same resolver {@link run} uses; not a second channel.
   */
  readonly withRealm: <A, E, R>(
    invocation: CommandInvocation,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Realm | CurrentInvocation>>;
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
   * Declared resources for a decoded command value. Undefined when the tag is
   * unregistered — the next gate (Commands.run) only asks after a successful
   * decode against a known entry.
   */
  readonly resourcesFor: (command: RuntimeCommand) => readonly string[] | undefined;
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
    resources: (args: S.Struct.Type<Fields>) => readonly string[],
    handler: (
      args: S.Struct.Type<Fields>,
    ) => Effect.Effect<unknown, CommandError, Realm | CurrentInvocation>,
  ) => () => void;
  /**
   * Claim a full tag — one core never declared but a daemon-resident plugin
   * authors, like `agent.new`. Same validation and disposal contract as
   * `registerCommand`, minus the namespacing: the tag must match the daemon
   * side exactly, or the forwarder below addresses nothing. A tag core or
   * another plugin already holds is refused, never shadowed.
   */
  readonly registerFullCommand: <Fields extends S.Struct.Fields>(
    tag: string,
    fields: Fields,
    meta: Meta,
    resources: (args: S.Struct.Type<Fields>) => readonly string[],
    handler: (
      args: S.Struct.Type<Fields>,
    ) => Effect.Effect<unknown, CommandError, Realm | CurrentInvocation>,
  ) => () => void;
}

export type MakeCommandsOptions = {
  /** Resolve a pane id to the realm bindings that pane published. */
  readonly realmForPane?: (paneId: string) => RealmValue;
};

export const makeCommands = (
  handlers: CommandHandlers | CommandHandlerTable,
  options: MakeCommandsOptions = {},
): Commands => {
  const entries = new Map<string, CommandEntry>(
    COMMAND_DEFS.map((def) => [
      def.tag,
      {
        meta: COMMAND_META[def.tag],
        schema: def.schema,
        resources: def.resources as (args: any) => readonly string[],
        handler:
          (handlers as CommandHandlerTable)[def.tag] ??
          (() => Effect.fail(new CommandError({ message: `unknown command: ${def.tag}` }))),
      },
    ]),
  );

  const metaFor = (tag: string): CommandMeta | undefined => entries.get(tag)?.meta;

  const realmOfInvocation = (invocation: CommandInvocation): RealmValue => {
    if (invocation.pane === undefined || options.realmForPane === undefined) return NO_REALM;
    return options.realmForPane(invocation.pane);
  };

  const withRealm = <A, E, R>(
    invocation: CommandInvocation,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, Realm | CurrentInvocation>> =>
    // provideService drops the service from R; the assertion names the two we add.
    // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
    effect.pipe(
      Effect.provideService(CurrentInvocation, invocation),
      Effect.provideService(Realm, realmOfInvocation(invocation)),
    ) as Effect.Effect<A, E, Exclude<R, Realm | CurrentInvocation>>;

  const claim = (
    tag: string,
    fields: S.Struct.Fields,
    meta: Meta,
    resources: (args: any) => readonly string[],
    handler: (
      args: any,
    ) => Effect.Effect<unknown, CommandError, Realm | CurrentInvocation>,
  ): (() => void) => {
    if (metaFor(tag)) throw new Error(`command already registered: ${tag}`);
    const schema = S.TaggedStruct(tag, fields).annotate({
      identifier: tag,
      description: meta.desc,
    });
    const entry: CommandEntry = {
      meta: {
        name: tag,
        desc: meta.desc,
        group: meta.group,
        target: meta.target,
        exposure: meta.exposure,
      },
      schema: schema as any,
      resources,
      handler,
    };
    entries.set(tag, entry);
    return () => {
      if (entries.get(tag) === entry) entries.delete(tag);
    };
  };

  const registerCommand: Commands["registerCommand"] = (
    pluginId,
    verb,
    fields,
    meta,
    resources,
    handler,
  ) => claim(`plugin.${pluginId}.${verb}`, fields, meta, resources, handler);

  const registerFullCommand: Commands["registerFullCommand"] = (
    tag,
    fields,
    meta,
    resources,
    handler,
  ) => claim(tag, fields, meta, resources, handler);

  const resourcesFor: Commands["resourcesFor"] = (command) => {
    const entry = entries.get(command._tag);
    return entry === undefined ? undefined : entry.resources(command);
  };

  const run = ((command: RuntimeCommand, invocation: CommandInvocation) =>
    // Suspended, because a caller builds the effect once — a binding's `run` is
    // built when the table is built — and the handler has to read the workspace
    // at the moment it runs, not at the moment it was named.
    Effect.suspend(() => {
      const entry = entries.get(command._tag);
      if (!entry)
        return Effect.fail(new CommandError({ message: `unknown command: ${command._tag}` }));
      return withRealm(
        invocation,
        S.decodeEffect(entry.schema)(command).pipe(
          Effect.mapError(
            (error) =>
              new CommandError({
                message: `${command._tag}: ${formatSchemaIssue(error.issue)}`,
              }),
          ),
          Effect.flatMap(entry.handler),
        ),
      );
    })) as Commands["run"];

  const list: Commands["list"] = (filter) => {
    const all = [...entries.values()].map((entry) => entry.meta);
    return all.filter(
      (m) =>
        (!filter?.target || m.target === filter.target) &&
        (!filter?.exposure || m.exposure === filter.exposure),
    );
  };

  return {
    run,
    withRealm,
    list,
    isWorkspaceCommand: (tag) => {
      const meta = metaFor(tag);
      return meta ? isWorkspaceCommandByTarget(meta.target) : false;
    },
    isRemoteCommand: (tag) => {
      const meta = metaFor(tag);
      return meta ? isRemoteCommand(meta.target) : false;
    },
    resourcesFor,
    registerCommand,
    registerFullCommand,
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
 *
 * Prefer passing `runtime` (the workspace RootRuntime / `Effect.context()`)
 * so logging and any services the command needs stay ambient — bare
 * `Effect.runFork` drops the DI bag at the Solid/keymap boundary.
 */
export function runDetached(
  label: string,
  effect: Effect.Effect<any, CommandError>,
  onError?: (message: string) => void,
  runtime?: RootRuntimeContext,
): void {
  const fork = runtime !== undefined ? Effect.runForkWith(runtime) : Effect.runFork;
  fork(Effect.asVoid(effect)).addObserver((exit) => {
    if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
    const message = `command ${label} failed: ${Cause.pretty(exit.cause)}`;
    fork(Effect.logError(message));
    onError?.(message);
  });
}

export const Commands = {
  PaneSplit,
  PaneOpenPlugin,
  PaneNext,
  PaneLast,
  PaneFocus,
  PaneSelect,
  PaneResize,
  PaneResizeDivider,
  PaneSetSize,
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
  PaneSetDescriptor,
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
  WorkspaceRebuildTiling,
  WindowList,
  Notify,
  SessionKill,
  SessionMessage,
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
