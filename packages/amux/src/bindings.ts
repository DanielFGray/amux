import { Context, Duration, Effect, Schema as S } from "effect";
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
import type { CommandContext, Keymap } from "@opentui/keymap";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { KeyStroke } from "./keys.ts";
import { runDetached, type CommandError } from "./commands.ts";
import { CONTEXT_PRIORITY, type ContextSpec } from "./key-context.ts";
import { createCountAccumulator, KeyInvocation } from "./key-invocation.ts";
import { JsonValueSchema, type JsonValue } from "./effect/AttachProtocol.ts";
import {
  createChordMatcher,
  DEFAULT_CHORD_TIMEOUTLEN_MS,
  type ChordBinding,
  type ChordMatcher,
  type ChordMode,
  type ChordStroke,
} from "./chord-matcher.ts";
import type { RootRuntimeContext } from "./env.ts";

export type { ChordBinding, ChordStroke, ChordMode };

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
 * (input.c / handle_mapping). Owned by {@link createChordMatcher}; OpenTUI
 * `registerNeovimDisambiguation` keeps the same value for any leftover
 * single-layer ambiguity. Multi-key wait (mux `<prefix>*`, editor
 * `<leader>*` / `g*`) is ChordMatcher only.
 */
export const DEFAULT_TIMEOUTLEN_MS = DEFAULT_CHORD_TIMEOUTLEN_MS;

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
   * context captured ahead of it (a count, a register, a text object). Most
   * commands need none of that and stay `Effect<any, CommandError>`: `never`
   * satisfies any declared requirement, so nothing else changes for them.
   */
  run: Effect.Effect<any, CommandError, KeyInvocation>;
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
export interface Bindings {
  keymap: AppKeymap;
  /**
   * Shared mapping-chord matcher (pending / timeoutlen / showcmd / which-key).
   * Multi-key CommandSpecs sync here on {@link Bindings.apply}; plugins may
   * also {@link ChordMatcher.register} directly (editor `g*` / LSP).
   */
  chords: ChordMatcher;
  /**
   * Digits accumulated while a chord is pending (`^S ^W 80`). Empty when idle.
   * showcmd appends these; which-key still keys off {@link ChordMatcher.pending}
   * alone — counts are not trie strokes. Cite: key-invocation.ts; neovim count.
   */
  countDigits(): string;
  /** Fires when {@link Bindings.countDigits} changes (pending chord counts). */
  subscribeCount(listener: () => void): () => void;
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
  // Neovim-style timeoutlen: when `g` is both an exact binding and a prefix of
  // `grr`, wait for a continuation; on timeout run the exact binding. Without
  // this, longer chords need hand-rolled prefix ContextSpecs (pendingGr & co).
  // Cite: neovim/src/nvim/input.c handle_mapping + KEYLEN_PART_MAP;
  // @opentui/keymap/addons registerNeovimDisambiguation.
  registerNeovimDisambiguation(keymap, {
    timeoutMs: opts.timeoutlenMs ?? DEFAULT_TIMEOUTLEN_MS,
  });

  const chords = createChordMatcher({
    timeoutlen: Duration.millis(opts.timeoutlenMs ?? DEFAULT_TIMEOUTLEN_MS),
  });

  let prefix = opts.keys?.prefix ?? DEFAULT_PREFIX;
  let leader = opts.keys?.leader ?? DEFAULT_LEADER;
  let commands = [...initialCommands];
  let currentKeys = opts.keys ?? DEFAULT_KEYS;
  let conflicts: Conflict[] = [];
  let compiledCommands: readonly CommandSpec[] = [];
  let disposeLayers: (() => void)[] = [];
  let disposeContextInterceptors: (() => void)[] = [];
  let disposeAutoChords: (() => void)[] = [];
  let disposePrefix: (() => void) | null = null;
  let disposeLeader: (() => void) | null = null;
  let capturing: ((event: KeyEvent, binding: string) => void) | null = null;
  let activeCommand: string | null = null;
  /** Keystroke that armed the chord match — for KeyInvocation on chord dispatch. */
  let chordEvent: KeyEvent | null = null;
  let chordData: Readonly<Record<string, JsonValue>> = {};
  /** Mux/editor map counts while ChordMatcher pending — not OpenTUI getData. */
  const chordCount = createCountAccumulator();
  const countListeners = new Set<() => void>();
  const notifyCount = () => {
    for (const listener of countListeners) listener();
  };
  const resetChordCount = () => {
    if (chordCount.digits() === "") return;
    chordCount.reset();
    notifyCount();
  };
  // timeoutlen / clear abandons pending without going through the feed — drop
  // a stranded count so showcmd cannot show `^S 80` with no chord left.
  chords.subscribe((strokes) => {
    if (strokes.length === 0) resetChordCount();
  });

