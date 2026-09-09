import { Effect, Schema as S } from "effect";
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import { createOpenTuiKeymap } from "@opentui/keymap/opentui";
import {
  registerDefaultKeys,
  registerEnabledFields,
  registerLeader,
  registerMetadataFields,
  registerEscapeClearsPendingSequence,
} from "@opentui/keymap/addons";
import type { CommandContext, Keymap } from "@opentui/keymap";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { KeyStroke } from "./keys.ts";
import { runDetached, type CommandError } from "./commands.ts";
import type { ContextSpec } from "./key-context.ts";
import { KeyInvocation } from "./key-invocation.ts";
import { JsonValueSchema } from "./effect/AttachProtocol.ts";

export type AppKeymap = Keymap<Renderable, KeyEvent>;

/** The tmux-style prefix. Bindings write it as `<leader>` for readability. */
export const DEFAULT_LEADER = "ctrl+a";

/** What the user has changed: the prefix, and per-command sequences. */
export interface Keys {
  leader: string;
  /** Command name -> sequences. Absent means the command's own default; an
   *  empty array means deliberately unbound. */
  bindings: Record<string, string[]>;
}

export const DEFAULT_KEYS: Keys = { leader: DEFAULT_LEADER, bindings: {} };

/**
 * How one compiled key reads on screen.
 *
 * The leader stays a keymap *token* rather than being expanded into a raw
 * `ctrl+a` press — the token is what makes the prefix rebindable in one place,
 * and expanding it by hand breaks dispatch. So the substitution happens at
 * display time instead: `<leader> x` reads as `^a x`.
 */
export function formatKey(display: string, leader = DEFAULT_LEADER): string {
  if (display === "<leader>") {
    // A malformed hand-edited config must not recurse forever while rendering
    // the settings screen.
    if (leader === "<leader>") return "<leader>";
    return formatKey(leader, leader);
  }
  // `shift+s` is how a capital has to be *written* — a bare "S" compiles to the
  // same sequence as "s" — but "S" is how it is pressed and read.
  const shifted = display.match(/^shift\+([a-z])$/);
  if (shifted) return shifted[1]!.toUpperCase();
  return display.replace(/^ctrl\+/, "^").replace(/^alt\+/, "M-");
}

