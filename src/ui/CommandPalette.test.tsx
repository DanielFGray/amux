/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { CommandPalette } from "./CommandPalette.tsx"
import type { PaletteEntry } from "../bindings.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

const entries: PaletteEntry[] = [
  { name: "pane.split-row", group: "panes", keys: "^a |", desc: "split left/right" },
  { name: "app.help", group: "global", keys: "^a ?", desc: "keybinds" },
]

test("palette renders the query, groups, sequences and descriptions", async () => {
  const t = await createTestRenderer({ width: 90, height: 20 })
  cleanup.push(() => t.renderer.destroy())
  await render(
    () => (
      <CommandPalette
        entries={entries}
        query="split"
        selected={0}
        width={90}
        onInput={() => {}}
        onSubmit={() => {}}
      />
    ),
    t.renderer,
  )
  await t.renderOnce()
  const frame = t.captureCharFrame()
  expect(frame).toContain("panes")
  expect(frame).toContain("^a |")
  expect(frame).toContain("pane.split-row")
  expect(frame).toContain("split left/right")
  expect(frame).toContain("↑↓ select · enter run · esc close")
})