  /** Compile a binding token to ChordMatcher strokes (`<prefix>`, `z`, …). */
  const strokesOf = (token: string): ChordStroke[] | null => {
    try {
      const parts = keymap.parseKeySequence(token);
      if (parts.length === 0) return null;
      return parts.map((part) => part.display);
    } catch {
      return null;
    }
  };

  const jsonData = (value: unknown): JsonValue | undefined => {
    const decoded = S.decodeUnknownOption(JsonValueSchema)(value);
    return decoded._tag === "Some" ? decoded.value : undefined;
  };

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
   * Single multi-key feed: physical prefix/leader → tokens, then ChordMatcher.
   * Digits while pending are a count (vim `{count}` after a map prefix), not
   * trie strokes — so `^S ^W 80|` binds as `<prefix>ctrl+w|` + count 80.
   * Misses fall through to OpenTUI single-key bindings / the PTY.
   */
  const disposeChordFeed = keymap.intercept(
    "key",
    (input) => {
      if (input.event.defaultPrevented) return;
      const stroke = keyToBinding(input.event);
      if (stroke === null) return;
      // OpenTUI / mockInput may spell the name "escape" or "Escape".
      if (stroke.toLowerCase() === "escape") {
        if (chords.pending().length === 0 && chordCount.digits() === "") return;
        chords.clear();
        resetChordCount();
        input.consume({ preventDefault: true });
        input.event.preventDefault();
        return;
      }

      const pending = chords.pending();
      if (pending.length > 0) {
        const boundAtPending = (name: string) =>
          chords.activeBindings().some((binding) => {
            if (binding.strokes.length !== pending.length + 1) return false;
            if (pending.some((part, i) => binding.strokes[i] !== part)) return false;
            return binding.strokes[pending.length] === name;
          });
        if (chordCount.offer(input.event, boundAtPending)) {
          chords.rearmTimeout();
          notifyCount();
          input.consume({ preventDefault: true });
          input.event.preventDefault();
          return;
        }
      }

      const chordStroke =
        stroke === prefix ? "<prefix>" : stroke === leader ? "<leader>" : stroke;
      chordEvent = input.event;
      const editorCount = jsonData(input.getData("count"));
      chordData =
        chordCount.digits() !== ""
          ? { count: chordCount.count() }
          : editorCount === undefined
            ? {}
            : { count: editorCount };
      const result = chords.push(chordStroke);
      if (result._tag === "matched") {
        resetChordCount();
        input.consume({ preventDefault: true });
        input.event.preventDefault();
        return;
      }
      if (result._tag === "pending") {
        input.consume({ preventDefault: true });
        input.event.preventDefault();
        return;
      }
      // Miss: matcher cleared any abandoned pending; drop a stranded count.
      if (pending.length > 0) resetChordCount();
    },
    // Below PANE beforeDispatch (editor counts); above GLOBAL unhandled.
    { priority: CONTEXT_PRIORITY.PANE - 1 },
  );

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

