import { test, expect, afterEach } from "bun:test"
import { setWeight } from "./divider.ts"
import { createHarness, run } from "./harness.ts"
import type { TerminalPane } from "./pane.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

async function setup() {
  const harness = await createHarness()
  cleanup.push(harness.dispose)
  return harness
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
  const right = run(window.splitSpawn("row"))!
  const bottomRight = run(window.splitSpawn("column"))!
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

test("zoom fills the window with one pane and restores the layout exactly", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const right = run(window.splitSpawn("row"))!
  const bottomRight = run(window.splitSpawn("column"))!
  await layout()

  const before = window.panes.map((p) => `${p.x},${p.y},${p.width},${p.height}`)

  window.focus(right)
  window.zoom()
  await layout()

  expect(window.zoomed).toBe(true)
  expect(window.label).toContain(" Z")
  // Filling the window means the whole window, not merely the biggest slot.
  expect(right.width).toBe(window.root.width)
  expect(right.height).toBe(window.root.height)

  window.zoom()
  await layout()

  expect(window.zoomed).toBe(false)
  expect(window.label).not.toContain(" Z")
  expect(window.panes.map((p) => `${p.x},${p.y},${p.width},${p.height}`)).toEqual(before)
  expect(window.panes).toEqual([first, right, bottomRight])
})

test("zoom survives a resize and an uneven split's weights", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = run(window.splitSpawn("row"))!
  await layout()

  // Drag the seam well off centre, so an approximate restore would show.
  setWeight(first, 50)
  setWeight(second, 10)
  await layout()
  const widths = [first.width, second.width]

  window.focus(second)
  window.zoom()
  await layout()
  window.zoom()
  await layout()

  expect([first.width, second.width]).toEqual(widths)
})

test("reshaping the layout while zoomed drops the zoom rather than the panes", async () => {
  const { window, layout } = await setup()
  run(window.splitSpawn("row"))
  await layout()

  // Splitting.
  window.zoom()
  expect(window.zoomed).toBe(true)
  const third = run(window.splitSpawn("row"))!
  expect(window.zoomed).toBe(false)
  expect(window.panes).toHaveLength(3)
  await layout()
  expect(third.width).toBeGreaterThan(0)

  // Closing the zoomed pane itself — the case that strands the detached tree.
  window.focus(third)
  window.zoom()
  expect(window.zoomed).toBe(true)
  window.close(third)
  await layout()
  expect(window.zoomed).toBe(false)
  expect(window.panes).toHaveLength(2)
  // Every survivor is back on screen, not parked off the root.
  for (const pane of window.panes) expect(pane.width).toBeGreaterThan(0)
})

test("focusing another pane unzooms, but switching away and back does not", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = run(window.splitSpawn("row"))!
  await layout()

  window.focus(second)
  window.zoom()
  expect(window.zoomed).toBe(true)

  // Re-focusing the zoomed pane is what a window switch does; it must not
  // silently undo the zoom.
  window.focus(second)
  expect(window.zoomed).toBe(true)

  window.focus(first)
  expect(window.zoomed).toBe(false)
})

test("swap exchanges two panes' places while each slot keeps its size", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = run(window.splitSpawn("row"))!
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

test("resizeFocus nudges the divider on the focused pane's side", async () => {
  const { window, layout } = await setup()
  const left = window.panes[0]!
  const right = run(window.splitSpawn("row"))!
  await layout()
  const before = [left.width, right.width]

  // The focused pane grows toward the requested direction: the divider on that
  // side moves one cell, shrinking the neighbour by the same amount.
  window.focus(right)
  window.resizeFocus("left")
  await layout()
  expect([left.width, right.width]).toEqual([before[0]! - 1, before[1]! + 1])

  // And back the other way, from the other pane, returns to the start.
  window.focus(left)
  window.resizeFocus("right")
  await layout()
  expect([left.width, right.width]).toEqual(before)
})

test("resizeFocus up and down moves a horizontal divider", async () => {
  const { window, layout } = await setup()
  const top = window.panes[0]!
  const bottom = run(window.splitSpawn("column"))!
  await layout()
  const before = [top.height, bottom.height]

  window.focus(bottom)
  window.resizeFocus("up")
  await layout()
  expect([top.height, bottom.height]).toEqual([before[0]! - 1, before[1]! + 1])
})

test("resizeFocus stops at the minimum pane size rather than stranding a neighbour", async () => {
  const { window, layout } = await setup()
  const left = window.panes[0]!
  const right = run(window.splitSpawn("row"))!
  await layout()
  const total = left.width + right.width
  window.focus(left)

  // Far more presses than there are cells: the clamp, not the loop, is what
  // stops it.
  for (let i = 0; i < 100; i++) {
    window.resizeFocus("right")
    await layout()
  }
  expect(right.width).toBe(3) // MIN_CELLS
  expect(left.width + right.width).toBe(total)
})

test("resizeFocus moves the outer divider when the focused pane is nested", async () => {
  const { window, layout } = await setup()
  // left | (topRight over bottomRight) — the focused pane's left divider is
  // two levels up, the same walk #hasNeighbour makes.
  const left = window.panes[0]!
  const right = run(window.splitSpawn("row"))!
  window.focus(right)
  const bottomRight = run(window.splitSpawn("column"))!
  await layout()

  const before = { left: left.width, right: right.width, bottom: bottomRight.width }
  window.focus(right)
  window.resizeFocus("left")
  await layout()

  // The outer seam moved: the left pane shrank and the whole column — both
  // right-hand panes — grew into the space.
  expect(left.width).toBe(before.left - 1)
  expect(right.width).toBe(before.right + 1)
  expect(bottomRight.width).toBe(before.bottom + 1)
})

test("resizeFocus with nothing on that side does nothing", async () => {
  const { window, layout } = await setup()
  const left = window.panes[0]!
  const right = run(window.splitSpawn("row"))!
  await layout()
  const before = [left.width, right.width]

  // The left pane is flush against the window edge on three sides.
  window.focus(left)
  window.resizeFocus("left")
  window.resizeFocus("up")
  window.resizeFocus("down")
  await layout()
  expect([left.width, right.width]).toEqual(before)
})

test("resizeFocus while zoomed does nothing and leaves the parked layout intact", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = run(window.splitSpawn("row"))!
  await layout()
  const before = window.panes.map((p) => `${p.x},${p.y},${p.width},${p.height}`)

  window.focus(second)
  window.zoom()
  await layout()
  expect(window.zoomed).toBe(true)

  window.resizeFocus("left")
  window.resizeFocus("right")
  await layout()
  expect(window.zoomed).toBe(true)

  window.zoom()
  await layout()
  expect(window.panes.map((p) => `${p.x},${p.y},${p.width},${p.height}`)).toEqual(before)
})
