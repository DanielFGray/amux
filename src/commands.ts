import { Cause, Effect, Exit, Schema } from "effect";
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

/**
 * Who may invoke a command.
 *
 * Monotone, so a surface filters with `>=` rather than a set membership test:
 * `local` is the keymap only, `remote` adds the control socket and the CLI, and
 * `agent` adds the tool surface an agent driving the mux sees. `app.settings`
 * over a socket is meaningless and handing an agent all 30-odd verbs is a
 * footgun, so the level is declared per verb rather than assumed.
 */
export const CAPABILITIES = ["local", "remote", "agent"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const atLeast = (capability: Capability, floor: Capability): boolean =>
  CAPABILITIES.indexOf(capability) >= CAPABILITIES.indexOf(floor);

/**
 * A command that could not do what it was asked.
 *
 * Declared rather than thrown: the send-keys prompt keeps itself open with the
 * reason in it, which it can only do if a rejection is a value it can read. A
 * *missing* target is not one of these — pressing `^a z` with no window is a
 * no-op, the way it has always been.
 */
export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  message: Schema.String,
}) {}

interface Meta {
  readonly desc: string;
  readonly group: string;
  readonly capability: Capability;
}

const define = <const Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
  meta: Meta,
) => ({
  tag,
  ...meta,
  // `description` is an annotation and not merely a field on this object
  // because that is what a derived JSON Schema carries: the agent tool surface
  // gets its descriptions from here rather than from a second table written by
  // hand and kept in step by hope.
  schema: Schema.TaggedStruct(tag, fields).annotations({ identifier: tag, description: meta.desc }),
});

/**
 * Which window, space or agent a command acts on.
 *
 * Absent means "the active one", which is what a keybinding almost always
 * means. The sidebar is why the fields exist at all: its `x` kills the SELECTED
 * row, and before commands took arguments that was a second copy of
 * agent.kill / window.close / space.close aimed somewhere else.
 */
const Space = { space: Schema.optional(Schema.String) };
const Window = { ...Space, window: Schema.optional(Schema.Int) };
const Agent = { agent: Schema.optional(Schema.String) };

const Axis = Schema.Literal("row", "column");
const Direction = Schema.Literal("left", "right", "up", "down");

// Panes.
const PaneSplit = define(
  "pane.split",
  { axis: Axis },
  {
    desc: "split the focused pane",
    group: "panes",
    capability: "agent",
  },
);
const PaneNext = define(
  "pane.next",
  {},
  { desc: "focus the next pane", group: "panes", capability: "agent" },
);
const PaneLast = define(
  "pane.last",
  {},
  {
    desc: "toggle to the last-focused pane",
    group: "panes",
    capability: "agent",
  },
);
const PaneFocus = define(
  "pane.focus",
  { direction: Direction },
  {
    desc: "focus the pane in a direction",
    group: "panes",
    capability: "agent",
  },
);
const PaneSelect = define(
  "pane.select",
  { pane: Schema.String },
  {
    desc: "focus a pane by id",
    group: "panes",
    capability: "agent",
  },
);
const PaneResize = define(
  "pane.resize",
  { direction: Direction },
  {
    desc: "resize the focused pane",
    group: "panes",
    capability: "agent",
  },
);
const PaneResizeDivider = define(
  "pane.resize-divider",
  {
    path: Schema.Array(Schema.Int),
    index: Schema.Int,
    delta: Schema.Int,
  },
  {
    desc: "move a layout divider",
    group: "panes",
    capability: "remote",
  },
);
const PaneZoom = define(
  "pane.zoom",
  {},
  {
    desc: "zoom the focused pane",
    group: "panes",
    capability: "agent",
  },
);
const PaneSwap = define(
  "pane.swap",
  { to: Schema.Literal("previous", "next") },
  {
    desc: "swap the focused pane with its neighbour",
    group: "panes",
    capability: "agent",
  },
);
const PaneClose = define(
  "pane.close",
  {},
  {
    desc: "close the focused pane, leaving its agent running",
    group: "panes",
    capability: "agent",
  },
);
const PaneBreak = define(
  "pane.break",
  {},
  {
    desc: "break the focused pane into its own window",
    group: "panes",
    capability: "agent",
  },
);
const PaneSendKeys = define(
  "pane.send-keys",
  { keys: Schema.String },
  {
    desc: "send keys to the focused pane",
    group: "panes",
    capability: "agent",
  },
);
// Capture and copy mode open a local overlay. There is nothing to return to a
// caller that is not sitting in front of the screen, so they stay local — the
// remote way to read a pane is a verb that answers with the text, and that verb
// belongs to the control API rather than to the overlay.
const PaneCapture = define(
  "pane.capture",
  {},
  {
    desc: "capture the focused pane into a popup",
    group: "panes",
    capability: "local",
  },
);
const PaneCopyMode = define(
  "pane.copy-mode",
  {},
  {
    desc: "review pane history",
    group: "panes",
    capability: "local",
  },
);

