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
 * Turn a compiled sequence into something worth showing a human.
 *
 * The leader stays a keymap *token* rather than being expanded into a raw
 * `ctrl+a x` sequence — the token is what makes the prefix rebindable in one
 * place, and expanding it by hand breaks dispatch. So the substitution happens
 * at display time instead: `<leader> x` reads as `^a x`.
 */
export function formatSequence(parts: readonly { display: string }[]): string {
  return parts
    .map((p) => (p.display === "<leader>" ? LEADER_DISPLAY : p.display.replace(/^ctrl\+/, "^")))
    .join(" ")
}

export interface CommandSpec {
  /** Dotted name, e.g. "pane.split-row". The namespace doubles as the help group. */
  name: string
  /** Key sequence, e.g. "<leader>|". Omit for commands with no default binding. */
  key?: string | string[]
  desc: string
  group: string
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
 * Commands grouped for display, each with the key sequences that run it.
 *
 * Read back out of the keymap rather than off the CommandSpec list, so what the
 * help shows is what the keymap will actually dispatch — including any later
 * rebinding.
 */
export function helpGroups(
  keymap: AppKeymap,
  commands: CommandSpec[],
): { group: string; entries: { keys: string; desc: string }[] }[] {
  const bindings = keymap.getCommandBindings({
    visibility: "registered",
    commands: commands.map((c) => c.name),
  })

  const groups = new Map<string, { keys: string; desc: string }[]>()
  for (const cmd of commands) {
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
