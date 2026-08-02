/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { createSignal } from "solid-js"
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

test("a changed filter resets the selected result to the first match", async () => {
  const t = await createTestRenderer({ width: 90, height: 20 })
  cleanup.push(() => t.renderer.destroy())
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(1)
  let onInput: ((value: string) => void) | undefined
  await render(
    () => (
      <CommandPalette
        entries={entries.filter((entry) => entry.name.includes(query()))}
        query={query()}
        selected={selected()}
        width={90}
        onInput={(value) => {
          setQuery(value)
          setSelected(0)
        }}
        onSubmit={() => {}}
      />
    ),
    t.renderer,
  )
  onInput = (value) => {
    setQuery(value)
    setSelected(0)
  }
  onInput("app")
  await t.renderOnce()

  expect(query()).toBe("app")
  expect(selected()).toBe(0)
  expect(t.captureCharFrame()).toContain("app.help")
  expect(t.captureCharFrame()).not.toContain("pane.split-row")
})

test("a modal palette consumes a click instead of bubbling to its host", async () => {
  const t = await createTestRenderer({ width: 90, height: 20 })
  cleanup.push(() => t.renderer.destroy())
  let hostClicks = 0
  await render(
    () => (
      <box style={{ width: "100%", height: "100%" }} onMouseDown={() => hostClicks++}>
        <CommandPalette
          entries={entries}
          query=""
          selected={0}
          width={90}
          onInput={() => {}}
          onSubmit={() => {}}
        />
      </box>
    ),
    t.renderer,
  )
  await t.renderOnce()
  await t.mockMouse.click(10, 2)

  expect(hostClicks).toBe(0)
})
