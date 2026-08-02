/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { DEFAULT_CONFIG } from "../config.ts"
import type { HelpGroup } from "../bindings.ts"
import { Settings, keybindGroups, keybindLine, keybindTargets, settingsFields } from "./Settings.tsx"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

const GROUPS: HelpGroup[] = [
  {
    group: "panes",
    entries: [
      { name: "pane.zoom", keys: "^a z", desc: "zoom", custom: false, fixed: false },
      { name: "pane.close", keys: "^a x", desc: "close pane", custom: true, fixed: false },
    ],
  },
  {
    group: "global",
    entries: [
      { name: "app.quit", keys: "^a q", desc: "quit", custom: false, fixed: false },
      // Not rebindable, so it takes no selection index of its own.
      { name: "app.send-prefix", keys: "^a ^a", desc: "send prefix", custom: false, fixed: true },
    ],
  },
]

/**
 * The prefix is a row like any other, and a fixed command is not.
 *
 * Row 0 being the prefix is what lets one list teach the whole keymap: the key
 * every other binding starts with is edited in the same place as the bindings
 * themselves.
 */
test("the editor enumerates the prefix and every rebindable command", () => {
  expect(keybindTargets(GROUPS)).toEqual([null, "pane.zoom", "pane.close", "app.quit"])
})

/** The index the key handler acts on and the row drawn on screen are the same
 *  row — which only holds if both count from one enumeration. */
test("rows carry the selection index they are drawn at", () => {
  const rows = keybindGroups(GROUPS, "ctrl+a")

  expect(rows.map((g) => g.group)).toEqual(["prefix", "panes", "global"])
  expect(rows[0]!.entries[0]).toMatchObject({ index: 0, keys: "^a", name: null })
  expect(rows[1]!.entries.map((e) => e.index)).toEqual([1, 2])
  // The fixed row is drawn but cannot be landed on.
  expect(rows[2]!.entries.map((e) => e.index)).toEqual([3, null])
})

/**
 * The list is longer than the window, so the caller scrolls it — and can only
 * do that if a selection index maps to the line it was drawn on. Group
 * headings and the blank line between groups both count.
 */
test("a selection index maps to its line in the scrolled list", () => {
  // prefix heading, prefix row, blank, panes heading, zoom, close, blank...
  expect(keybindLine(GROUPS, 0)).toBe(1)
  expect(keybindLine(GROUPS, 1)).toBe(4)
  expect(keybindLine(GROUPS, 2)).toBe(5)
  expect(keybindLine(GROUPS, 3)).toBe(8)
})

test("pane gap setting explains the border mode at zero and one", () => {
  const field = settingsFields(DEFAULT_CONFIG, "appearance")[0]!
  expect(field.hint).toContain("0 merged")
  expect(field.hint).toContain("1 borders")
})

test("appearance settings expose which-key visibility and delay", () => {
  const fields = settingsFields(
    {
      ...DEFAULT_CONFIG,
      appearance: { ...DEFAULT_CONFIG.appearance, whichKeyHints: false, whichKeyDelay: 1 },
    },
    "appearance",
  )
  expect(fields.slice(1).map((field) => field.value)).toEqual(["no", "1s"])
})

test("the shell setting is displayed as intentionally read-only", () => {
  const shell = settingsFields(
    { ...DEFAULT_CONFIG, behaviour: { ...DEFAULT_CONFIG.behaviour, shell: "/bin/fish" } },
    "behaviour",
  )[1]!

  expect(shell.value).toBe("/bin/fish")
  expect(shell.hint).toContain("read-only")
  expect(shell.hint).toContain("new agents")
})

async function draw(over: Partial<Parameters<typeof Settings>[0]> = {}) {
  const t = await createTestRenderer({ width: 80, height: 20 })
  cleanup.push(() => t.renderer.destroy())
  await render(
    () => (
      <Settings
        config={DEFAULT_CONFIG}
        section="keybinds"
        selected={0}
        groups={GROUPS}
        leader="ctrl+a"
        conflicts={[]}
        capturing={false}
        width={80}
        height={20}
        dirty={false}
        {...over}
      />
    ),
    t.renderer,
  )
  await t.renderOnce()
  return t.captureCharFrame()
}

test("the keybinds tab lists the prefix alongside the commands it prefixes", async () => {
  const frame = await draw()

  expect(frame).toContain("prefix")
  expect(frame).toContain("^a z")
  expect(frame).toContain("zoom")
  // A rebound command is marked as no longer the default.
  expect(frame).toContain("close pane *")
})

test("a rebound prefix is what the whole list reads as", async () => {
  const frame = await draw({ leader: "ctrl+b" })

  // The prefix row shows the new key; the commands keep whatever the keymap
  // handed back, which is the same list re-read after the rebuild.
  expect(frame).toContain("^b")
})

test("the row being recorded says so, in place of its keys", async () => {
  const frame = await draw({ capturing: true, selected: 1 })

  expect(frame).toContain("press a key…")
  expect(frame).toContain("esc cancels")
  // Only the selected row is in capture; the others still show their keys.
  expect(frame).toContain("^a q")
})

/** A collision leaves one of the two commands dead. Saying so beats the crash
 *  this used to be, now that a user can cause one. */
test("a conflict is reported rather than hidden", async () => {
  const frame = await draw({
    conflicts: [{ sequence: "^a k", commands: ["pane.focus-up", "agent.kill"] }],
  })

  expect(frame).toContain("^a k")
  expect(frame).toContain("agent.kill")
})

test("a failed settings save is visible while the dirty marker remains", async () => {
  const frame = await draw({
    dirty: true,
    error: "could not save settings: permission denied",
  })

  expect(frame).toContain("could not save settings")
  expect(frame).toContain("permission denied")
  expect(frame).toContain("unsaved")
})
