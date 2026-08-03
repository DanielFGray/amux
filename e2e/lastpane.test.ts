/**
 * ^a ; (last-pane) and ^a l (last-window) actually toggle, in the running app.
 *
 * The keymap will happily register a binding that never dispatches
 * (lrn-42d64b), so "the help says ^a ; is bound" and "^a ; moves focus back"
 * are separate claims — and this checks the second. The session file records
 * the active window and, inside each window's layout, the focused pane, so
 * both toggles read back as data rather than as pixels.
 *
 * Each step depends on the one before it — a toggle needs somewhere to toggle
 * back to — so these run in order and share one app.
 */
import { test, expect, beforeAll, afterAll } from "bun:test"
import { launch, LEADER, E2E_TIMEOUT, type App } from "./app.ts"

let app: App

beforeAll(async () => {
  app = await launch("e2e-lastpane")
}, E2E_TIMEOUT)

afterAll(async () => {
  await app?.stop()
})

const activeWindow = async (): Promise<number | undefined> =>
  (await app.session())?.spaces?.[0]?.activeWindow

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

test("^a c makes the new window active", async () => {
  await app.press(`${LEADER}c`)
  await app.until(async () => (await activeWindow()) === 2, "window 2 to be active")
  expect(await activeWindow()).toBe(2)
}, E2E_TIMEOUT)

test("^a l returns to the previous window", async () => {
  await app.press(`${LEADER}l`)
  await app.until(async () => (await activeWindow()) === 1, "^a l to return to window 1")
  expect(await activeWindow()).toBe(1)
}, E2E_TIMEOUT)

test("^a l toggles back to the window it left", async () => {
  await app.press(`${LEADER}l`)
  await app.until(async () => (await activeWindow()) === 2, "^a l to return to window 2")
  expect(await activeWindow()).toBe(2)
}, E2E_TIMEOUT)

/** The pane the split was made from, which ^a ; has to walk back to. */
let splitFocus: string | null = null

test("a split focuses its new pane", async () => {
  const beforeSplit = await focusedPane(2)
  await app.press(`${LEADER}|`)
  await app.until(async () => {
    const now = await focusedPane(2)
    return now !== null && now !== beforeSplit
  }, "the split to focus its new pane")

  splitFocus = await focusedPane(2)
  expect(splitFocus).not.toBeNull()
  expect(splitFocus).not.toBe(beforeSplit)
}, E2E_TIMEOUT)

test("^a ; returns to the pane a split came from", async () => {
  await app.press(`${LEADER};`)
  await app.until(async () => {
    const now = await focusedPane(2)
    return now !== null && now !== splitFocus
  }, "^a ; to return to the pane the split came from")
  expect(await focusedPane(2)).not.toBe(splitFocus)
}, E2E_TIMEOUT)

test("^a ; toggles back to the split's new pane", async () => {
  await app.press(`${LEADER};`)
  await app.until(async () => (await focusedPane(2)) === splitFocus, "^a ; to toggle back")
  expect(await focusedPane(2)).toBe(splitFocus)
}, E2E_TIMEOUT)
