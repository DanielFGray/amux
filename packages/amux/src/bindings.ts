import { Effect, Schema as S } from "effect";
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import { createOpenTuiKeymap } from "@opentui/keymap/opentui";
import {
  registerDefaultKeys,
  registerEnabledFields,
  registerLeader,
  registerMetadataFields,
  registerEscapeClearsPendingSequence,
  registerNeovimDisambiguation,
} from "@opentui/keymap/addons";
import { createGraphExtra } from "@opentui/keymap/extras/graph";
import type { CommandContext, Keymap, KeySequencePart } from "@opentui/keymap";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { KeyStroke } from "./keys.ts";
import {
  runDetached,
  CurrentInvocation,
  type CommandError,
  type CommandInvocation,
  type Commands,
} from "./commands.ts";
import { CONTEXT_PRIORITY, type ContextSpec } from "./key-context.ts";
import {
  createCountAccumulator,
  KeyDataSchema,
  KeyInvocation,
  type KeyInvocationValue,
} from "./key-invocation.ts";
import { NO_REALM, Realm } from "./realm.ts";
import { createConstraintTable, refuseIfDenied, type ConstraintTable } from "./constraint.ts";
import type { RootRuntimeContext } from "./env.ts";

export type AppKeymap = Keymap<Renderable, KeyEvent>;

/**
 * Mux prefix (`<prefix>`). Defaults to ctrl+s — a non-typing chord so shell
 * input is never eaten. Rebindable via `keys.prefix` / settings. Not a
 * "leader": that word is reserved for the editor mapleader.
 */
export const DEFAULT_PREFIX = "ctrl+s";

/**
 * Editor mapleader (`<leader>`). Defaults to space — vim-style, only
 * meaningful while an editor context is active. Rebindable via `keys.leader`
 * / settings. Must stay separate from the mux prefix: space-as-`<prefix>`
 * steals every space typed into a PTY.
 */
export const DEFAULT_LEADER = "space";

/**
 * Ambiguous exact-vs-prefix wait, in ms. Cite: neovim `'timeoutlen'`
 * (input.c / handle_mapping). Wired via OpenTUI
 * `registerNeovimDisambiguation` on the shared keymap pending sequence.
 */
export const DEFAULT_TIMEOUTLEN_MS = 1000;

/**
 * How a pending sequence part reads for showcmd / which-key titles.
 * Tokenized leaders keep angle brackets (`<leader>`, `<prefix>`).
 */
export function pendingStrokeDisplay(part: {
  readonly display: string;
  readonly tokenName?: string;
}): string {
  return part.tokenName !== undefined ? `<${part.tokenName}>` : part.display;
}

/** What the user has changed: the mux prefix, editor leader, and per-command sequences. */
export interface Keys {
  /** Mux chord prefix (`<prefix>`). */
  prefix: string;
  /** Editor mapleader (`<leader>`). */
  leader: string;
  /** Command name -> sequences. Absent means the command's own default; an
   *  empty array means deliberately unbound. */
  bindings: Record<string, string[]>;
}

export const DEFAULT_KEYS: Keys = {
  prefix: DEFAULT_PREFIX,
  leader: DEFAULT_LEADER,
  bindings: {},
};

/** Display helpers: which physical keys the two prefix tokens currently map to. */
export interface LeaderDisplay {
  readonly prefix?: string;
  readonly leader?: string;
}

/**
 * How one compiled key reads on screen.
 *
 * Prefix tokens stay keymap *tokens* rather than being expanded into raw
 * strokes — that is what makes them rebindable in one place. Substitution
 * happens at display time: `<prefix> x` reads as `^s x`, `<leader> /`
 * as `SPC /`.
 */
export function formatKey(
  display: string,
  leaderOrDisplay: string | LeaderDisplay = DEFAULT_PREFIX,
): string {
  const leaders: LeaderDisplay =
    typeof leaderOrDisplay === "string"
      ? { prefix: leaderOrDisplay, leader: DEFAULT_LEADER }
      : {
          prefix: leaderOrDisplay.prefix ?? DEFAULT_PREFIX,
          leader: leaderOrDisplay.leader ?? DEFAULT_LEADER,
        };
  if (display === "<prefix>") {
    const prefix = leaders.prefix!;
    if (prefix === "<prefix>") return "<prefix>";
    return formatKey(prefix, leaders);
  }
  if (display === "<leader>") {
    const leader = leaders.leader!;
    if (leader === "<leader>") return "<leader>";
    return formatKey(leader, leaders);
  }
  // `shift+s` is how a capital has to be *written* — a bare "S" compiles to the
  // same sequence as "s" — but "S" is how it is pressed and read.
  const shifted = display.match(/^shift\+([a-z])$/);
  if (shifted) return shifted[1]!.toUpperCase();
  if (display === "space") return "SPC";
  return display.replace(/^ctrl\+/, "^").replace(/^alt\+/, "M-");
}

/** Turn a compiled sequence into something worth showing a human. */
export function formatSequence(
  parts: readonly { display: string }[],
  leaderOrDisplay: string | LeaderDisplay = DEFAULT_PREFIX,
): string {
  return parts.map((p) => formatKey(p.display, leaderOrDisplay)).join(" ");
}

/**
 * A keystroke as a binding string, e.g. "ctrl+b" or "shift+s".
 *
 * Returns null for anything that cannot be bound on its own — a bare modifier,
 * or a key release — so a capture can keep waiting rather than recording the
 * shift the user pressed on the way to the key they meant.
 */
const MODIFIER_KEYS = new Set([
  "shift",
  "ctrl",
  "control",
  "alt",
  "option",
  "meta",
  "super",
  "hyper",
  "capslock",
  "numlock",
]);

