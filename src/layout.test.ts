import { test, expect } from "bun:test"
import {
  LAYOUT_VERSION,
  LayoutFormatError,
  collapse,
  decodeLayout,
  encodeLayout,
  layoutAgents,
  layoutPanes,
  nextPreset,
  parseLayout,
  presetLayout,
  prune,
  LAYOUT_PRESETS,
  type Layout,
  type LayoutNode,
} from "./layout.ts"

const pane = (agent: string, weight = 1): LayoutNode => ({ type: "pane", agent, weight })
const split = (
  direction: "row" | "column",
  children: LayoutNode[],
  weight = 1,
): LayoutNode => ({ type: "split", direction, weight, children })

const layout = (root: LayoutNode | null, focus?: string): Layout =>
  focus ? { version: LAYOUT_VERSION, root, focus } : { version: LAYOUT_VERSION, root }

test("panes are listed left to right, depth first", () => {
  const tree = split("row", [pane("a"), split("column", [pane("b"), pane("c")]), pane("d")])
  expect(layoutPanes(tree).map((p) => p.agent)).toEqual(["a", "b", "c", "d"])
})

test("a layout round-trips through encode and decode", () => {
  const original = layout(
    split("row", [pane("a", 2), split("column", [pane("b"), pane("c", 3)], 5)]),
    "c",
  )
  expect(parseLayout(JSON.parse(encodeLayout(original)))).toEqual(original)
})

test("encoding is stable, so equal layouts produce equal strings", () => {
  const a = layout(split("row", [pane("x"), pane("y")]))
  const b = layout(split("row", [pane("x"), pane("y")]))
  expect(encodeLayout(a)).toBe(encodeLayout(b))
})

// The live tree collapses a one-child split away, so a decoded layout that kept
// the husk would rebuild an extra nesting level and the round trip would not be
// a fixed point. This is the case that closing a pane produces.
test("a split with one child collapses to that child and inherits its weight", () => {
  expect(collapse(split("row", [pane("only")], 7))).toEqual(pane("only", 7))
})

test("collapsing is recursive, so nested husks all disappear", () => {
  const nested = split("row", [split("column", [split("row", [pane("deep")])])], 4)
  expect(collapse(nested)).toEqual(pane("deep", 4))
})

// Window.split only nests when the axis alternates, so a same-axis nesting is a
// shape the live tree would never build and could not round-trip as written.
test("a same-axis child split is flattened into its parent", () => {
  const tree = split("row", [pane("a", 1), split("row", [pane("b"), pane("c")], 2)])
  const flattened = collapse(tree) as Extract<LayoutNode, { type: "split" }>
  expect(flattened.children.map((c) => (c.type === "pane" ? c.agent : "?"))).toEqual(["a", "b", "c"])
})

test("flattening preserves the share of space the nested split occupied", () => {
  const tree = split("row", [pane("a", 2), split("row", [pane("b", 1), pane("c", 3)], 4)])
  const flattened = collapse(tree) as Extract<LayoutNode, { type: "split" }>
  // b and c split the nested weight of 4 in a 1:3 ratio.
  expect(flattened.children.map((c) => c.weight)).toEqual([2, 1, 3])
})

test("an alternating-axis nesting is left alone", () => {
  const tree = split("row", [pane("a"), split("column", [pane("b"), pane("c")])])
  expect(collapse(tree)).toEqual(tree)
})

test("pruning drops panes whose agent is gone and keeps the survivors' shape", () => {
  const tree = split("row", [pane("a"), split("column", [pane("dead"), pane("c")])])
  const pruned = prune(layout(tree), (id) => id !== "dead")
  // The column had two panes; losing one collapses it into the row.
  expect(layoutAgents(pruned)).toEqual(["a", "c"])
  expect(pruned.root).toEqual(split("row", [pane("a"), pane("c")]))
})

test("pruning every pane leaves an empty layout rather than a husk", () => {
  const pruned = prune(layout(split("row", [pane("a"), pane("b")])), () => false)
  expect(pruned.root).toBeNull()
})

test("pruning clears a focus whose agent did not survive", () => {
  const pruned = prune(layout(split("row", [pane("a"), pane("b")]), "b"), (id) => id === "a")
  expect(pruned.focus).toBeUndefined()
})

test("pruning keeps a focus that did survive", () => {
  const pruned = prune(layout(split("row", [pane("a"), pane("b")]), "a"), (id) => id === "a")
  expect(pruned.focus).toBe("a")
})

// A focus naming a pane that is not in the tree would leave a rebuilt window
// with nothing focused, so it is dropped at the boundary rather than carried.
test("a focus not present in the tree is dropped on parse", () => {
  const parsed = parseLayout({ version: 1, root: pane("a"), focus: "ghost" })
  expect(parsed.focus).toBeUndefined()
})

test("an empty layout round-trips", () => {
  expect(decodeLayout(encodeLayout(layout(null)))).toEqual(layout(null))
})

test("a missing weight defaults to an even share", () => {
  const parsed = parseLayout({
    version: 1,
    root: { type: "split", direction: "row", children: [{ type: "pane", agent: "a" }] },
  })
  expect(parsed.root).toEqual(pane("a", 1))
})

test("malformed JSON is refused as a value, not thrown from deep in a rebuild", () => {
  expect(() => decodeLayout("{not json")).toThrow(LayoutFormatError)
})

