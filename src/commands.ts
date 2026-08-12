import { Cause, Effect, Exit, JSONSchema, Schema as S } from "effect";
import { LAYOUT_PRESETS } from "./layout.ts";

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

/** Who the command is exposed TO — a human or an agent. */
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

const Axis = S.Literal("row", "column");
const Direction = S.Literal("left", "right", "up", "down");

// Panes.
const PaneSplit = define(
  "pane.split",
  { axis: Axis },
  { desc: "split the focused pane", group: "panes", target: "workspace", exposure: "agent" },
);
const PaneNext = define(
  "pane.next",
  {},
  { desc: "focus the next pane", group: "panes", target: "workspace", exposure: "agent" },
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
  { desc: "focus the pane in a direction", group: "panes", target: "workspace", exposure: "agent" },
);
const PaneSelect = define(
  "pane.select",
  { pane: S.String },
  { desc: "focus a pane by id", group: "panes", target: "workspace", exposure: "agent" },
);
const PaneResize = define(
  "pane.resize",
  { direction: Direction },
  { desc: "resize the focused pane", group: "panes", target: "workspace", exposure: "agent" },
);
const PaneResizeDivider = define(
  "pane.resize-divider",
  { path: S.Array(S.Int), index: S.Int, delta: S.Int },
  { desc: "move a layout divider", group: "panes", target: "workspace", exposure: "human" },
);
const PaneZoom = define(
  "pane.zoom",
  {},
  { desc: "zoom the focused pane", group: "panes", target: "workspace", exposure: "agent" },
);
const PaneFloat = define(
  "pane.float",
  {},
  {
    desc: "toggle the focused pane between floating and tiled",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneSwap = define(
  "pane.swap",
  { to: S.Literal("previous", "next") },
  {
    desc: "swap the focused pane with its neighbour",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneClose = define(
  "pane.close",
  {},
  {
    desc: "close the focused pane and stop its backend if it has no other view",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneBreak = define(
  "pane.break",
  {},
  {
    desc: "break the focused pane into its own window",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneJoin = define(
  "pane.join",
  { source: S.optional(S.Int) },
  {
    desc: "join a pane from another window into the focused window",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneMove = define(
  "pane.move",
  { space: S.String },
  {
    desc: "move the focused pane into another space",
    group: "panes",
    target: "workspace",
    exposure: "agent",
  },
);
const PaneSendKeys = define(
  "pane.send-keys",
  { keys: S.String },
  { desc: "send keys to the focused pane", group: "panes", target: "workspace", exposure: "agent" },
);
// Capture and copy mode open a local overlay. The remote way to read a pane is
// a daemon-side terminal capture: pane.capture's result is the text.
const PaneCapture = define(
  "pane.capture",
  { session: S.optional(S.String) },
  {
    desc: "capture the focused pane",
    group: "panes",
    target: "session",
    exposure: "agent",
  },
  S.String,
);
const PaneCopyMode = define(
  "pane.copy-mode",
  {},
  { desc: "review pane history", group: "panes", target: "view", exposure: "human" },
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
  { desc: "list the paste buffers", group: "buffers", target: "buffers", exposure: "agent" },
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
  { desc: "choose a paste buffer to paste", group: "buffers", target: "view", exposure: "human" },
);

// Windows.
const WindowNew = define(
  "window.new",
  {},
  { desc: "new window", group: "windows", target: "workspace", exposure: "agent" },
);
const WindowNext = define(
  "window.next",
  {},
  { desc: "next window", group: "windows", target: "workspace", exposure: "agent" },
);
const WindowPrevious = define(
  "window.previous",
  {},
  { desc: "previous window", group: "windows", target: "workspace", exposure: "agent" },
);
const WindowLast = define(
  "window.last",
  {},
  { desc: "toggle to the last window", group: "windows", target: "workspace", exposure: "agent" },
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

// Agents.
const SessionKill = define("session.kill", SessionTarget, {
  desc: "stop a session",
  group: "sessions",
  target: "workspace",
  exposure: "agent",
});
const AgentSteer = define(
  "agent.steer",
  { ...SessionTarget, message: S.String },
  { desc: "send a message to an agent", group: "agents", target: "workspace", exposure: "human" },
);
const AgentInterrupt = define(
  "agent.interrupt",
  { ...SessionTarget, reason: S.optional(S.String) },
  { desc: "interrupt an agent turn", group: "agents", target: "workspace", exposure: "human" },
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
    harness: S.optional(S.String.pipe(S.minLength(1))),
    cmd: S.optional(S.Array(S.String.pipe(S.minLength(1))).pipe(S.minItems(1))),
    prompt: S.optional(S.String),
  },
  { desc: "start a coding agent", group: "agents", target: "workspace", exposure: "human" },
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
  { desc: "show and focus a session", group: "sessions", target: "workspace", exposure: "agent" },
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
  { desc: "new space", group: "spaces", target: "workspace", exposure: "agent" },
);
const SpaceSelect = define(
  "space.select",
  { space: S.String },
  { desc: "select a space by id", group: "spaces", target: "workspace", exposure: "agent" },
);
const SpaceRename = define(
  "space.rename",
  { ...Space, name: S.String },
  { desc: "rename a space", group: "spaces", target: "workspace", exposure: "agent" },
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
  { desc: "next space", group: "spaces", target: "workspace", exposure: "agent" },
);
const SpacePrevious = define(
  "space.previous",
  {},
  { desc: "previous space", group: "spaces", target: "workspace", exposure: "agent" },
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
  { desc: "flip a yes/no option", group: "config", target: "view", exposure: "human" },
);
const ConfigAdjust = define(
  "config.adjust",
  { name: S.String, by: S.Int },
  { desc: "move a numeric option by a step", group: "config", target: "view", exposure: "human" },
);
const ConfigReset = define(
  "config.reset",
  { name: S.String },
  { desc: "put an option back to its default", group: "config", target: "view", exposure: "human" },
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
  { desc: "search and run commands", group: "global", target: "view", exposure: "human" },
);
const AppSettings = define(
  "app.settings",
  {},
  { desc: "settings", group: "global", target: "view", exposure: "human" },
);
const AppSendPrefix = define(
  "app.send-prefix",
  {},
  { desc: "send a literal prefix key", group: "global", target: "view", exposure: "human" },
);
const AppQuit = define(
  "app.quit",
  {},
  { desc: "quit", group: "global", target: "server", exposure: "human" },
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
  PaneSwap,
  PaneClose,
  PaneBreak,
  PaneJoin,
  PaneMove,
  PaneSendKeys,
  PaneCapture,
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
  AgentNew,
  AgentSteer,
  AgentInterrupt,
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
  ConfigSet,
  ConfigToggle,
  ConfigAdjust,
  ConfigReset,
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

/** What a command is, for the palette, the help, and the agent tool surface. */
export interface CommandMeta {
  readonly name: CommandTag;
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

export interface Commands {
  /** Run a command. Local dispatch, not a round trip: the keymap needs the
   *  effect's synchronous prefix to run in the keypress it was dispatched from. */
  readonly run: <T extends CommandTag = CommandTag>(
    command: Command,
  ) => Effect.Effect<AnyCommandResult, CommandError>;
  /** Every verb and what it is, for whichever surface is listing them. */
  readonly list: (filter?: { target?: CommandTarget; exposure?: CommandExposure }) => CommandMeta[];
  /** Whether a command tag targets the workspace. */
  readonly isWorkspaceCommand: (tag: CommandTag) => boolean;
  /** Whether a command tag is remotely invocable. */
  readonly isRemoteCommand: (tag: CommandTag) => boolean;
}

export const makeCommands = (handlers: CommandHandlers): Commands => ({
  // Suspended, because a caller builds the effect once — a binding's `run` is
  // built when the table is built — and the handler has to read the workspace
  // at the moment it runs, not at the moment it was named.
  run: (command) =>
    Effect.suspend(() =>
      (handlers[command._tag] as (args: Command) => Effect.Effect<AnyCommandResult, CommandError>)(
        command,
      ),
    ),
  list: (filter) => {
    let defs = COMMAND_DEFS as unknown as readonly {
      tag: CommandTag;
      target: CommandTarget;
      exposure: CommandExposure;
    }[];
    if (filter?.target) defs = defs.filter((d) => d.target === filter.target);
    if (filter?.exposure) defs = defs.filter((d) => d.exposure === filter.exposure);
    return defs.map((def) => COMMAND_META[def.tag]!);
  },
  isWorkspaceCommand: (tag) => isWorkspaceCommandByTarget(COMMAND_META[tag]!.target),
  isRemoteCommand: (tag) => isRemoteCommand(COMMAND_META[tag]!.target),
});

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
  ConfigSet,
  ConfigToggle,
  ConfigAdjust,
  ConfigReset,
  AppHelp,
  AppPalette,
  AppSettings,
  AppSendPrefix,
  AppQuit,
};