export function keyToBinding(event: KeyEvent): string | null {
  if (event.eventType === "release") return null;
  let name = event.name;
  if (!name || MODIFIER_KEYS.has(name.toLowerCase())) return null;

  const parts: string[] = [];
  if (event.ctrl) parts.push("ctrl");
  if (event.meta || event.option) parts.push("alt");
  // Shift is only its own modifier on letters and named keys. On punctuation it
  // is how the character was *produced* — "shift+|" is not a thing anyone can
  // press, "|" is.
  const letter = /^[A-Za-z]$/.test(name);
  if (letter) {
    if (event.shift || name !== name.toLowerCase()) parts.push("shift");
    name = name.toLowerCase();
  } else if (event.shift && name.length > 1) {
    parts.push("shift");
  }
  parts.push(name);
  return parts.join("+");
}

/**
 * A binding string parsed into the strokes that would produce it.
 *
 * The send-keys path uses the same encoder the bindings are written in, so
 * `ctrl+a`, `Enter`, `space` and even `<leader>` mean the same thing in the
 * command prompt as they do in the keybind editor. Returns the whole sequence,
 * not just a single key: `<leader>:` is the prefix then a colon. Returns null
 * for anything the parser rejects outright.
 *
 * Takes anything with `parseKeySequence`, not just `AppKeymap`: the daemon's
 * headless parser (send.ts) is a bare `Keymap` with no renderer behind it,
 * and parsing is the one piece of the interactive keymap it still needs.
 */
export interface KeySequenceSource {
  parseKeySequence(token: string): readonly { stroke?: KeyStroke }[];
}

export function parseKeyStrokes(keymap: KeySequenceSource, token: string): KeyStroke[] | null {
  let parts: readonly { stroke?: KeyStroke }[];
  try {
    parts = keymap.parseKeySequence(token);
  } catch {
    return null;
  }
  if (parts.length === 0) return null;
  const strokes: KeyStroke[] = [];
  for (const part of parts) {
    const stroke = part.stroke;
    if (!stroke?.name) return null;
    strokes.push({
      name: stroke.name,
      ctrl: stroke.ctrl ?? false,
      shift: stroke.shift ?? false,
      meta: stroke.meta ?? false,
      super: stroke.super ?? false,
    });
  }
  return strokes;
}

/**
 * One keybinding: a name, the keys that reach it, and what it invokes.
 *
 * NOT the same thing as a command. A command is a verb with arguments
 * (commands.ts); a binding is one addressable way to run it with the arguments
 * baked in, which is why `^a 1..9` is nine bindings over a single
 * `window.select { number }` — tmux writes the same thing as
 * `bind-key 1 select-window -t 1`. The name is the binding's identity: it is
 * what the keybind editor rebinds and what a config file records, so it stays
 * `window.select-3` even though the command it runs is `window.select`.
 */
export interface CommandSpec {
  /** Dotted name, e.g. "pane.split-row". The namespace doubles as the help group. */
  name: string;
  /** Key sequence, e.g. "<leader>|". Omit for commands with no default binding. */
  key?: string | string[];
  desc: string;
  group: string;
  /**
   * Covered by a sibling entry, so help and hints list it once rather than
   * nine times — `^a 1..9` being the case in point.
   *
   * A flag rather than an empty desc, which is what this used to be: the keymap
   * rejects empty metadata outright, and a rejected command still *compiles its
   * binding*, so `^a 2` looked bound in every readback and silently did nothing
   * when pressed. Every command gets a real description.
   */
  hidden?: boolean;
  /** Left out of the keybind editor. The prefix passthrough is the case: its
   *  sequence is the prefix twice, and rebinding it separately is nonsense. */
  fixed?: boolean;
  /**
   * The context this binding is scoped to, if any. Omitted means global — the
   * binding compiles into the layer that is always active, unchanged from
   * before contexts existed.
   *
   * Set this by calling `contextCommand`, not by hand: the structural
   * reference is what lets `apply` group commands into one keymap layer per
   * context and drive that layer's `enabled` from `context.active`.
   */
  context?: ContextSpec;
  /**
   * What pressing the keys does, as a value rather than a callback.
   *
   * Almost always `commands.run(command(...))` — the binding names a verb and
   * supplies its arguments. The exceptions are the bindings that have to
   * *collect* an argument first: `^a ,` opens a prompt and then invokes
   * `window.rename { name }`, which is tmux's
   * `command-prompt -I "#W" "rename-window '%%'"`. Those are effects that end
   * in a command rather than commands themselves, because a modal prompt is a
   * thing you do to a screen, not a verb a socket can invoke.
   *
   * The effect is built once, when the table is built, so anything it reads
   * from the workspace has to be read *inside* it — `Effect.sync`,
   * `Effect.suspend`, `Effect.gen`. `Commands.run` suspends for exactly this
   * reason. A body that is an Effect can `yield*` the workspace's
   * Effect-returning methods, so a forgotten step is a type error instead of a
   * statement that quietly does nothing (ts-456094, where eight commands did
   * exactly that).
   *
   * `KeyInvocation` in the requirement channel is what a command declares to
   * read the keystroke that ran it — the event, and whatever the dispatching
   * context captured ahead of it (a count, a register, a text object).
   * `Realm` / `CurrentInvocation` are provided by {@link Commands.withRealm}
   * (same path as {@link Commands.run}) at dispatch. Most commands need none
   * and stay `Effect<any, CommandError>`: `never` satisfies any declared
   * requirement, so nothing changes for them.
   */
  run: Effect.Effect<any, CommandError, KeyInvocation | Realm | CurrentInvocation>;
}

/**
 * Register a command through a context: `name` is DERIVED as
 * `${context.id}.${local.name}`, never hand-written and never parsed back
 * apart. The context reference travels on `CommandSpec.context` so `apply`
 * can compile it onto that context's own keymap layer.
 */
export function contextCommand(
  context: ContextSpec,
  local: Omit<CommandSpec, "context">,
): CommandSpec {
  return { ...local, name: `${context.id}.${local.name}`, context };
}

/**
 * Showcmd contribution role. The renderer lays roles out in a fixed order
 * (grammar, chord, count); registrants do not order themselves — that would
 * be a non-commutative chain (paper Def. 44). Cite: ts-5583b8.
 */
