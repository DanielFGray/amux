/**
 * ^a ; (last-pane) and ^a l (last-window) actually toggle, in the running app.
 *
 * The keymap will happily register a binding that never dispatches
 * (lrn-42d64b), so "the help says ^a ; is bound" and "^a ; moves focus back"
 * are separate claims — and this checks the second. The session file records
 * the active window and, inside each window's layout, the focused pane, so
 * both toggles read back as data rather than as pixels.
 *
 *   bun run e2e:lastpane
 */
import { launch, report, LEADER } from "./app.ts"

const app = await launch("e2e-lastpane")

/** Which pane a window's persisted layout says is focused. */
const focusedPane = async (number: number): Promise<string | null> => {
  const session = await app.session()
  const window = session?.spaces?.[0]?.windows?.find((w: { number: number }) => w.number === number)
  if (typeof window?.layout !== "string") return null
  try {
    return (JSON.parse(window.layout) as { focus?: string }).focus ?? null
  } catch {
    return null
  }
}

// Last-window: ^a c makes window 2 active, and ^a l walks back and forth.
await app.press(`${LEADER}c`)
await app.until(
  async () => (await app.session())?.spaces?.[0]?.activeWindow === 2,
  "window 2 to be active",
)

await app.press(`${LEADER}l`)
await app.until(
  async () => (await app.session())?.spaces?.[0]?.activeWindow === 1,
  "^a l to return to window 1",
)

await app.press(`${LEADER}l`)
await app.until(
  async () => (await app.session())?.spaces?.[0]?.activeWindow === 2,
  "^a l to return to window 2",
)

// Last-pane: splitting window 2 focuses its newcomer, and ^a ; walks focus
// back to the pane the split came from — and back again, the toggle.
const beforeSplit = await focusedPane(2)
await app.press(`${LEADER}|`)
await app.until(
  async () => {
    const now = await focusedPane(2)
    return now !== null && now !== beforeSplit
  },
  "the split to focus its new pane",
)

const splitFocus = await focusedPane(2)
await app.press(`${LEADER};`)
await app.until(
  async () => {
    const now = await focusedPane(2)
    return now !== null && now !== splitFocus
  },
  "^a ; to return to the pane the split came from",
)

await app.press(`${LEADER};`)
await app.until(
  async () => (await focusedPane(2)) === splitFocus,
  "^a ; to toggle back to the new pane",
)

await app.stop()

report([
  ["^a l returns to the previous window", true],
  ["^a l toggles back to the window it left", true],
  ["^a ; returns to the pane a split came from", true],
  ["^a ; toggles back to the split's new pane", true],
])