test("an unsupported version is refused rather than guessed at", () => {
  expect(() => parseLayout({ version: 99, root: pane("a") })).toThrow(/unsupported layout version/)
})

test("a pane without an agent id is refused", () => {
  expect(() => parseLayout({ version: 1, root: { type: "pane", weight: 1 } })).toThrow(
    /needs an agent id/,
  )
})

test("a split without a valid direction is refused", () => {
  expect(() =>
    parseLayout({ version: 1, root: { type: "split", direction: "sideways", children: [pane("a")] } }),
  ).toThrow(/direction/)
})

test("a split with no children is refused", () => {
  expect(() =>
    parseLayout({ version: 1, root: { type: "split", direction: "row", children: [] } }),
  ).toThrow(/needs children/)
})

// A zero or negative weight renders as a pane with no cells, which reads as a
// pane that silently vanished.
test("a non-positive weight is refused", () => {
  expect(() => parseLayout({ version: 1, root: pane("a", 0) })).toThrow(/positive number/)
  expect(() => parseLayout({ version: 1, root: pane("a", -3) })).toThrow(/positive number/)
})

test("an unknown node type is refused", () => {
  expect(() => parseLayout({ version: 1, root: { type: "tabs", weight: 1 } })).toThrow(/unknown type/)
})

test("the error names where in the tree the problem is", () => {
  expect(() =>
    parseLayout({
      version: 1,
      root: { type: "split", direction: "row", children: [pane("a"), { type: "pane" }] },
    }),
  ).toThrow(/root\.children\[1\]/)
})

// Presets.

/** The tree's shape, ignoring weights — what a preset is actually choosing. */
const shape = (node: LayoutNode | null): unknown => {
  if (!node) return null
  if (node.type === "pane") return node.agent
  return { [node.direction]: node.children.map(shape) }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i))

test("even-horizontal is one row, even-vertical one column", () => {
  expect(shape(presetLayout(ids(3), "even-horizontal").root)).toEqual({ row: ["a", "b", "c"] })
  expect(shape(presetLayout(ids(3), "even-vertical").root)).toEqual({ column: ["a", "b", "c"] })
})

test("a main layout puts the first agent opposite the rest", () => {
  expect(shape(presetLayout(ids(4), "main-vertical").root)).toEqual({
    row: ["a", { column: ["b", "c", "d"] }],
  })
  expect(shape(presetLayout(ids(4), "main-horizontal").root)).toEqual({
    column: ["a", { row: ["b", "c", "d"] }],
  })
})

test("a main layout with a single other pane collapses to a plain split", () => {
  // Otherwise the rebuild would nest a one-child box the live tree never builds.
  expect(shape(presetLayout(ids(2), "main-vertical").root)).toEqual({ row: ["a", "b"] })
})

test("tiled grows as square as the count allows, filling row by row", () => {
  expect(shape(presetLayout(ids(1), "tiled").root)).toEqual("a")
  expect(shape(presetLayout(ids(2), "tiled").root)).toEqual({ row: ["a", "b"] })
  expect(shape(presetLayout(ids(4), "tiled").root)).toEqual({
    column: [{ row: ["a", "b"] }, { row: ["c", "d"] }],
  })
  // A short final row simply spreads across the width, as tmux's does.
  expect(shape(presetLayout(ids(5), "tiled").root)).toEqual({
    column: [{ row: ["a", "b", "c"] }, { row: ["d", "e"] }],
  })
})

test("every preset keeps the agents, in order, exactly once", () => {
  for (const preset of LAYOUT_PRESETS) {
    for (const n of [1, 2, 3, 5, 8]) {
      expect(layoutAgents(presetLayout(ids(n), preset))).toEqual(ids(n))
    }
  }
})

test("every preset alternates axes, so the live tree can rebuild it", () => {
  // Window.split only nests on an axis change; a same-axis nesting is a shape
  // that could be exported but never built, so no preset may emit one.
  const check = (node: LayoutNode, parent?: "row" | "column") => {
    if (node.type === "pane") return
    expect(node.direction).not.toBe(parent)
    for (const child of node.children) check(child, node.direction)
  }
  for (const preset of LAYOUT_PRESETS) {
    for (const n of [1, 2, 3, 4, 5, 9]) {
      const root = presetLayout(ids(n), preset).root
      if (root) check(root)
    }
  }
})

test("a preset keeps the focus when the agent is still there, drops it otherwise", () => {
  expect(presetLayout(ids(3), "tiled", "b").focus).toBe("b")
  expect(presetLayout(ids(3), "tiled", "zz").focus).toBeUndefined()
})

test("no agents is an empty layout, not a crash", () => {
  expect(presetLayout([], "tiled").root).toBeNull()
})

test("nextPreset walks the cycle and restarts from a hand-built layout", () => {
  expect(nextPreset(null)).toBe(LAYOUT_PRESETS[0])
  const seen = [nextPreset(null)]
  for (let i = 1; i < LAYOUT_PRESETS.length; i++) seen.push(nextPreset(seen[i - 1]!))
  expect(seen).toEqual([...LAYOUT_PRESETS])
  // And wraps.
  expect(nextPreset(LAYOUT_PRESETS[LAYOUT_PRESETS.length - 1]!)).toBe(LAYOUT_PRESETS[0])
})
