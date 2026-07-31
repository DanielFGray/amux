import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import {
  registerDefaultKeys,
  registerLeader,
  registerMetadataFields,
  registerEscapeClearsPendingSequence,
} from "@opentui/keymap/addons"
import type { Keymap } from "@opentui/keymap"

export type AppKeymap = Keymap<Renderable, KeyEvent>

/** The tmux-style prefix. Bindings write it as `<leader>` for readability. */
export const LEADER = "ctrl+a"

/** How the leader reads on screen. */
const LEADER_DISPLAY = "^a"

/**
 * How one compiled key reads on screen.
 *
 * The leader stays a keymap *token* rather than being expanded into a raw
 * `ctrl+a` press — the token is what makes the prefix rebindable in one place,
 * and expanding it by hand breaks dispatch. So the substitution happens at
 * display time instead: `<leader> x` reads as `^a x`.
 */
export function formatKey(display: string): string {
  if (display === "<leader>") return LEADER_DISPLAY
  // `shift+s` is how a capital has to be *written* — a bare "S" compiles to the
  // same sequence as "s" — but "S" is how it is pressed and read.
  const shifted = display.match(/^shift\+([a-z])$/)
  if (shifted) return shifted[1]!.toUpperCase()
  return display.replace(/^ctrl\+/, "^")
}

/** Turn a compiled sequence into something worth showing a human. */
export function formatSequence(parts: readonly { display: string }[]): string {
  return parts.map((p) => formatKey(p.display)).join(" ")
}

export interface CommandSpec {
  /** Dotted name, e.g. "pane.split-row". The namespace doubles as the help group. */
  name: string
  /** Key sequence, e.g. "<leader>|". Omit for commands with no default binding. */
  key?: string | string[]
  desc: string
  group: string
  /**
   * Covered by a sibling entry, so help and hints list it once rather than
   * nine times — `^a 1..9` being the case in point.
   *
   * A flag rather than an empty desc, which is what this used to be: the keymap
   * rejects empty metadata outright, and a rejected command still *compiles its
   * binding*, so `^a 2` looked bound in every readback and silently did nothing
   * when pressed. Every command gets a real description.
   */
  hidden?: boolean
  run: () => void
}

/**
 * Build the app keymap from a flat command list.
 *
 * Everything downstream reads from this one registration: dispatch, the header
 * hint line, and the help window. herdr generates its keybind help from its
 * keybind config for the same reason — a help screen maintained separately
 * from the bindings is a help screen that lies.
 */
export function createBindings(
  renderer: CliRenderer,
  commands: CommandSpec[],
  opts: {
    /** Return true if the app consumed the key. Returning false leaves it for
     *  whichever renderable holds focus — that is how a focused text input
     *  receives characters. */
    onUnhandled: (event: KeyEvent, reason: string) => boolean
  },
): AppKeymap {
  const keymap = createOpenTuiKeymap(renderer)
  registerDefaultKeys(keymap)
  // `desc` and `group` become queryable attrs, which is what the help window
  // groups and labels itself from.
  registerMetadataFields(keymap)
  registerLeader(keymap, { trigger: LEADER })
  // Escape backs out of a half-typed sequence instead of stranding the prefix.
  registerEscapeClearsPendingSequence(keymap)

  const bindings = commands.flatMap((cmd) =>
    !cmd.key
      ? []
      : (Array.isArray(cmd.key) ? cmd.key : [cmd.key]).map((key) => ({ key, cmd: cmd.name })),
  )

  keymap.registerLayer({
    bindings,
    commands: commands.map((cmd) => ({
      name: cmd.name,
      desc: cmd.desc,
      group: cmd.group,
      run: () => {
        cmd.run()
      },
    })),
  })

  assertNoCollisions(keymap, commands)

  // A multiplexer is a pass-through: anything not claimed by a binding belongs
  // to the child. This fires after dispatch, so bound keys and keys that are
  // mid-sequence are already accounted for and never reach a shell.
  keymap.intercept("key:after", (ctx) => {
    if (ctx.handled) return
    // preventDefault only when the app really took the key. A focused
    // Renderable skips any event whose default was prevented, so blanket
    // prevention here would stop a text input ever receiving a character.
    if (!opts.onUnhandled(ctx.event, ctx.reason)) return
    ctx.consume({ preventDefault: true })
    ctx.event.preventDefault()
  })

  return keymap
}

