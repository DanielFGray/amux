import { test, expect, afterEach } from "bun:test"
import { setWeight } from "./divider.ts"
import { createHarness, run } from "./harness.ts"
import { encodeLayout, decodeLayout, layoutAgents, type LayoutNode } from "./layout.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

async function setup() {
  const harness = await createHarness()
  cleanup.push(harness.dispose)
  return harness
}

const shape = (node: LayoutNode | null): unknown => {
  if (!node) return null
  if (node.type === "pane") return "pane"
  return { [node.direction]: node.children.map(shape) }
}

test("a single-pane window exports as one pane, not a one-child split", async () => {
  const { window } = await setup()
  const exported = window.exportLayout()
  expect(exported.root).toEqual({
    type: "pane",
    agent: window.panes[0]!.agent.id,
    weight: expect.any(Number),
  })
})

test("the exported tree matches the nesting the splits actually built", async () => {
  const { window, layout } = await setup()
  // left | (topRight over bottomRight)
  run(window.splitSpawn("row"))
  run(window.splitSpawn("column"))
  await layout()
  expect(shape(window.exportLayout().root)).toEqual({ row: ["pane", { column: ["pane", "pane"] }] })
})

test("every pane appears exactly once, in left-to-right order", async () => {
  const { window, layout } = await setup()
  run(window.splitSpawn("row"))
  run(window.splitSpawn("column"))
  await layout()
  const ids = window.panes.map((p) => p.agent.id)
  expect(layoutAgents(window.exportLayout()).sort()).toEqual([...ids].sort())
})

test("the focused pane is recorded", async () => {
  const { window, layout } = await setup()
  const second = run(window.splitSpawn("row"))!
  await layout()
  window.focus(second)
  expect(window.exportLayout().focus).toBe(second.agent.id)
})

test("resized weights survive the export", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  run(window.splitSpawn("row"))
  await layout()
  setWeight(first, 7)
  const root = window.exportLayout().root as Extract<LayoutNode, { type: "split" }>
  const exported = root.children.find((c) => c.type === "pane" && c.agent === first.agent.id)
  expect(exported?.weight).toBe(7)
})

// Zoom parks the real tree off the root, so a naive export would record a
// single-pane window and destroy the layout on the next restore.
test("exporting while zoomed records the underlying layout, not the zoomed view", async () => {
  const { window, layout } = await setup()
  run(window.splitSpawn("row"))
  run(window.splitSpawn("column"))
  await layout()
  const before = window.exportLayout()

  window.zoom()
  await layout()
  expect(window.zoomed).toBe(true)

  expect(window.exportLayout()).toEqual(before)
})

test("a zoomed pane keeps the weight it had in the layout, not its zoom weight", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  run(window.splitSpawn("row"))
  await layout()
  setWeight(first, 5)
  window.focus(first)
  const before = window.exportLayout()

  window.zoom()
  await layout()
  expect(window.exportLayout()).toEqual(before)
})

test("unzooming leaves the export unchanged, so zoom is invisible to persistence", async () => {
  const { window, layout } = await setup()
  run(window.splitSpawn("row"))
  run(window.splitSpawn("column"))
  await layout()
  const before = window.exportLayout()

  window.zoom()
  await layout()
  window.zoom()
  await layout()

  expect(window.exportLayout()).toEqual(before)
})

test("a live layout survives a round trip through the wire format", async () => {
  const { window, layout } = await setup()
  run(window.splitSpawn("row"))
  run(window.splitSpawn("column"))
  await layout()
  const exported = window.exportLayout()
  expect(decodeLayout(encodeLayout(exported))).toEqual(exported)
})

test("closing a pane leaves no husk in the exported tree", async () => {
  const { window, layout } = await setup()
  run(window.splitSpawn("row"))
  const third = run(window.splitSpawn("column"))!
  await layout()
  window.close(third)
  await layout()
  // The column split held two panes; losing one collapses it back into the row.
  expect(shape(window.exportLayout().root)).toEqual({ row: ["pane", "pane"] })
})