// Buffers — tmux's paste-buffer family. The stack itself lives on the daemon,
// next to the PTYs it pastes into; these verbs are the surfaces' door to it.
// paste and choose need a screen (the focused pane / an overlay), the rest are
// pure server operations and therefore scriptable.
const BufferSet = define(
  "buffer.set",
  { name: Schema.optional(Schema.String), data: Schema.String },
  {
    desc: "set a paste buffer (a copy pushes onto the stack automatically)",
    group: "buffers",
    capability: "remote",
  },
);
const BufferPaste = define(
  "buffer.paste",
  { name: Schema.optional(Schema.String) },
  {
    desc: "paste the top paste buffer into the focused pane",
    group: "buffers",
    capability: "local",
  },
);
const BufferList = define(
  "buffer.list",
  {},
  {
    desc: "list the paste buffers",
    group: "buffers",
    capability: "remote",
  },
);
const BufferDelete = define(
  "buffer.delete",
  { name: Schema.optional(Schema.String) },
  {
    desc: "delete the top paste buffer (or a named one)",
    group: "buffers",
    capability: "remote",
  },
);
const BufferShow = define(
  "buffer.show",
  { name: Schema.optional(Schema.String) },
  {
    desc: "show a paste buffer's contents",
    group: "buffers",
    capability: "remote",
  },
);
const BufferChoose = define(
  "buffer.choose",
  {},
  {
    desc: "choose a paste buffer to paste",
    group: "buffers",
    capability: "local",
  },
);

// Windows.
const WindowNew = define(
  "window.new",
  {},
  { desc: "new window", group: "windows", capability: "agent" },
);
const WindowNext = define(
  "window.next",
  {},
  { desc: "next window", group: "windows", capability: "agent" },
);
const WindowPrevious = define(
  "window.previous",
  {},
  {
    desc: "previous window",
    group: "windows",
    capability: "agent",
  },
);
const WindowLast = define(
  "window.last",
  {},
  {
    desc: "toggle to the last window",
    group: "windows",
    capability: "agent",
  },
);
const WindowSelect = define(
  "window.select",
  { ...Space, number: Schema.Int },
  {
    desc: "select a window by its number",
    group: "windows",
    capability: "agent",
  },
);
const WindowRename = define(
  "window.rename",
  { ...Window, name: Schema.String },
  {
    // An empty name is not a validation failure: it hands the title back to
    // whatever the window is running, which is the only way to undo a rename.
    desc: "rename a window; an empty name restores the running command's title",
    group: "windows",
    capability: "agent",
  },
);
const WindowClose = define("window.close", Window, {
  desc: "kill a window and its agents",
  group: "windows",
  capability: "agent",
});
const WindowNextLayout = define(
  "window.next-layout",
  {},
  {
    desc: "cycle through the preset layouts",
    group: "windows",
    capability: "agent",
  },
);
const WindowSelectLayout = define(
  "window.select-layout",
  { preset: Schema.Literal(...LAYOUT_PRESETS) },
  {
    desc: "arrange panes in a preset layout",
    group: "windows",
    capability: "agent",
  },
);
const WindowSynchronize = define(
  "window.synchronize-panes",
  {},
  {
    desc: "toggle synchronize-panes (input to every pane)",
    group: "windows",
    capability: "agent",
  },
);

// Agents.
const AgentKill = define("agent.kill", Agent, {
  desc: "stop an agent",
  group: "agents",
  capability: "agent",
});
const AgentReveal = define(
  "agent.reveal",
  { agent: Schema.String },
  {
    desc: "show and focus an agent",
    group: "agents",
    capability: "agent",
  },
);
const AgentNextBlocked = define(
  "agent.next-blocked",
  {},
  {
    desc: "select the next blocked agent",
    group: "agents",
    capability: "agent",
  },
);