/**
 * Refuse two commands that answer to the same keys.
 *
 * Only the first-registered of a colliding pair ever fires, and nothing says
 * so: the loser still reads back as bound, still appears in help, and still
 * shows up in the which-key panel. `^a S` and `^a k` were both dead this way.
 *
 * Checked on the *compiled* sequences, not the key strings that produced them,
 * because that is exactly where the surprises live — "S" and "s" are different
 * strings that compile to the same press.
 *
 * Throwing is right while bindings are static: this can only fire on a mistake
 * in the command table, so it fires the first time anyone runs the app. Once
 * keys come from user config it has to become a reported error instead.
 */
function assertNoCollisions(keymap: AppKeymap, commands: CommandSpec[]): void {
  const bindings = keymap.getCommandBindings({
    visibility: "registered",
    commands: commands.map((c) => c.name),
  })

  const owners = new Map<string, string[]>()
  for (const [name, list] of bindings) {
    for (const binding of list) {
      const sequence = formatSequence(binding.sequence)
      const existing = owners.get(sequence)
      if (existing) existing.push(name)
      else owners.set(sequence, [name])
    }
  }

  const clashes = [...owners].filter(([, names]) => names.length > 1)
  if (!clashes.length) return
  throw new Error(
    `Key sequences bound to more than one command:\n` +
      clashes.map(([sequence, names]) => `  ${sequence} -> ${names.join(", ")}`).join("\n"),
  )
}

export interface HelpGroup {
  group: string
  entries: { keys: string; desc: string }[]
}

/** One reachable command: the single key that gets you there, and what it does. */
export interface HintGroup {
  group: string
  entries: { keys: string[]; desc: string }[]
}

/**
 * Commands grouped for display, each with the key sequences that run it.
 *
 * Read back out of the keymap rather than off the CommandSpec list, so what the
 * help shows is what the keymap will actually dispatch — including any later
 * rebinding.
 */
export function helpGroups(keymap: AppKeymap, commands: CommandSpec[]): HelpGroup[] {
  const bindings = keymap.getCommandBindings({
    visibility: "registered",
    commands: commands.map((c) => c.name),
  })

  const groups = new Map<string, { keys: string; desc: string }[]>()
  for (const cmd of commands) {
    if (cmd.hidden) continue
    const active = bindings.get(cmd.name) ?? []
    // Render the compiled sequence, not the source string, so a binding
    // displays as the keys the user actually presses.
    const keys = active.map((b) => formatSequence(b.sequence)).join(" / ")
    const entries = groups.get(cmd.group) ?? []
    entries.push({ keys: keys || "unbound", desc: cmd.desc })
    groups.set(cmd.group, entries)
  }
  return [...groups].map(([group, entries]) => ({ group, entries }))
}

/**
 * What a half-typed sequence can still turn into.
 *
 * The premise of a which-key panel: after `^a` the app knows exactly which
 * commands remain reachable and which single key reaches each, so it can say so
 * rather than leaving the user to remember. Derived from the same registration
 * as dispatch and help, so a binding cannot appear here and then not fire.
 *
 * Hidden commands are omitted — they are the siblings covered by one entry,
 * the way `^a 1..9` is a single line rather than nine.
 */
export function nextKeys(
  keymap: AppKeymap,
  commands: CommandSpec[],
  pending: readonly { display: string }[],
): HintGroup[] {
  if (pending.length === 0) return []
  const bindings = keymap.getCommandBindings({
    visibility: "registered",
    commands: commands.map((c) => c.name),
  })

  const groups = new Map<string, { keys: string[]; desc: string }[]>()
  for (const cmd of commands) {
    if (cmd.hidden) continue
    const keys: string[] = []
    for (const binding of bindings.get(cmd.name) ?? []) {
      const sequence = binding.sequence
      // Longer than what has been typed, and typed so far in full.
      if (sequence.length <= pending.length) continue
      if (pending.some((part, i) => sequence[i]!.display !== part.display)) continue
      const key = formatKey(sequence[pending.length]!.display)
      if (!keys.includes(key)) keys.push(key)
    }
    if (!keys.length) continue
    const entries = groups.get(cmd.group) ?? []
    entries.push({ keys, desc: cmd.desc })
    groups.set(cmd.group, entries)
  }
  return [...groups].map(([group, entries]) => ({ group, entries }))
}