/** Turn a compiled sequence into something worth showing a human. */
export function formatSequence(
  parts: readonly { display: string }[],
  leader = DEFAULT_LEADER,
): string {
  return parts.map((p) => formatKey(p.display, leader)).join(" ");
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
  /** Execute a registered command through the keymap's command dispatcher. */
  dispatch: (name: string) => boolean;
  /** Command whose binding is synchronously producing another key, if any. */
  activeCommand: () => string | null;
  /** The prefix in effect. Display code needs it to render `<leader>`. */
  leader(): string;
  /** Sequences claimed by more than one command as of the last apply. */
  conflicts(): Conflict[];
  /** Commands currently compiled into layers, including context projections. */
  commands(): readonly CommandSpec[];
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

  let leader = opts.keys?.leader ?? DEFAULT_LEADER;
  let commands = [...initialCommands];
  let currentKeys = opts.keys ?? { leader: DEFAULT_LEADER, bindings: {} };
  let conflicts: Conflict[] = [];
  let compiledCommands: readonly CommandSpec[] = [];
  let disposeLayers: (() => void)[] = [];
  let disposeContextInterceptors: (() => void)[] = [];
  let disposeLeader: (() => void) | null = null;
  let capturing: ((event: KeyEvent, binding: string) => void) | null = null;
  let activeCommand: string | null = null;

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
    const requestedLeader = keys.leader || DEFAULT_LEADER;
    leader = parseable(requestedLeader, true) ? requestedLeader : DEFAULT_LEADER;
    for (const dispose of disposeLayers) dispose();
    for (const dispose of disposeContextInterceptors) dispose();
    disposeLeader?.();
    // A half-typed sequence compiled against the old token means nothing now.
    keymap.clearPendingSequence();

    disposeLeader = registerLeader(keymap, { trigger: leader });

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
          ...layerContent([...group, ...aliases], keys),
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

    // A collision is only decidable within one context: two contexts binding
    // the same physical key are mutually exclusive by their own predicates,
    // not a conflict, so each group is checked on its own.
    conflicts = [global, ...byContext.values()].flatMap((group) =>
      findConflicts(keymap, group, leader),
    );
    compiledCommands = [...global, ...Array.from(byContext.values()).flat(), ...projected];
    return conflicts;
  }

  const bindings: Bindings = {
    keymap,
    dispatch(name) {
      return keymap.dispatchCommand(name).ok;
    },
    activeCommand: () => activeCommand,
    leader: () => leader,
    conflicts: () => conflicts,
    commands: () => compiledCommands,
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
      for (const dispose of disposeLayers) dispose();
      disposeLayers = [];
      for (const dispose of disposeContextInterceptors) dispose();
      disposeContextInterceptors = [];
      disposeLeader?.();
      disposeLeader = null;
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
      .filter((key) => key.startsWith("<leader>") && key.length > "<leader>".length)
      .map((key) => key.slice("<leader>".length));
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
 * Checked on the *compiled* sequences, not the key strings that produced them,
 * because that is exactly where the surprises live — "S" and "s" are different
 * strings that compile to the same press.
 *
 * Reported rather than thrown. This used to throw, which was right while the
 * table was static and a collision could only be our own mistake; now that a
 * user can rebind anything onto anything, refusing to start is no way to tell
 * them so. The settings window says it instead.
 */
export function findConflicts(
  keymap: AppKeymap,
  commands: CommandSpec[],
  leader: string,
): Conflict[] {
  const bindings = keymap.getCommandBindings({
    visibility: "registered",
    commands: commands.map((c) => c.name),
  });

  const owners = new Map<string, string[]>();
  for (const [name, list] of bindings) {
    for (const binding of list) {
      const sequence = formatSequence(binding.sequence, leader);
      const existing = owners.get(sequence);
      if (existing) existing.push(name);
      else owners.set(sequence, [name]);
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
  /** False while this command's context is inactive. The palette runs
   *  commands directly rather than through the keymap, so an inactive
   *  command still needs to be visible — this only says its keys won't fire
   *  right now, without hiding the only way left to reach it. */
  available: boolean;
}

/** All registered commands, including commands intentionally hidden from help. */
export function paletteEntries(bindings: Bindings, commands: CommandSpec[]): PaletteEntry[] {
  const active = bindings.keymap.getCommandBindings({
    visibility: "registered",
    commands: commands.map((c) => c.name),
  });
  return commands.map((cmd) => ({
    name: cmd.name,
    group: cmd.group,
    keys:
      (active.get(cmd.name) ?? [])
        .map((binding) => formatSequence(binding.sequence, bindings.leader()))
        .join(" / ") || "unbound",
    desc: cmd.desc,
    available: cmd.context ? cmd.context.active() : true,
  }));
}

/** Case-insensitive subsequence matching with stable relevance ordering. */
export function filterPaletteEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries
    .map((entry, index) => {
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
    })
    .filter(
      (match): match is { entry: PaletteEntry; score: number; index: number } => match !== null,
    )
    .sort((a, b) => a.score - b.score || a.index - b.index)
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
 * Read back out of the keymap rather than off the CommandSpec list, so what the
 * list shows is what the keymap will actually dispatch — including any
 * rebinding.
 */
export function helpGroups(
  bindings: Bindings,
  commands: CommandSpec[],
  keys: Keys = DEFAULT_KEYS,
): HelpGroup[] {
  const active = bindings.keymap.getCommandBindings({
    visibility: "registered",
    commands: commands.map((c) => c.name),
  });

  const groups = new Map<string, HelpEntry[]>();
  const known = new Set(commands.map((cmd) => cmd.name));
  for (const cmd of commands) {
    if (cmd.hidden) continue;
    // Render the compiled sequence, not the source string, so a binding
    // displays as the keys the user actually presses.
    const sequences = (active.get(cmd.name) ?? []).map((b) =>
      formatSequence(b.sequence, bindings.leader()),
    );
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
        return parts.length > 0 ? [formatSequence(parts, bindings.leader())] : [];
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
 * rather than leaving the user to remember. Derived from the same registration
 * as dispatch and the keybind list, so a binding cannot appear here and then
 * not fire.
 *
 * Read with `visibility: "active"`, not "registered": "registered" walks raw
 * layers and evaluates no conditions, so a binding scoped to an inactive
 * context would read back as reachable here and do nothing when pressed. A
 * hint that shows must be able to fire.
 *
 * Hidden commands are omitted — they are the siblings covered by one entry,
 * the way `^a 1..9` is a single line rather than nine.
 *
 * Groups are ordered by the highest `priority` among the contexts that feed
 * them (a context-less command sits beneath every real context, the same as
 * its layer does at dispatch time) — the panel says what will actually fire
 * first, making shadowing visible instead of mysterious rather than leaving
 * it to alphabetical or registration order.
 */
export function nextKeys(
  bindings: Bindings,
  commands: readonly CommandSpec[],
  contexts: readonly ContextSpec[],
  pending: readonly { display: string }[],
): HintGroup[] {
  const active = bindings.keymap.getCommandBindings({
    visibility: "active",
    commands: commands.map((c) => c.name),
  });

  const groups = new Map<string, { keys: string[]; desc: string }[]>();
  const aliasesGlobalLeader = contexts.some(
    (context) => context.active() && context.globalLeaderAliases !== undefined,
  );
  const priorityOf = new Map<string, number>();
  const bump = (group: string, priority: number) =>
    priorityOf.set(group, Math.max(priorityOf.get(group) ?? -Infinity, priority));

  // Every leader-bound command's compiled sequence starts with the same
  // literal "<leader>" token (the leader is a keymap token, not a command —
  // registerLeader, above). Before it is pressed, showing each of those
  // commands individually would repeat the same one key once per command;
  // one synthetic entry says the leader still reaches them, the way
  // Settings.tsx's own "prefix" row reads the same token.
  let leaderReachable = false;
  for (const cmd of commands) {
    if (cmd.hidden) continue;
    const keys: string[] = [];
    for (const binding of active.get(cmd.name) ?? []) {
      const sequence = binding.sequence;
      // Longer than what has been typed, and typed so far in full.
      if (sequence.length <= pending.length) continue;
      if (pending.some((part, i) => sequence[i]!.display !== part.display)) continue;
      if (pending.length === 0 && sequence[0]!.display === "<leader>") {
        if (!aliasesGlobalLeader) leaderReachable = true;
        continue;
      }
      const key = formatKey(sequence[pending.length]!.display, bindings.leader());
      if (!keys.includes(key)) keys.push(key);
    }
    if (!keys.length) continue;
    const entries = groups.get(cmd.group) ?? [];
    entries.push({ keys, desc: cmd.desc });
    groups.set(cmd.group, entries);
    bump(cmd.group, cmd.context?.priority ?? -Infinity);
  }

  // A context whose keys are a `handle` catch-all (key-context.ts) has no
  // CommandSpec to read a binding back from — copy mode's v/y/n, decided by
  // its own live state rather than a static map. `ContextSpec.hints` fills
  // that gap for display the way `handle` fills it for dispatch, but only at
  // the top of the tree: these are always single, unprefixed keys, so once a
  // sequence is under way a typed prefix has already said more than this
  // list can.
  if (pending.length === 0) {
    for (const context of contexts) {
      if (!context.hints?.length || !context.active()) continue;
      groups.set(context.id, [...context.hints]);
      bump(context.id, context.priority);
    }
  }

  const result = [...groups]
    .map(([group, entries]) => ({ group, entries }))
    .sort((a, b) => (priorityOf.get(b.group) ?? -Infinity) - (priorityOf.get(a.group) ?? -Infinity));

  if (leaderReachable) {
    result.push({
      group: "",
      entries: [{ keys: [formatKey("<leader>", bindings.leader())], desc: "more commands" }],
    });
  }
  return result;
}
