import { test, expect } from "bun:test"
import { afterEach } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { RenderState, Terminal } from "./ghostty.ts"
import { captureRange } from "./shim.ts"
import { clearSelection, setSelection } from "./shim.ts"
import { SpaceSet } from "./space.ts"
import { workspaceEnv } from "./env.ts"

const bytes = (value: string) => new TextEncoder().encode(value)
const cleanup: (() => void)[] = []

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

test("selection uses screen coordinates through scrollback", () => {
  const term = new Terminal(10, 3, 100)
  term.write(bytes("old\r\nvisible\r\nlast\r\nnew"))
  expect(term.scrollbar.offset).toBe(1)
  setSelection(term.handle, 0, 0, 2, 0)
  expect(new TextDecoder().decode(captureRange(term.handle, {
    startTag: 2, startX: 0, startY: 0, endTag: 2, endX: 2, endY: 0,
  }))).toBe("old")
  clearSelection(term.handle)
  term.free()
})

test("render state reports selected cells without losing wide graphemes", () => {
  const term = new Terminal(12, 2)
  term.write(bytes("A\u30a2B"))
  setSelection(term.handle, 1, 0, 2, 0)
  const state = new RenderState()
  state.update(term)
  const selected: string[] = []
  state.forEachCell((_x, _y, text, _fg, _bg, _width, isSelected) => {
    if (isSelected) selected.push(text)
  })
  expect(selected.join("")).toContain("\u30a2")
  clearSelection(term.handle)
  state.free()
  term.free()
})

test("empty selection is cleared instead of copied", () => {
  const term = new Terminal(10, 2)
  term.write(bytes("text"))
  setSelection(term.handle, 1, 0, 1, 0)
  clearSelection(term.handle)
  const state = new RenderState()
  state.update(term)
  let selected = false
  state.forEachCell((_x, _y, _text, _fg, _bg, _width, value) => { selected ||= value })
  expect(selected).toBe(false)
  state.free()
  term.free()
})

test("drag selection copies through the pane and survives pane borders", async () => {
  const t = await createTestRenderer({ width: 30, height: 8 })
  const host = new BoxRenderable(t.renderer, { id: "host", flexGrow: 1 })
  t.renderer.root.add(host)
  const spaces = new SpaceSet(workspaceEnv(t.renderer), host)
  const copied: string[] = []
  spaces.onCopy = (text) => { copied.push(text); return true }
  const space = spaces.create("test", process.cwd())
  const window = space.newWindow()
  const pane = window.init()
  pane.agent.term.write(bytes("drag"))
  await t.renderOnce()
  await t.mockMouse.drag(pane.x + 1, pane.y + 1, pane.x + 4, pane.y + 1)
  expect(copied).toEqual(["drag"])
  cleanup.push(() => { spaces.disposeAll(); t.renderer.destroy() })
})
