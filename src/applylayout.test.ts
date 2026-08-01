import { test, expect, afterEach } from "bun:test"
import { getWeight, setWeight } from "./divider.ts"
import { Divider } from "./divider.ts"
import { createHarness } from "./harness.ts"
import { RenderState } from "./ghostty.ts"
import { encodeLayout, decodeLayout, layoutAgents, makeLayout, type LayoutNode } from "./layout.ts"
import type { Agent } from "./agent.ts"

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

/** The agent's on-screen text, so "the pane was reused" is checked against the
 *  terminal itself rather than against object identity alone. */
function screenTail(agent: Agent): string {
  const state = new RenderState()
  try {
    state.update(agent.term)
    return state.tailText(8).join("\n")
  } finally {
    state.free()
  }
}

test("applying what was exported is a fixed point", async () => {
  const { window, layout } = await setup()
  window.split("row")
  window.split("column")
  await layout()
  const exported = window.exportLayout()

  expect(window.applyLayout(exported)).toBe(true)
  await layout()
  expect(window.exportLayout()).toEqual(exported)
})

test("a layout survives the wire format and rebuilds the same tree", async () => {
  const { window, layout } = await setup()
  window.split("row")
  window.split("column")
  await layout()
  const saved = encodeLayout(window.exportLayout())

  // Reshape it into something else entirely, then restore.
  window.selectLayout("even-vertical")
  await layout()
  expect(shape(window.exportLayout().root)).toEqual({ column: ["pane", "pane", "pane"] })

  expect(window.applyLayout(decodeLayout(saved))).toBe(true)
  await layout()
  expect(encodeLayout(window.exportLayout())).toBe(saved)
})

// A pane is a viewport onto a running process, so rebuilding must move panes
// rather than recreate them — a fresh pane would show an empty screen.
test("panes are reused, keeping their terminal and its output", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = window.split("row")!
  const agent = second.agent
  agent.write("echo applylayout-marker-7\n")
  await Bun.sleep(300)
  expect(screenTail(agent)).toContain("applylayout-marker-7")

  window.applyLayout(
    makeLayout({
      type: "split",
      direction: "column",
      weight: 1,
      children: [
        { type: "pane", agent: agent.id, weight: 1 },
        { type: "pane", agent: first.agent.id, weight: 1 },
      ],
    }),
  )
  await layout()

  // Same pane objects, same agents, same screen — only the arrangement moved.
  expect(window.panes).toEqual([second, first])
  expect(second.agent).toBe(agent)
  expect(agent.exited).toBe(false)
  expect(screenTail(agent)).toContain("applylayout-marker-7")
})

test("the rebuilt tree gets the dividers it needs, and no more", async () => {
  const { window, layout } = await setup()
  window.split("row")
  window.split("row")
  await layout()
  window.selectLayout("even-horizontal")
  await layout()

  const kids = window.root.getChildren()
  // pane | divider | pane | divider | pane
  expect(kids).toHaveLength(5)
  expect(kids.filter((k) => k instanceof Divider)).toHaveLength(2)
  expect(kids[1]).toBeInstanceOf(Divider)
  expect(kids[3]).toBeInstanceOf(Divider)
})

test("weights in the layout become real geometry", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = window.split("row")!
  await layout()

  window.applyLayout(
    makeLayout({
      type: "split",
      direction: "row",
      weight: 1,
      children: [
        { type: "pane", agent: first.agent.id, weight: 3 },
        { type: "pane", agent: second.agent.id, weight: 1 },
      ],
    }),
  )
  await layout()

  expect(getWeight(first)).toBe(3)
  // Roughly 3:1 across the window, less the divider column.
  expect(first.width).toBeGreaterThan(second.width * 2)
})

test("the focus recorded in the layout is restored", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = window.split("row")!
  await layout()
  window.focus(second)
  const exported = window.exportLayout()

  window.focus(first)
  window.applyLayout(exported)
  await layout()
  expect(window.focused).toBe(second)
})

test("a layout with no focus still leaves a pane focused", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  window.split("row")
  await layout()
  const { root } = window.exportLayout()

  expect(window.applyLayout(makeLayout(root))).toBe(true)
  await layout()
  expect(window.focused).toBe(first)
})

// A layout routinely outlives its processes: a session restored a day later, or
// a layout string pasted from another window.
test("panes naming an agent this window does not own are pruned away", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = window.split("row")!
  await layout()

  const applied = window.applyLayout(
    makeLayout({
      type: "split",
      direction: "row",
      weight: 1,
      children: [
        { type: "pane", agent: first.agent.id, weight: 1 },
        { type: "pane", agent: "agent-that-never-existed", weight: 1 },
        { type: "pane", agent: second.agent.id, weight: 1 },
      ],
    }),
  )
  await layout()

  expect(applied).toBe(true)
  expect(window.panes).toEqual([first, second])
  expect(window.root.getChildren().filter((k) => k instanceof Divider)).toHaveLength(1)
})