  function layerContent(group: readonly CommandSpec[], keys: Keys) {
    return {
      // Multi-key sequences live on ChordMatcher (synced in apply). OpenTUI
      // keeps single-key rows only — modal prefix-stripped aliases included.
      bindings: group.flatMap((cmd) =>
        keysFor(cmd, keys)
          .filter((key) => parseable(key))
          .flatMap((key) => {
            const strokes = strokesOf(key);
            if (strokes === null || strokes.length !== 1) return [];
            return [{ key, cmd: cmd.name }];
          }),
      ),
      commands: group.map((cmd) => ({
        name: cmd.name,
        desc: cmd.desc,
        group: cmd.group,
        run: (ctx: CommandContext<Renderable, KeyEvent>) => {
          const previous = activeCommand;
          activeCommand = cmd.name;
          try {
            const captured = S.decodeUnknownOption(S.Record(S.String, JsonValueSchema))(ctx.data);
            runDetached(
              cmd.name,
              cmd.run.pipe(
                Effect.provideService(KeyInvocation, {
                  event: ctx.event,
                  data: captured._tag === "Some" ? captured.value : {},
                  input: ctx.input,
                  payload: ctx.payload,
                }),
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

  /** Mirror CommandSpec keys onto chords so wait/showcmd/which-key share one trie. */
  function syncCommandChords(groups: readonly (readonly CommandSpec[])[], keys: Keys) {
    for (const dispose of disposeAutoChords) dispose();
    disposeAutoChords = [];
    for (const group of groups) {
      for (const cmd of group) {
        for (const key of keysFor(cmd, keys)) {
          const strokes = strokesOf(key);
          if (strokes === null || strokes.length === 0) continue;
          const name = cmd.name;
          const command = cmd;
          disposeAutoChords.push(
            chords.register({
              id: `cmd:${name}:${key}`,
              strokes,
              active: command.context?.active,
              desc: command.desc,
              group: command.group,
              hidden: command.hidden,
              priority: command.context?.priority ?? CONTEXT_PRIORITY.GLOBAL,
              run: () => {
                const event = chordEvent;
                if (event === null) {
                  keymap.dispatchCommand(name);
                  return;
                }
                const previous = activeCommand;
                activeCommand = name;
                try {
                  runDetached(
                    name,
                    command.run.pipe(
                      Effect.provideService(KeyInvocation, {
                        event,
                        data: chordData,
                        input: "",
                        payload: undefined,
                      }),
                    ),
                    opts.onError,
                    opts.runtime,
                  );
                } finally {
                  activeCommand = previous;
                }
              },
            }),
          );
        }
      }
    }
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
    chords.clear();
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
    const contextGroups: CommandSpec[][] = [];
    for (const [context, group] of byContext) {
      const aliases = context.globalLeaderAliases
        ? global.flatMap((source) => globalLeaderAlias(context, source, keys))
        : [];
      projected.push(...aliases);
      const layerCommands = [...group, ...aliases];
      contextGroups.push(layerCommands);
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
              if (context.active()) context.beforeDispatch!(input);
            },
            { priority: context.priority },
          ),
        );
      }
    }

    syncCommandChords([global, ...contextGroups], keys);

    // A collision is only decidable within one context: two contexts binding
    // the same physical key are mutually exclusive by their own predicates,
    // not a conflict, so each group is checked on its own.
    conflicts = [global, ...byContext.values()].flatMap((group) =>
      findConflicts(keymap, group, { prefix, leader }, keys),
    );
    compiledCommands = [...global, ...Array.from(byContext.values()).flat(), ...projected];
    return conflicts;
  }

  const bindings: Bindings = {
    keymap,
    chords,
    countDigits: () => chordCount.digits(),
    subscribeCount(listener) {
      countListeners.add(listener);
      return () => {
        countListeners.delete(listener);
      };
    },
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
      for (const dispose of disposeAutoChords) dispose();
      disposeAutoChords = [];
      chords.dispose();
      resetChordCount();
      countListeners.clear();
      for (const dispose of disposeLayers) dispose();
      disposeLayers = [];
      for (const dispose of disposeContextInterceptors) dispose();
      disposeContextInterceptors = [];
      disposePrefix?.();
      disposePrefix = null;
      disposeLeader?.();
      disposeLeader = null;
      disposeChordFeed();
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
 * Checked on the *compiled* sequences from {@link keysFor}, not OpenTUI's
 * binding table — multi-key maps live on ChordMatcher and never appear as
 * OpenTUI sequences.
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
 * rebinds), not OpenTUI's binding table — multi-key maps are ChordMatcher-only.
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
 * rather than leaving the user to remember. Derived from {@link Bindings.chords}
 * (the same trie that owns multi-key wait and showcmd), so a binding cannot
 * appear here and then not fire.
 *
 * Hidden bindings are omitted — siblings covered by one entry, the way
 * `^a 1..9` is a single line rather than nine.
 *
 * Groups are ordered by chord `priority` (context priority for CommandSpec
 * sync rows) — the panel says what will actually fire first.
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

  for (const binding of bindings.chords.activeBindings()) {
    if (binding.hidden || binding.desc === undefined) continue;
    const sequence = binding.strokes;
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
    const group = binding.group ?? "chords";
    const key = formatKey(sequence[pendingStrokes.length]!, bindings.leaders());
    const entries = groups.get(group) ?? [];
    const existing = entries.find((entry) => entry.desc === binding.desc);
    if (existing) {
      if (!existing.keys.includes(key)) existing.keys.push(key);
    } else {
      entries.push({ keys: [key], desc: binding.desc });
    }
    groups.set(group, entries);
    bump(group, binding.priority ?? CONTEXT_PRIORITY.GLOBAL);
  }

  // A context whose keys are a `handle` catch-all (key-context.ts) has no
  // ChordBinding to read a binding back from — copy mode's v/y/n.
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