export type PendingRole = "count" | "grammar" | "chord";

/** One showcmd contributor. `strokes` is read lazily on notify. */
export interface PendingSource {
  readonly id: string;
  readonly role: PendingRole;
  /** Current display strokes; empty when idle. */
  readonly strokes: () => readonly string[];
}

/**
 * Commutative showcmd table. Count and chord are exclusive (core-owned).
 * Grammar accepts multiple sources and concatenates their strokes — plugins
 * and modes (editor pendingMap, window count) each register their own.
 */
export interface PendingTable {
  register(source: PendingSource): () => void;
  current(): readonly { readonly role: PendingRole; readonly strokes: readonly string[] }[];
  subscribe(listener: () => void): () => void;
  /** Sources call this when their underlying state may have changed. */
  notify(): void;
}

/** Read one role's strokes from the table (tests / diagnostics). */
export const pendingStrokes = (table: PendingTable, role: PendingRole): readonly string[] =>
  table.current().find((entry) => entry.role === role)?.strokes ?? [];

export function createPendingTable(): PendingTable {
  const exclusive = new Map<PendingRole, PendingSource>();
  const grammarSources: PendingSource[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    register(source) {
      if (source.role === "grammar") {
        grammarSources.push(source);
        notify();
        return () => {
          const index = grammarSources.indexOf(source);
          if (index >= 0) {
            grammarSources.splice(index, 1);
            notify();
          }
        };
      }
      const taken = exclusive.get(source.role);
      if (taken !== undefined) {
        throw new Error(`pending role '${source.role}' is already registered by '${taken.id}'`);
      }
      exclusive.set(source.role, source);
      notify();
      return () => {
        if (exclusive.get(source.role) === source) {
          exclusive.delete(source.role);
          notify();
        }
      };
    },
    current() {
      const rows: { readonly role: PendingRole; readonly strokes: readonly string[] }[] = [];
      if (grammarSources.length > 0) {
        rows.push({
          role: "grammar",
          strokes: grammarSources.flatMap((source) => [...source.strokes()]),
        });
      }
      for (const source of exclusive.values()) {
        rows.push({ role: source.role, strokes: source.strokes() });
      }
      return rows;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify,
  };
}

/** The sequences a command answers to right now: the user's, or its own. */
export function keysFor(cmd: CommandSpec, keys: Keys): string[] {
  const override = keys.bindings[cmd.name];
  if (override) return override;
  if (!cmd.key) return [];
  return Array.isArray(cmd.key) ? [...cmd.key] : [cmd.key];
}

export interface Conflict {
  /** The sequence as a human reads it, e.g. "^a k". */
  sequence: string;
  /** Command names claiming it, in registration order. */
  commands: string[];
}

/**
 * The live keymap, plus the means to rebuild it under a new set of keys.
 *
 * Rebinding cannot patch the keymap in place: the leader is a registered
 * *token* and bindings compile against it, so both the token and the layer are
 * disposed and registered again. Everything else — the interceptors, the
 * metadata fields — is registered once and outlives the rebuild.
 */

/**
 * Keymap pending subscription + timeoutlen. Multi-stroke CommandSpecs and
 * sticky prefix-alias modes live on keymap layers / ContextSpecs.
 */
export interface BindingsChords {
  timeoutlenMs(): number;
  subscribePending(listener: (parts: readonly { display: string }[]) => void): () => void;
}

export interface Bindings {
  keymap: AppKeymap;
  /** Pending subscription + timeoutlen (keymap is authority). */
  chords: BindingsChords;
  /**
   * Showcmd contribution table (grammar / chord / count by role). Display
   * only — which-key reads the keymap graph via {@link nextKeys}.
   */
  pending: PendingTable;
  /**
   * Commutative command constraints (move 4). Registrants claim a fixed rank;
   * {@link Bindings}' invoke refuses on deny.
   */
  constraints: ConstraintTable;
  /** Execute a registered command through the keymap's command dispatcher. */
  dispatch: (name: string) => boolean;
  /** Command whose binding is synchronously producing another key, if any. */
  activeCommand: () => string | null;
  /** Mux prefix in effect. Display code needs it to render `<prefix>`. */
  prefix(): string;
  /** Editor leader in effect. Display code needs it to render `<leader>`. */
  leader(): string;
  /** Both tokens, for {@link formatKey} / {@link formatSequence}. */
  leaders(): LeaderDisplay;
  /** Sequences claimed by more than one command as of the last apply. */
  conflicts(): Conflict[];
  /** Commands currently compiled into layers, including context projections. */
  commands(): readonly CommandSpec[];
  /** Keys last passed to {@link Bindings.apply} (rebinds included). */
  keys(): Keys;
  /** Rebuild under `keys`, returning whatever collided. */
  apply(keys: Keys): Conflict[];
  /** Replace the active command list and rebuild under the current keys. */
  setCommands(commands: readonly CommandSpec[]): Conflict[];
  /**
   * Take the next real keystroke instead of dispatching it, for recording a
   * binding. Modifiers alone do not end the capture. Returns a canceller.
   */
  capture(onKey: (event: KeyEvent, binding: string) => void): () => void;
  /** Remove every layer and interceptor installed on the renderer. */
  dispose(): void;
}

/**
 * `keymap.registerLayer`, but a misspelled field cannot pass unnoticed.
 *
 * The library only warns on an unknown layer/binding/command field, then
 * registers the layer anyway — active in every context, since a field it
 * never compiled contributes no `activeWhen`. It also catches any error a
 * field compiler throws and downgrades it to the same kind of warning
 * (`register-layer-failed`), so throwing from inside a `keymap.on("warning",
 * ...)` listener never reaches the caller. Every field name this file passes
 * to a layer is its own, never user config, so the warning can only be this
 * file's own typo: watch for it and throw from outside the call that
 * swallows it.
 */
export function registerLayerChecked(
  keymap: AppKeymap,
  layer: Parameters<AppKeymap["registerLayer"]>[0],
): () => void {
  let badField: string | null = null;
  const stopWatching = keymap.on("warning", ({ code, message }) => {
    if (
      code === "unknown-layer-field" ||
      code === "unknown-binding-field" ||
      code === "unknown-command-field"
    ) {
      badField = message;
    }
  });
  const dispose = keymap.registerLayer(layer);
  stopWatching();
  if (badField) {
    dispose();
    throw new Error(badField);
  }
  return dispose;
}

/**
 * Build the app keymap from a flat command list.
 *
 * Everything downstream reads from this one registration: dispatch, the header
 * hint line, the keybind editor. herdr generates its keybind help from its
 * keybind config for the same reason — a help screen maintained separately
 * from the bindings is a help screen that lies.
 */
export function createBindings(
  renderer: CliRenderer,
  initialCommands: readonly CommandSpec[],
  opts: {
    keys?: Keys;
    /** Return true if the app consumed the key. Returning false leaves it for
     *  whichever renderable holds focus — that is how a focused text input
     *  receives characters. */
    onUnhandled: (event: KeyEvent, reason: string) => boolean;
    /** User-visible command failure sink. Plugins use the same dispatch path as
     * core bindings, so failures must not disappear into stderr. */
    onError?: (message: string) => void;
    /** Workspace RootRuntime so detached command fibers keep ambient services. */
    runtime?: RootRuntimeContext;
    /** Ambiguous exact/prefix wait (neovim `'timeoutlen'`). */
    timeoutlenMs?: number;
    /**
     * Focused pane id for the key invocation record. Read per dispatch —
     * focus moves between keystrokes. Combined with {@link withRealm} so
     * {@link Commands.run} is not the only caller of the shared realm
     * provider: editor context verbs still yield {@link Realm} directly.
     */
    pane?: () => string | undefined;
    /**
     * Provide Realm for a key-dispatched body. Same function {@link Commands.run}
     * uses — bindings do not resolve realms themselves.
     */
    withRealm?: Commands["withRealm"];
  },
): Bindings {
  const keymap = createOpenTuiKeymap(renderer);
  registerDefaultKeys(keymap);
  // `desc` and `group` become queryable attrs, which is what the keybind list
  // groups and labels itself from.
  registerMetadataFields(keymap);
  // Lets a layer carry an `enabled` field that compiles to `activeWhen` —
  // what turns a context's `active()` predicate into the layer's condition.
  registerEnabledFields(keymap);
  // Escape backs out of a half-typed sequence instead of stranding the prefix.
  registerEscapeClearsPendingSequence(keymap);
  // Neovim-style timeoutlen: when a stroke is both an exact binding and a
  // prefix of a longer sequence, wait for a continuation; on timeout run the
  // exact binding. Cite: neovim/src/nvim/input.c handle_mapping +
  // KEYLEN_PART_MAP; @opentui/keymap/addons registerNeovimDisambiguation.
  const timeoutlenMs = opts.timeoutlenMs ?? DEFAULT_TIMEOUTLEN_MS;
  registerNeovimDisambiguation(keymap, {
    timeoutMs: timeoutlenMs,
  });

  let prefix = opts.keys?.prefix ?? DEFAULT_PREFIX;
  let leader = opts.keys?.leader ?? DEFAULT_LEADER;
  let commands = [...initialCommands];
  let currentKeys = opts.keys ?? DEFAULT_KEYS;
  let conflicts: Conflict[] = [];
  let compiledCommands: readonly CommandSpec[] = [];
  let disposeLayers: (() => void)[] = [];
  let disposeContextInterceptors: (() => void)[] = [];
  let disposePrefix: (() => void) | null = null;
  let disposeLeader: (() => void) | null = null;
  let capturing: ((event: KeyEvent, binding: string) => void) | null = null;
  let activeCommand: string | null = null;

  const pendingListeners = new Set<(parts: readonly { display: string }[]) => void>();

  /** Mux counts while keymap pending — not OpenTUI getData. */
  const chordCount = createCountAccumulator();
  const pendingTable = createPendingTable();
  const constraints = createConstraintTable();
  const resetChordCount = () => {
    if (chordCount.digits() === "") return;
    chordCount.reset();
    pendingTable.notify();
  };

  const pendingPartsOf = (sequence: readonly KeySequencePart[]) =>
    sequence.map((part) => ({ display: pendingStrokeDisplay(part) }));

  // Built-in showcmd roles — plugins may add grammar only.
  const disposeCountSource = pendingTable.register({
    id: "amux.bindings.count",
    role: "count",
    strokes: () => {
      const digits = chordCount.digits();
      return digits === "" ? [] : [digits];
    },
  });
  const disposeChordSource = pendingTable.register({
    id: "amux.bindings.chord",
    role: "chord",
    strokes: () => pendingPartsOf(keymap.getPendingSequence()).map((part) => part.display),
  });

  const disposePendingSequence = keymap.on("pendingSequence", (sequence) => {
    const parts = pendingPartsOf(sequence);
    if (sequence.length === 0) resetChordCount();
    for (const listener of pendingListeners) listener(parts);
    pendingTable.notify();
  });

  // Ahead of dispatch, so recording a binding can record keys that are
  // themselves bound — including the prefix, which would otherwise arm a
  // sequence instead of being read.
  const disposeCapture = keymap.intercept(
    "key",
    (ctx) => {
      if (!capturing) return;
      const binding = keyToBinding(ctx.event);
      if (!binding) return;
      const fn = capturing;
      capturing = null;
      ctx.consume({ preventDefault: true });
      ctx.event.preventDefault();
      fn(ctx.event, binding);
    },
    { priority: 1000 },
  );

  /**
   * Digits while keymap-pending are a count (vim `{count}` after a map
   * prefix), not sequence strokes. Mode-local counts (window `80|`) use the
   * context's own beforeDispatch accumulator. Escape clears pending and count;
   * mode exit is the context's Escape binding.
   */
  const disposeCountFeed = keymap.intercept(
    "key",
    (input) => {
      const stroke = keyToBinding(input.event);
      if (stroke !== null && stroke.toLowerCase() === "escape") {
        const hasPending = keymap.getPendingSequence().length > 0;
        const hasCount = chordCount.digits() !== "";
        // Empty pending+count: fall through so a mode Escape binding can leave.
        if (!hasPending && !hasCount) return;
        keymap.clearPendingSequence();
        resetChordCount();
        input.consume({ preventDefault: true });
        input.event.preventDefault();
        return;
      }
      if (input.event.defaultPrevented) return;
      // Read live pending — Solid signals can lag a same-tick observer.
      if (keymap.getPendingSequence().length === 0) return;

      const boundHere = (name: string) =>
        keymap.getActiveKeys().some((key) => key.display === name);

      if (chordCount.offer(input.event, boundHere)) {
        pendingTable.notify();
        input.consume({ preventDefault: true });
        input.event.preventDefault();
        return;
      }

      if (chordCount.digits() !== "") {
        input.setData("count", chordCount.count());
      }
    },
    // All key intercepts run before sequence dispatch; stay below PANE
    // beforeDispatch so editor map counts claim first when that context is on.
    { priority: CONTEXT_PRIORITY.PANE - 1 },
  );

  const disposeAfterKey = keymap.intercept("key:after", (ctx) => {
    if (ctx.reason === "binding-handled") {
      if (chordCount.digits() !== "") resetChordCount();
      else pendingTable.notify();
      return;
    }
    // Neovim map-fail: abandoned prefix then unbound key retries the key alone.
    // OpenTUI clears pending on sequence-miss but does not re-dispatch.
    if (ctx.reason === "sequence-miss") {
      const stroke = keyToBinding(ctx.event);
      if (stroke !== null) {
        const hit = keymap
          .getActiveKeys({ includeBindings: true })
          .find(
            (key) =>
              key.display === stroke && !key.continues && typeof key.command === "string",
          );
        if (hit !== undefined && typeof hit.command === "string") {
          if (keymap.dispatchCommand(hit.command).ok) {
            ctx.consume({ preventDefault: true });
            return;
          }
        }
      }
    }
  });

  // A multiplexer is a pass-through: anything not claimed by a binding belongs
  // to the child. This fires after dispatch, so bound keys and keys that are
  // mid-sequence are already accounted for and never reach a shell.
  const disposeUnhandled = keymap.intercept("key:after", (ctx) => {
    if (ctx.handled) return;
    // preventDefault only when the app really took the key. A focused
    // Renderable skips any event whose default was prevented, so blanket
    // prevention here would stop a text input ever receiving a character.
    if (!opts.onUnhandled(ctx.event, ctx.reason)) return;
    ctx.consume({ preventDefault: true });
    ctx.event.preventDefault();
  });

  /**
   * One dispatch: the command body under the keystroke that ran it.
   * Realm comes from {@link opts.withRealm} with a key invocation built from
   * focus — the same provider {@link Commands.run} uses for socket/CLI.
   */
  function invoke(
    run: CommandSpec["run"],
    invocation: KeyInvocationValue,
    commandName: string,
  ): Effect.Effect<unknown, CommandError> {
    const denied = refuseIfDenied(constraints, commandName);
    if (denied !== null) return Effect.fail(denied);
    const body = run.pipe(Effect.provideService(KeyInvocation, invocation));
    const pane = opts.pane?.();
    const commandInvocation: CommandInvocation =
      pane === undefined ? { source: "key" } : { source: "key", pane };
    // Production always passes Commands.withRealm. The NO_REALM fallback is for
    // bindings tests that never wire a Commands table.
    const provide =
      opts.withRealm ??
      ((inv, effect) =>
        effect.pipe(
          Effect.provideService(CurrentInvocation, inv),
          Effect.provideService(Realm, NO_REALM),
        ));
    return provide(commandInvocation, body);
  }

  function layerContent(group: readonly CommandSpec[], keys: Keys) {
    return {
      bindings: group.flatMap((cmd) =>
        keysFor(cmd, keys)
          .filter((key) => parseable(key))
          .map((key) => ({ key, cmd: cmd.name })),
      ),
      commands: group.map((cmd) => ({
        name: cmd.name,
        desc: cmd.desc,
        group: cmd.group,
        run: (ctx: CommandContext<Renderable, KeyEvent>) => {
          const previous = activeCommand;
          activeCommand = cmd.name;
          try {
            const captured = S.decodeOption(KeyDataSchema)(ctx.data);
            runDetached(
              cmd.name,
              invoke(
                cmd.run,
                {
                  event: ctx.event,
                  data: captured._tag === "Some" ? captured.value : {},
                  input: ctx.input,
                  payload: ctx.payload,
                },
                cmd.name,
              ),
              opts.onError,
              opts.runtime,
            );
          } finally {
            activeCommand = previous;
          }
        },
      })),
    };
  }

  function apply(keys: Keys): Conflict[] {
    currentKeys = keys;
    const requestedPrefix = keys.prefix || DEFAULT_PREFIX;
    prefix = parseable(requestedPrefix, true) ? requestedPrefix : DEFAULT_PREFIX;
    const requestedLeader = keys.leader || DEFAULT_LEADER;
    leader = parseable(requestedLeader, true) ? requestedLeader : DEFAULT_LEADER;
    for (const dispose of disposeLayers) dispose();
    for (const dispose of disposeContextInterceptors) dispose();
    disposePrefix?.();
    disposeLeader?.();
    // A half-typed sequence compiled against the old token means nothing now.
    keymap.clearPendingSequence();
    resetChordCount();

    disposePrefix = registerLeader(keymap, { name: "prefix", trigger: prefix });
    disposeLeader = registerLeader(keymap, { name: "leader", trigger: leader });

    const global: CommandSpec[] = [];
    // Insertion order, so a same-priority tie between two contexts still
    // resolves the way registration order resolves any other tie.
    const byContext = new Map<ContextSpec, CommandSpec[]>();
    for (const cmd of commands) {
      if (!cmd.context) {
        global.push(cmd);
        continue;
      }
      const group = byContext.get(cmd.context);
      if (group) group.push(cmd);
      else byContext.set(cmd.context, [cmd]);
    }

    // Unchanged from before contexts existed: the global layer carries every
    // context-less binding and is always active.
    const projected: CommandSpec[] = [];
    disposeLayers = [registerLayerChecked(keymap, layerContent(global, keys))];
    disposeContextInterceptors = [];
    for (const [context, group] of byContext) {
      const aliases = context.globalLeaderAliases
        ? global.flatMap((source) => globalLeaderAlias(context, source, keys))
        : [];
      projected.push(...aliases);
      const layerCommands = [...group, ...aliases];
      disposeLayers.push(
        registerLayerChecked(keymap, {
          priority: context.priority,
          // `active` is a plain Solid accessor, not the keymap's own
          // `{get,subscribe}` reactive-matcher shape — passed raw it would
          // only be re-read when something else invalidates the keymap's
          // active-layers cache (a focus change, say), not when the
          // predicate's own value flips. Adapting it is what
          // `@opentui/keymap/solid` exists for.
          enabled: reactiveMatcherFromSignal(context.active),
          ...layerContent(layerCommands, keys),
        }),
      );
      if (context.beforeDispatch) {
        disposeContextInterceptors.push(
          keymap.intercept(
            "key",
            (input) => {
              if (!context.active()) return;
              context.beforeDispatch!({
                event: input.event,
                setData: input.setData,
                consume: input.consume,
                bound: (name) => keymap.getActiveKeys().some((key) => key.display === name),
                notifyPending: () => pendingTable.notify(),
              });
            },
            { priority: context.priority },
          ),
        );
      }
    }

    // A collision is only decidable within one context: two contexts binding
    // the same physical key are mutually exclusive by their own predicates,
    // not a conflict, so each group is checked on its own.
    conflicts = [global, ...byContext.values()].flatMap((group) =>
      findConflicts(keymap, group, { prefix, leader }, keys),
    );
    compiledCommands = [...global, ...Array.from(byContext.values()).flat(), ...projected];
    return conflicts;
  }

  const chords: BindingsChords = {
    timeoutlenMs: () => timeoutlenMs,
    subscribePending(listener) {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    },
  };

  const bindings: Bindings = {
    keymap,
    chords,
    pending: pendingTable,
    constraints,
    dispatch(name) {
      return keymap.dispatchCommand(name).ok;
    },
    activeCommand: () => activeCommand,
    prefix: () => prefix,
    leader: () => leader,
    leaders: () => ({ prefix, leader }),
    conflicts: () => conflicts,
    commands: () => compiledCommands,
    keys: () => currentKeys,
    apply,
    setCommands(next) {
      commands = [...next];
      return apply(currentKeys);
    },
    capture(onKey) {
      capturing = onKey;
      return () => {
        if (capturing === onKey) capturing = null;
      };
    },
    dispose() {
      capturing = null;
      disposePendingSequence();
      disposeCountSource();
      disposeChordSource();
      pendingListeners.clear();
      resetChordCount();
      for (const dispose of disposeLayers) dispose();
      disposeLayers = [];
      for (const dispose of disposeContextInterceptors) dispose();
      disposeContextInterceptors = [];
      disposePrefix?.();
      disposePrefix = null;
      disposeLeader?.();
      disposeLeader = null;
      disposeCountFeed();
      disposeAfterKey();
      disposeCapture();
      disposeUnhandled();
    },
  };

  apply(opts.keys ?? DEFAULT_KEYS);
  return bindings;

  function parseable(key: string, single = false): boolean {
    try {
      const parts = key.length > 0 ? keymap.parseKeySequence(key) : [];
      return single ? parts.length === 1 : parts.length > 0;
    } catch {
      return false;
    }
  }

  function globalLeaderAlias(context: ContextSpec, source: CommandSpec, keys: Keys): CommandSpec[] {
    const aliases = keysFor(source, keys)
      .filter((key) => key.startsWith("<prefix>") && key.length > "<prefix>".length)
      .map((key) => key.slice("<prefix>".length));
    if (!aliases.length) return [];
    return [
      contextCommand(context, {
        name: `alias.${source.name}`,
        key: aliases,
        desc: source.desc,
        group: source.group,
        hidden: source.hidden,
        fixed: true,
        run: source.run.pipe(
          Effect.ensuring(Effect.sync(context.globalLeaderAliases?.afterCommand ?? (() => {}))),
        ),
      }),
    ];
  }
}

/**
 * Sequences answered by more than one command.
 *
 * Only the first-registered of a colliding pair ever fires, and nothing says
 * so: the loser still reads back as bound, still appears in the keybind list,
 * and still shows up in the which-key panel. `^a S` and `^a k` were both dead
 * this way.
 *
 * Checked on the *compiled* sequences from {@link keysFor}.
 *
 * Reported rather than thrown. This used to throw, which was right while the
 * table was static and a collision could only be our own mistake; now that a
 * user can rebind anything onto anything, refusing to start is no way to tell
 * them so. The settings window says it instead.
 */
export function findConflicts(
  keymap: AppKeymap,
  commands: CommandSpec[],
  leaders: string | LeaderDisplay,
  keys: Keys = DEFAULT_KEYS,
): Conflict[] {
  const owners = new Map<string, string[]>();
  for (const cmd of commands) {
    for (const token of keysFor(cmd, keys)) {
      let sequence: string;
      try {
        const parts = keymap.parseKeySequence(token);
        if (parts.length === 0) continue;
        sequence = formatSequence(parts, leaders);
      } catch {
        continue;
      }
      const existing = owners.get(sequence);
      if (existing) existing.push(cmd.name);
      else owners.set(sequence, [cmd.name]);
    }
  }

  return [...owners]
    .filter(([, names]) => names.length > 1)
    .map(([sequence, names]) => ({ sequence, commands: names }));
}

export interface HelpEntry {
  /** Command name, so the keybind editor knows what a row edits. */
  name: string;
  keys: string;
  desc: string;
  /** Whether the sequences come from the config rather than the default. */
  custom: boolean;
  /** Not editable; see CommandSpec.fixed. */
  fixed: boolean;
  /** The binding names a command nothing currently registers — a plugin verb
   *  whose plugin is disabled or missing. The keys stay in config either way;
   *  the command just won't dispatch until something registers it again. */
  orphaned: boolean;
  /** Id of the context this row's command is scoped to, or "" for global.
   *  Read with visibility "registered", so an inactive context's rows still
   *  appear for rebinding — the editor must say which context each row
   *  belongs to, or it lies by omission about why a key does nothing today. */
  context: string;
}

export interface HelpGroup {
  group: string;
  entries: HelpEntry[];
}

export interface PaletteEntry {
  name: string;
  group: string;
  keys: string;
  desc: string;
  /**
   * False while this command's context is inactive. Dimmed in the UI as
   * `(inactive)`. Enter never dispatches an unavailable row — see
   * {@link mayDispatchPaletteEntry}.
   *
   * Inactive PANE-band commands are also {@link PaletteEntry.hidden} so the
   * runnable palette omits editor verbs when a PTY (or other pane) owns focus.
   * APP_MODE / OVERLAY inactive rows stay visible and dimmed (copy-mode
   * discoverability / rebind). Cite: ep-f9d55b / ts-55d4fe.
   */
  available: boolean;
  /**
   * True when the command is gated on a live non-global context (pane editor,
   * overlay, …). Empty-query ranking lifts these above always-on mux globals.
   * Cite: ep-f9d55b; sortKeybindEntries "useful first".
   */
  contextual: boolean;
  /**
   * True for inactive PANE-band commands. {@link filterPaletteEntries} drops
   * these by default; the keybind picker passes `includeHidden` so remaps stay
   * reachable without an editor focused.
   */
  hidden: boolean;
}

/** PANE ≤ priority < APP_MODE: editor / pane contexts. Inactive → hide. */
export function isPaneBandPriority(priority: number): boolean {
  return priority >= CONTEXT_PRIORITY.PANE && priority < CONTEXT_PRIORITY.APP_MODE;
}

/** Enter may run this palette row. Unavailable (dimmed) rows never dispatch. */
export function mayDispatchPaletteEntry(entry: PaletteEntry): boolean {
  return entry.available;
}

/** All registered commands, including commands intentionally hidden from help. */
export function paletteEntries(bindings: Bindings, commands: CommandSpec[]): PaletteEntry[] {
  const keys = bindings.keys();
  return commands.map((cmd) => {
    const sequences = keysFor(cmd, keys).flatMap((token) => {
      try {
        const parts = bindings.keymap.parseKeySequence(token);
        return parts.length > 0 ? [formatSequence(parts, bindings.leaders())] : [];
      } catch {
        return [];
      }
    });
    const context = cmd.context;
    const priority = context?.priority ?? CONTEXT_PRIORITY.GLOBAL;
    const available = context ? context.active() : true;
    // Non-global context + currently active → weigh above mux globals in the palette.
    const contextual = context !== undefined && available && priority > CONTEXT_PRIORITY.GLOBAL;
    // Inactive editor/pane verbs: omit from the runnable palette (still listed
    // for keybind remap via filterPaletteEntries includeHidden).
    const hidden = !available && isPaneBandPriority(priority);
    return {
      name: cmd.name,
      group: cmd.group,
      keys: sequences.join(" / ") || "unbound",
      desc: cmd.desc,
      available,
      contextual,
      hidden,
    };
  });
}

/**
 * Subsequence filter + palette ranker.
 *
 * Sort bands (high → low): available → contextual → query match → registration
 * index. Empty query still ranks (not registration order). Frecency is a later
 * band (ep-f9d55b / ts-a8599b).
 *
 * By default drops {@link PaletteEntry.hidden} rows (inactive PANE-band). Pass
 * `includeHidden: true` for the keybind picker.
 */
export function filterPaletteEntries(
  entries: PaletteEntry[],
  query: string,
  options?: { includeHidden?: boolean },
): PaletteEntry[] {
  const includeHidden = options?.includeHidden === true;
  const visible = includeHidden ? entries : entries.filter((entry) => !entry.hidden);
  const needle = query.trim().toLowerCase();
  const ranked = visible.map((entry, index) => {
    if (!needle) return { entry, score: 0, index };
    const text = `${entry.name} ${entry.desc} ${entry.group}`.toLowerCase();
    let cursor = 0;
    let score = 0;
    for (const char of needle) {
      const found = text.indexOf(char, cursor);
      if (found === -1) return null;
      score += found - cursor;
      cursor = found + 1;
    }
    return { entry, score, index };
  });
  return ranked
    .filter(
      (match): match is { entry: PaletteEntry; score: number; index: number } => match !== null,
    )
    .sort(
      (a, b) =>
        Number(b.entry.available) - Number(a.entry.available) ||
        Number(b.entry.contextual) - Number(a.entry.contextual) ||
        a.score - b.score ||
        a.index - b.index,
    )
    .map((match) => match.entry);
}

/** One reachable command: the single key that gets you there, and what it does. */
export interface HintGroup {
  group: string;
  entries: { keys: string[]; desc: string }[];
}

/**
 * Commands grouped for display, each with the key sequences that run it.
 *
 * Sequences come from {@link keysFor} + the keymap parser (including user
 * rebinds).
 */
export function helpGroups(
  bindings: Bindings,
  commands: CommandSpec[],
  keys: Keys = bindings.keys(),
): HelpGroup[] {
  const groups = new Map<string, HelpEntry[]>();
  const known = new Set(commands.map((cmd) => cmd.name));
  for (const cmd of commands) {
    if (cmd.hidden) continue;
    const sequences = keysFor(cmd, keys).flatMap((token) => {
      try {
        const parts = bindings.keymap.parseKeySequence(token);
        return parts.length > 0 ? [formatSequence(parts, bindings.leaders())] : [];
      } catch {
        return [];
      }
    });
    const entries = groups.get(cmd.group) ?? [];
    entries.push({
      name: cmd.name,
      keys: sequences.join(" / ") || "unbound",
      desc: cmd.desc,
      custom: cmd.name in keys.bindings,
      fixed: cmd.fixed === true,
      orphaned: false,
      context: cmd.context?.id ?? "",
    });
    groups.set(cmd.group, entries);
  }

  // config.keys.bindings preserves a binding whose command no longer exists
  // — a plugin verb from a disabled or missing plugin. Surfaced rather than
  // silently dropped, so re-enabling the plugin finds the binding still there.
  const orphaned = orphanedEntries(bindings, keys, known);
  if (orphaned.length > 0) groups.set("orphaned", orphaned);

  return [...groups].map(([group, entries]) => ({ group, entries }));
}

function orphanedEntries(bindings: Bindings, keys: Keys, known: ReadonlySet<string>): HelpEntry[] {
  const entries: HelpEntry[] = [];
  for (const [name, tokens] of Object.entries(keys.bindings)) {
    if (known.has(name)) continue;
    const sequences = tokens.flatMap((token) => {
      try {
        const parts = bindings.keymap.parseKeySequence(token);
        return parts.length > 0 ? [formatSequence(parts, bindings.leaders())] : [];
      } catch {
        return [];
      }
    });
    entries.push({
      name,
      keys: sequences.join(" / ") || "unbound",
      desc: "unknown command",
      custom: true,
      fixed: false,
      orphaned: true,
      // Nothing registers this command right now, so no context claims it.
      context: "",
    });
  }
  return entries;
}

/**
 * What a half-typed sequence can still turn into — or, with nothing typed
 * yet, every top-level key the currently active contexts answer to.
 *
 * The premise of a which-key panel: after `^a` the app knows exactly which
 * commands remain reachable and which single key reaches each, so it can say so
 * rather than leaving the user to remember. Derived from the keymap graph
 * snapshot (same sequences that dispatch), so a binding cannot appear here and
 * then not fire.
 *
 * Hidden bindings are omitted — siblings covered by one entry, the way
 * `^a 1..9` is a single line rather than nine.
 *
 * Groups are ordered by layer priority — the panel says what will actually
 * fire first.
 */
export function nextKeys(
  bindings: Bindings,
  _commands: readonly CommandSpec[],
  contexts: readonly ContextSpec[],
  pending: readonly { display: string }[],
): HintGroup[] {
  const pendingStrokes = pending.map((part) => part.display);
  const aliasesGlobalLeader = contexts.some(
    (context) => context.active() && context.globalLeaderAliases !== undefined,
  );
  const groups = new Map<string, { keys: string[]; desc: string }[]>();
  const priorityOf = new Map<string, number>();
  const bump = (group: string, priority: number) =>
    priorityOf.set(group, Math.max(priorityOf.get(group) ?? -Infinity, priority));

  let prefixReachable = false;
  let leaderReachable = false;

  const snapshot = createGraphExtra(bindings.keymap).getGraphSnapshot();
  const layerPriority = new Map(snapshot.layers.map((layer) => [layer.id, layer.priority]));
  const byName = new Map(bindings.commands().map((cmd) => [cmd.name, cmd]));

  for (const binding of snapshot.bindings) {
    if (!binding.active || !binding.reachable || binding.shadowed) continue;
    const name = typeof binding.command === "string" ? binding.command : undefined;
    const cmd = name !== undefined ? byName.get(name) : undefined;
    if (cmd === undefined || cmd.hidden || cmd.desc === undefined) continue;
    if (cmd.context !== undefined && !cmd.context.active()) continue;
    const sequence = binding.sequence.map(pendingStrokeDisplay);
    if (sequence.length <= pendingStrokes.length) continue;
    if (pendingStrokes.some((stroke, i) => sequence[i] !== stroke)) continue;
    if (pendingStrokes.length === 0 && sequence[0] === "<prefix>") {
      if (!aliasesGlobalLeader) prefixReachable = true;
      continue;
    }
    if (pendingStrokes.length === 0 && sequence[0] === "<leader>") {
      leaderReachable = true;
      continue;
    }
    const group = cmd.group;
    const next = sequence[pendingStrokes.length];
    if (next === undefined) continue;
    const key = formatKey(next, bindings.leaders());
    const entries = groups.get(group) ?? [];
    const existing = entries.find((entry) => entry.desc === cmd.desc);
    if (existing) {
      if (!existing.keys.includes(key)) existing.keys.push(key);
    } else {
      entries.push({ keys: [key], desc: cmd.desc });
    }
    groups.set(group, entries);
    bump(group, layerPriority.get(binding.layerId) ?? CONTEXT_PRIORITY.GLOBAL);
  }

  // A context whose keys are a `handle` catch-all (key-context.ts) has no
  // keymap binding to read a binding back from — copy mode's v/y/n.
  if (pendingStrokes.length === 0) {
    for (const context of contexts) {
      if (!context.hints?.length || !context.active()) continue;
      groups.set(context.id, [...context.hints]);
      bump(context.id, context.priority);
    }
  }

  const result = [...groups]
    .map(([group, entries]) => ({ group, entries }))
    .sort(
      (a, b) => (priorityOf.get(b.group) ?? -Infinity) - (priorityOf.get(a.group) ?? -Infinity),
    );

  if (prefixReachable) {
    result.push({
      group: "",
      entries: [{ keys: [formatKey("<prefix>", bindings.leaders())], desc: "mux prefix" }],
    });
  }
  if (leaderReachable) {
    result.push({
      group: "",
      entries: [{ keys: [formatKey("<leader>", bindings.leaders())], desc: "editor leader" }],
    });
  }
  return result;
}
