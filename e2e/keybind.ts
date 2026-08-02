/**
 * A rebound key actually fires, and the settings window can rebind it.
 *
 * Two things that only pressing a key can establish. The keymap will happily
 * register a binding that never dispatches (lrn-42d64b), so "the config says
 * ^a g is bound" and "^a g splits the pane" are separate claims and this checks
 * the second. And ts-8b3867's Definition of Done asks for capture, reset and
 * save to still work once a command's `run` became an Effect — the settings
 * window rebuilds the whole keymap layer on every change, which is the path
 * that would break if running a command had.
 *
 *   bun run e2e:keybind
 */
import { launch, report, LEADER } from "./app.ts"

// ^a g is bound to nothing by default, so a split appearing under it can only
// have come from the config.
const REBOUND = { keys: { leader: "ctrl+a", bindings: { "pane.split-row": ["<leader>g"] } } }

const configured = await launch("e2e-keybind-config", { config: REBOUND })
const beforeSplit = await configured.shape()
await configured.press(`${LEADER}g`)
const afterSplit = await configured.shape()
await configured.stop()
console.log(`config-bound ^a g          -> ${beforeSplit} then ${afterSplit}`)

// The settings window's keybind tab: row 0 is the prefix, so j lands on the
// first real command (panes/pane.split-row). Enter captures the next keystroke,
// u resets the row, s writes the config.
const edited = await launch("e2e-keybind-edit")
await edited.press(`${LEADER}?`)
await edited.press("j")
await edited.press("\r")
await edited.press("g")
await edited.press("s")
const captured = await edited.config()

await edited.press("u")
await edited.press("s")
const reset = await edited.config()
await edited.stop()

const bound = captured?.keys?.bindings ?? {}
const cleared = reset?.keys?.bindings ?? {}
console.log(`settings capture wrote     -> ${JSON.stringify(bound)}`)
console.log(`settings reset wrote       -> ${JSON.stringify(cleared)}`)

report([
  ["a config-bound key dispatches its command", beforeSplit === "1sp 1win 1ag" && afterSplit === "1sp 1win 2ag"],
  ["capture records the pressed key under the prefix", bound["pane.split-row"]?.[0] === "<leader>g"],
  ["save writes the binding to the config", captured !== null],
  ["reset takes the row back to its default", !("pane.split-row" in cleared)],
])
