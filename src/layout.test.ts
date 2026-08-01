import { test, expect } from "bun:test"
import {
  LAYOUT_VERSION,
  LayoutFormatError,
  collapse,
  decodeLayout,
  encodeLayout,
  layoutAgents,
  layoutPanes,
  parseLayout,
  prune,
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
