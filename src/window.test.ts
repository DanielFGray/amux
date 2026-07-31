import { test, expect, afterEach } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { SpaceSet } from "./space.ts"
import type { Window } from "./window.ts"
import type { TerminalPane } from "./pane.ts"

const SHELL = ["bash"]
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

async function setup(): Promise<{ window: Window; layout: () => Promise<void> }> {
  const t = await createTestRenderer({ width: 80, height: 24 })
  const host = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 })
  t.renderer.root.add(host)
  const spaces = new SpaceSet(t.renderer, host, SHELL)
  const space = spaces.create("proj", process.cwd())
  const window = space.newWindow()
  window.init()
  cleanup.push(() => {
    spaces.disposeAll()
    t.renderer.destroy()
  })
  // Geometry comes from yoga, which only runs on a frame — and directional
  // focus is entirely geometric, so nothing here means anything until it has.
  return { window, layout: () => t.renderOnce() }
}

test("a pane is named after the command it runs, not a generic 'shell'", async () => {
  const { window } = await setup()
  expect(window.panes[0]!.agent.name).toBe("bash")
})

test("focusDirection crosses nesting levels rather than walking siblings", async () => {
  const { window, layout } = await setup()
  // left | (topRight over bottomRight) — the classic case where the pane to the
  // right of `left` is two levels down and sibling-walking picks the wrong one.
  const left = window.panes[0]!
  const right = window.split("row")!
  const bottomRight = window.split("column")!
  await layout()

  const at = (p: TerminalPane) => `${p.x},${p.y}`
  expect(at(right)).not.toBe(at(bottomRight))

  window.focus(left)
  window.focusDirection("right")
  // Both right-hand panes are equidistant; the one overlapping `left` most is
  // whichever the pointer would land on, and either is a legitimate answer —
  // what matters is that focus left the pane at all.
  expect(window.focused).not.toBe(left)

  window.focus(bottomRight)
  window.focusDirection("up")
  expect(window.focused).toBe(right)
  window.focusDirection("left")
  expect(window.focused).toBe(left)
  window.focusDirection("left")
  // Nothing further left: focus stays put rather than wrapping.
  expect(window.focused).toBe(left)
})

test("swap exchanges two panes' places while each slot keeps its size", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = window.split("row")!
  await layout()

  const slots = [first.x, second.x]
  const firstAgent = first.agent
  const secondAgent = second.agent

  window.focus(first)
  window.swap(1)
  await layout()

  // The focused pane travelled to the other slot, and the slots themselves are
  // where they were.
  expect(window.focused).toBe(first)
  expect(first.x).toBe(slots[1]!)
  expect(second.x).toBe(slots[0]!)
  expect(window.panes.map((p) => p.agent)).toEqual([secondAgent, firstAgent])
})