// Pruning to nothing must not be a way to empty the window: a stale string is
// far likelier than a genuine wish to close every pane.
test("a layout naming nothing this window owns is refused, changing nothing", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = window.split("row")!
  await layout()
  const before = window.exportLayout()

  const applied = window.applyLayout(
    makeLayout({ type: "pane", agent: "nobody", weight: 1 }),
  )

  expect(applied).toBe(false)
  expect(window.panes).toEqual([first, second])
  expect(window.exportLayout()).toEqual(before)
})

test("an empty layout is refused rather than closing every pane", async () => {
  const { window } = await setup()
  expect(window.applyLayout(makeLayout(null))).toBe(false)
  expect(window.panes).toHaveLength(1)
})

// The pane is a view; dropping it is a detach, exactly as pane.close is.
test("a pane the layout has no slot for is closed, but its agent survives", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = window.split("row")!
  const dropped = second.agent
  await layout()

  window.applyLayout(makeLayout({ type: "pane", agent: first.agent.id, weight: 1 }))
  await layout()

  expect(window.panes).toEqual([first])
  expect(window.agents).toContain(dropped)
  expect(dropped.exited).toBe(false)
  expect(window.detached).toContain(dropped)
  // The survivor fills the window rather than keeping its old half-share.
  expect(first.width).toBe(window.root.width)
})

// While zoomed the real tree is parked off the root; dismantling it from there
// is how a rebuild ends up restoring a layout that contains nothing.
test("applying a layout drops a zoom first", async () => {
  const { window, layout } = await setup()
  window.split("row")
  await layout()
  window.zoom()
  expect(window.zoomed).toBe(true)

  window.selectLayout("even-vertical")
  await layout()

  expect(window.zoomed).toBe(false)
  for (const pane of window.panes) expect(pane.width).toBeGreaterThan(0)
})

test("two panes on one agent stay two panes across a rebuild", async () => {
  const { window, layout } = await setup()
  const shared = window.spawn("shared", ["sleep", "30"])
  window.split("row", shared)
  window.split("row", shared)
  await layout()
  expect(window.panes.filter((p) => p.agent === shared)).toHaveLength(2)

  window.selectLayout("even-vertical")
  await layout()

  expect(window.panes.filter((p) => p.agent === shared)).toHaveLength(2)
  expect(layoutAgents(window.exportLayout()).filter((id) => id === shared.id)).toHaveLength(2)
})

// Presets over the live tree.

test("a preset rearranges the same panes, in the same order", async () => {
  const { window, layout } = await setup()
  window.split("row")
  window.split("column")
  await layout()
  const before = window.panes.map((p) => p.agent.id)

  expect(window.selectLayout("tiled")).toBe(true)
  await layout()

  expect(window.panes.map((p) => p.agent.id)).toEqual(before)
})

test("even-horizontal actually gives the panes equal widths", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  window.split("row")
  window.split("column")
  await layout()
  // Drag one well off centre so an approximate result would show.
  setWeight(first, 20)
  await layout()

  window.selectLayout("even-horizontal")
  await layout()

  const widths = window.panes.map((p) => p.width)
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
})

test("a preset keeps the focused pane focused", async () => {
  const { window, layout } = await setup()
  window.split("row")
  const third = window.split("column")!
  await layout()
  window.focus(third)

  window.selectLayout("main-vertical")
  await layout()
  expect(window.focused).toBe(third)
})

test("a window remembers the preset it was arranged by, and forgets it when reshaped", async () => {
  const { window, layout } = await setup()
  window.split("row")
  await layout()
  // Built by hand, so it matches no preset.
  expect(window.preset).toBeNull()

  window.selectLayout("tiled")
  expect(window.preset).toBe("tiled")

  // Splitting moves it off that arrangement.
  window.split("row")
  expect(window.preset).toBeNull()

  window.selectLayout("even-vertical")
  expect(window.preset).toBe("even-vertical")
  // As does closing a pane.
  window.close(window.panes[0]!)
  expect(window.preset).toBeNull()
})

test("dragging a seam forgets the preset, so next-layout advances", async () => {
  const { window, layout } = await setup()
  window.split("row")
  await layout()
  window.selectLayout("even-horizontal")
  await layout()
  expect(window.preset).toBe("even-horizontal")

  const divider = window.root.getChildren().find((k) => k instanceof Divider) as Divider
  divider.onResized!()
  expect(window.preset).toBeNull()
})

test("a preset on a single pane is a no-op that still reports success", async () => {
  const { window, layout } = await setup()
  const only = window.panes[0]!
  expect(window.selectLayout("tiled")).toBe(true)
  await layout()
  expect(window.panes).toEqual([only])
  expect(only.width).toBe(window.root.width)
})
