/**
 * ^a ctrl+arrow resizes the pane by keyboard.
 *
 * The unit suite checks the pieces separately — a binding compiles and
 * dispatches (bindings.test.ts), a window method moves the weights
 * (window.test.ts). What only a real app can show is the pieces joined up: the
 * keymap reaching the command, the command reaching the window, and the
 * divider actually moving on screen. That is the ts-456094 class of bug — a
 * command that quietly does nothing — so it is worth pressing the key for.
 *
 * The marker is the tee where the divider meets the window's top frame line:
 * a column of pure border glyphs, which shell output cannot fake, sitting one
 * cell off the divider itself. Plain arrows are focus, not resize, so they are
 * checked against moving it at all.
 *
 *   bun run e2e:resize
 */
import { launch, report, LEADER } from "./app.ts"

/** ctrl+left as xterm writes it. Sent whole via App.send — press() writes one
 *  character per write with a gap, and the streaming parser would split this
 *  sequence on its escape timeout. */
const CTRL_LEFT = "\x1b[1;5D"
const RIGHT = "\x1b[C"

/** The column of the top-frame tee — where a divider meets the outer border. */
function teeColumn(screen: string): number {
  for (const line of screen.split("\n")) {
    const at = line.indexOf("┬")
    if (at !== -1) return at
  }
  return -1
}

const app = await launch("e2e-resize")

await app.press(`${LEADER}|`) // split left/right
await app.until(() => teeColumn(app.screen()) !== -1, "the split to draw a divider")
const afterSplit = teeColumn(app.screen())

await app.press(LEADER)
app.send(CTRL_LEFT)
await app.until(() => teeColumn(app.screen()) === afterSplit - 1, "the divider to move one cell left")
const afterOne = teeColumn(app.screen())

await app.press(LEADER)
app.send(CTRL_LEFT)
await app.press(LEADER)
app.send(CTRL_LEFT)
await app.until(() => teeColumn(app.screen()) === afterSplit - 3, "three cells left")
const afterThree = teeColumn(app.screen())

// The plain arrow shares the prefix with resize but means focus: the divider
// must not move under it.
await app.press(LEADER)
app.send(RIGHT)
await Bun.sleep(500)
const afterFocus = teeColumn(app.screen())

await app.stop()

report([
  ["^a ctrl+left moves the divider one cell per press", afterOne === afterSplit - 1 && afterThree === afterSplit - 3],
  ["^a right focuses instead of resizing", afterFocus === afterThree],
])