// Spaces.
const SpaceNew = define(
  "space.new",
  {
    name: Schema.optional(Schema.String),
    dir: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    base: Schema.optional(Schema.String),
  },
  {
    desc: "new space",
    group: "spaces",
    capability: "agent",
  },
);
const SpaceSelect = define(
  "space.select",
  { space: Schema.String },
  {
    desc: "select a space by id",
    group: "spaces",
    capability: "agent",
  },
);
const SpaceRename = define(
  "space.rename",
  { ...Space, name: Schema.String },
  {
    desc: "rename a space",
    group: "spaces",
    capability: "agent",
  },
);
const SpaceClose = define("space.close", Space, {
  desc: "close a space and everything in it",
  group: "spaces",
  capability: "agent",
});
const SpaceNext = define(
  "space.next",
  {},
  { desc: "next space", group: "spaces", capability: "agent" },
);
const SpacePrevious = define(
  "space.previous",
  {},
  {
    desc: "previous space",
    group: "spaces",
    capability: "agent",
  },
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
  {
    name: Schema.String,
    value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
  },
  {
    desc: "set an option",
    group: "config",
    capability: "remote",
  },
);
const ConfigToggle = define(
  "config.toggle",
  { name: Schema.String },
  {
    desc: "flip a yes/no option",
    group: "config",
    capability: "remote",
  },
);
const ConfigAdjust = define(
  "config.adjust",
  { name: Schema.String, by: Schema.Int },
  {
    desc: "move a numeric option by a step",
    group: "config",
    capability: "remote",
  },
);
const ConfigReset = define(
  "config.reset",
  { name: Schema.String },
  {
    desc: "put an option back to its default",
    group: "config",
    capability: "remote",
  },
);

// The app itself. These drive overlays and the local terminal, so they are the
// bulk of what `local` is for.
const AppHelp = define("app.help", {}, { desc: "keybinds", group: "global", capability: "local" });
const AppPalette = define(
  "app.command-palette",
  {},
  {
    desc: "search and run commands",
    group: "global",
    capability: "local",
  },
);
const AppSettings = define(
  "app.settings",
  {},
  { desc: "settings", group: "global", capability: "local" },
);
const AppSendPrefix = define(
  "app.send-prefix",
  {},
  {
    desc: "send a literal prefix key",
    group: "global",
    capability: "local",
  },
);
// Remote but not agent: closing the client a person is looking at is a
// legitimate thing to script and not a thing to hand an agent.
const AppQuit = define("app.quit", {}, { desc: "quit", group: "global", capability: "remote" });

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
  PaneSwap,
  PaneClose,
  PaneBreak,
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
  AgentKill,
  AgentReveal,
  AgentNextBlocked,
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

/**
 * The union, derived from the list rather than written out beside it.
 *
 * A member that is not in COMMAND_DEFS is not in the union and has no handler,
 * so there is no way to declare a verb and forget to expose it.
 */
export const Command = Schema.Union(...COMMAND_DEFS.map((def) => def.schema));
export type Command = typeof Command.Type;
export type CommandTag = Command["_tag"];

export type CommandOf<T extends CommandTag> = Extract<Command, { _tag: T }>;
type ArgsOf<T extends CommandTag> = Omit<CommandOf<T>, "_tag">;

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
export const decodeCommand = Schema.decodeUnknown(Command);

/** What a command is, for the palette, the help, and the agent tool surface. */
export interface CommandMeta {
  readonly name: CommandTag;
  readonly desc: string;
  readonly group: string;
  readonly capability: Capability;
}

/** Metadata by tag, so a binding can take its group and its default
 *  description from the verb it invokes rather than restating them. */
export const COMMAND_META = Object.fromEntries(
  COMMAND_DEFS.map((def) => [
    def.tag,
    { name: def.tag, desc: def.desc, group: def.group, capability: def.capability },
  ]),
) as Record<CommandTag, CommandMeta>;

/**
 * What each verb actually does.
 *
 * Keyed by tag and total over the union, so adding a member to COMMAND_DEFS is
 * a type error until it does something.
 */
export type CommandHandlers = {
  readonly [T in CommandTag]: (args: CommandOf<T>) => Effect.Effect<void, CommandError>;
};

export interface Commands {
  /** Run a command. Local dispatch, not a round trip: the keymap needs the
   *  effect's synchronous prefix to run in the keypress it was dispatched from. */
  readonly run: (command: Command) => Effect.Effect<void, CommandError>;
  /** Every verb and what it is, for whichever surface is listing them. */
  readonly list: (floor?: Capability) => CommandMeta[];
}

export const makeCommands = (handlers: CommandHandlers): Commands => ({
  // Suspended, because a caller builds the effect once — a binding's `run` is
  // built when the table is built — and the handler has to read the workspace
  // at the moment it runs, not at the moment it was named.
  run: (command) =>
    Effect.suspend(() =>
      (handlers[command._tag] as (args: Command) => Effect.Effect<void, CommandError>)(command),
    ),
  list: (floor = "local") =>
    COMMAND_DEFS.filter((def) => atLeast(def.capability, floor)).map(
      (def) => COMMAND_META[def.tag],
    ),
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
  effect: Effect.Effect<void, CommandError>,
  onError?: (message: string) => void,
): void {
  Effect.runFork(effect).addObserver((exit) => {
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
  PaneSwap,
  PaneClose,
  PaneBreak,
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
  AgentKill,
  AgentReveal,
  AgentNextBlocked,
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
