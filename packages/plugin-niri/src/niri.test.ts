import { expect, test } from "bun:test";
import {
  layoutPanes,
  makeLayout,
  type Layout,
  type LayoutContainer,
  type LayoutSize,
  type PaneRef,
} from "@danielfgray/amux";
import { niriColumns, niriTilingAlgorithm, type NiriArrangement } from "./niri.ts";

const size: LayoutSize = { cols: 80, rows: 24 };

const pane = (id: string): PaneRef => ({
  id,
  content: { kind: "pty", session: id },
});

const scrollOf = (layout: Layout): LayoutContainer & { arrangement: NiriArrangement } => {
  const root = layout.root;
  if (!root || root.type !== "container" || root.kind !== "scroll") {
    throw new Error("expected a scroll root");
  }
  return root as LayoutContainer & { arrangement: NiriArrangement };
};

test("init opens one column per pane at half the viewport", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);

  const root = scrollOf(layout);
  expect(root.arrangement.offset).toBe(0);
  expect(root.arrangement.sizes).toEqual([40, 40, 40]);
  expect(root.children.map((child) => layoutPanes(child).map((leaf) => leaf.id))).toEqual([
    ["a"],
    ["b"],
    ["c"],
  ]);
  expect(layout.focus).toBe("a");
});

test("init of no panes is the empty layout", () => {
  expect(niriTilingAlgorithm.init([], size).root).toBeNull();
});

test("closing the only pane in a column removes the column", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);

  const closed = niriTilingAlgorithm.close(layout, size, "b");
  const root = scrollOf(closed);
  expect(root.children.map((child) => layoutPanes(child).map((leaf) => leaf.id))).toEqual([
    ["a"],
    ["c"],
  ]);
  // Column widths are intrinsic: survivors keep theirs, they do not stretch.
  expect(root.arrangement.sizes).toEqual([40, 40]);
});

test("closing a pane in a multi-pane column keeps the column", () => {
  const single = niriTilingAlgorithm.init([pane("a"), pane("b")], size);
  const stacked = niriColumns.insertIntoColumn(single, size, "a", pane("a2"));

  const closed = niriTilingAlgorithm.close(stacked, size, "a");
  const root = scrollOf(closed);
  expect(root.children).toHaveLength(2);
  expect(layoutPanes(root.children[0]!).map((leaf) => leaf.id)).toEqual(["a2"]);
  // A column drained to one pane collapses to the pane itself.
  expect(root.children[0]!.type).toBe("pane");
});

test("closing the last pane empties the layout and hands focus to a survivor", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b")], size);
  const focused = makeLayout({ ...layout, focus: "b" });

  const one = niriTilingAlgorithm.close(focused, size, "b");
  expect(layoutPanes(one.root).map((leaf) => leaf.id)).toEqual(["a"]);
  expect(one.focus).toBe("a");

  const none = niriTilingAlgorithm.close(one, size, "a");
  expect(none.root).toBeNull();
});

test("left/right cross columns, up/down walk the column stack", () => {
  const single = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);
  const stacked = niriColumns.insertIntoColumn(
    niriColumns.insertIntoColumn(single, size, "b", pane("b2")),
    size,
    "b",
    pane("b0"),
    "before",
  );
  // Column b now stacks b0, b, b2 top to bottom.
  expect(layoutPanes(scrollOf(stacked).children[1]!).map((leaf) => leaf.id)).toEqual([
    "b0",
    "b",
    "b2",
  ]);

  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "b", "left")).toBe("a");
  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "b", "right")).toBe("c");
  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "b", "up")).toBe("b0");
  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "b", "down")).toBe("b2");
  // Same row position is held across columns: b2 is row 2, column c has one
  // pane, so the fallback is that column's first pane.
  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "b2", "right")).toBe("c");
});

test("directional focus returns null at the edges", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b")], size);
  const stacked = niriColumns.insertIntoColumn(layout, size, "a", pane("a2"));

  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "a", "left")).toBeNull();
  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "b", "right")).toBeNull();
  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "a", "up")).toBeNull();
  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "a2", "down")).toBeNull();
  expect(niriTilingAlgorithm.focusInDirection(stacked, size, "nope", "right")).toBeNull();
});

test("moving focus to an offscreen column scrolls it into view by the minimum", () => {
  // Three 40-cell columns in an 80-cell viewport: [a][b] visible, [c] off right.
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);

  const target = niriTilingAlgorithm.focusInDirection(layout, size, "b", "right");
  expect(target).toBe("c");
  // focusInDirection is a pure query: the input layout is untouched.
  expect(scrollOf(layout).arrangement.offset).toBe(0);
  // Column c spans [80, 120); the viewport was [0, 80): shift to [40, 120).
  const shown = niriTilingAlgorithm.ensureVisible!(layout, size, target!);
  expect(scrollOf(shown).arrangement.offset).toBe(40);

  // Column b spans [40, 80) — fully inside [40, 120) — so coming back moves nothing.
  const back = niriTilingAlgorithm.focusInDirection(shown, size, "c", "left");
  expect(back).toBe("b");
  expect(niriTilingAlgorithm.ensureVisible!(shown, size, back!)).toBe(shown);
});

test("a partially visible target scrolls just enough, a visible one not at all", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);
  // Column c spans [80, 120); the viewport moves from [0, 80) to [40, 120).
  const shifted = niriColumns.scrollIntoView(layout, size, "c");
  expect(scrollOf(shifted).arrangement.offset).toBe(40);

  // Column c spans [80, 120); the viewport is [40, 120): already visible.
  expect(niriTilingAlgorithm.ensureVisible!(shifted, size, "c")).toBe(shifted);

  // A partially visible target scrolls just enough: offset 10 shows [10, 90),
  // so column c hangs 30 cells off the right and the viewport shifts to [40, 120).
  const shiftedRoot = scrollOf(shifted);
  const partial = makeLayout({
    ...shifted,
    root: { ...shiftedRoot, arrangement: { ...shiftedRoot.arrangement, offset: 10 } },
  });
  const eased = niriTilingAlgorithm.ensureVisible!(partial, size, "c");
  expect(scrollOf(eased).arrangement.offset).toBe(40);

  // Column a spans [0, 40); the viewport is [40, 120): shift to [0, 80).
  const first = niriTilingAlgorithm.ensureVisible!(shifted, size, "a");
  expect(scrollOf(first).arrangement.offset).toBe(0);
});

test("ensureVisible hands back the same Layout when nothing moves", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b")], size);
  // Both columns fit the viewport: every pane is already visible.
  expect(niriTilingAlgorithm.ensureVisible!(layout, size, "a")).toBe(layout);
  expect(niriTilingAlgorithm.ensureVisible!(layout, size, "b")).toBe(layout);
  // Unknown panes and foreign shapes are no-ops, not errors.
  expect(niriTilingAlgorithm.ensureVisible!(layout, size, "nope")).toBe(layout);
  expect(niriTilingAlgorithm.ensureVisible!(makeLayout({ root: null }), size, "a").root).toBeNull();
});

test("resizeFocus widens and narrows the focused column", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b")], size);

  const wider = niriTilingAlgorithm.resizeFocus!(layout, size, "a", "right", 5);
  expect(scrollOf(wider).arrangement.sizes[0]).toBe(45);
  expect(scrollOf(wider).arrangement.sizes[1]).toBe(40);

  const narrower = niriTilingAlgorithm.resizeFocus!(wider, size, "a", "left", 5);
  expect(scrollOf(narrower).arrangement.sizes[0]).toBe(40);

  // Shrinking below a usable terminal width is refused, not clamped.
  expect(niriTilingAlgorithm.resizeFocus!(layout, size, "a", "left", 1000)).toBe(layout);
  expect(niriTilingAlgorithm.resizeFocus!(layout, size, "nope", "right", 5)).toBe(layout);
});

test("resizeFocus up/down shares the column's rows between neighbours", () => {
  const single = niriTilingAlgorithm.init([pane("a")], size);
  const stacked = niriColumns.insertIntoColumn(single, size, "a", pane("a2"));
  // Two even panes in 24 rows: one divider cell, 23 split two ways.

  const grown = niriTilingAlgorithm.resizeFocus!(stacked, size, "a", "down", 2);
  const column = scrollOf(grown).children[0]!;
  if (column.type !== "split") throw new Error("expected a column split");
  expect(column.children.map((child) => child.weight)).toEqual([13.5, 9.5]);

  // At the edge there is no neighbour to take from: refused.
  expect(niriTilingAlgorithm.resizeFocus!(stacked, size, "a", "up", 2)).toBe(stacked);
  // A lone pane has no stack to resize within: refused.
  const lone = niriTilingAlgorithm.init([pane("solo")], size);
  expect(niriTilingAlgorithm.resizeFocus!(lone, size, "solo", "down", 2)).toBe(lone);
});

test("the algorithm carries only the vocabulary the interface declares", () => {
  expect(niriTilingAlgorithm.resizeFocus).toBeDefined();
  expect(niriTilingAlgorithm.ensureVisible).toBeDefined();
  expect(niriTilingAlgorithm.split).toBeDefined();
  for (const omitted of ["swap", "applyPreset", "resizeDivider", "hasNeighbour"] as const) {
    expect(omitted in niriTilingAlgorithm).toBe(false);
  }
});

test("split 'column' on a layout not yet in niri's own scroll shape stacks the pane rather than dropping it", () => {
  // A window elected onto niri mid-session (or freshly built by another
  // algorithm) still has its old tree shape the moment niri.split runs.
  // insertIntoColumn used to bail out silently here, leaving the caller's
  // freshly created pane out of the tree entirely.
  const foreign: Layout = makeLayout({
    root: {
      type: "split",
      direction: "row",
      weight: 1,
      children: [
        { type: "pane", ...pane("a"), weight: 1 },
        { type: "pane", ...pane("b"), weight: 1 },
      ],
    },
    focus: "a",
  });

  const result = niriTilingAlgorithm.split!(foreign, size, "a", "column", pane("a2"));

  const root = scrollOf(result);
  expect(root.children).toHaveLength(2);
  expect(layoutPanes(root.children[0]!).map((p) => p.id)).toEqual(["a", "a2"]);
  expect(layoutPanes(root.children[1]!).map((p) => p.id)).toEqual(["b"]);
  expect(result.focus).toBe("a2");
});

test("split 'column' targeting an id absent from a foreign layout is refused, not a crash", () => {
  const foreign: Layout = makeLayout({
    root: { type: "pane", ...pane("a"), weight: 1 },
    focus: "a",
  });

  const result = niriTilingAlgorithm.split!(foreign, size, "nonexistent", "column", pane("a2"));
  expect(result).toBe(foreign);
});

test("split with direction 'row' inserts a new column beside the focused pane", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b")], size);
  const result = niriTilingAlgorithm.split!(layout, size, "b", "row", pane("c"));

  const root = scrollOf(result);
  // Should have three columns now (a, b, c)
  expect(root.children).toHaveLength(3);
  expect(layoutPanes(root.children[0]!).map((p) => p.id)).toEqual(["a"]);
  expect(layoutPanes(root.children[1]!).map((p) => p.id)).toEqual(["b"]);
  expect(layoutPanes(root.children[2]!).map((p) => p.id)).toEqual(["c"]);
  // New pane should become focused
  expect(result.focus).toBe("c");
});

test("split with direction 'column' inserts into the focused column's stack", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b")], size);
  const result = niriTilingAlgorithm.split!(layout, size, "b", "column", pane("c"));

  const root = scrollOf(result);
  // Should still have two columns (a and b)
  expect(root.children).toHaveLength(2);
  // First column unchanged
  expect(layoutPanes(root.children[0]!).map((p) => p.id)).toEqual(["a"]);
  // Second column now has b and c stacked
  const bColumn = root.children[1]!;
  expect(bColumn.type).toBe("split");
  if (bColumn.type !== "split") throw new Error("expected split");
  // Get all pane IDs from the split's children
  const bPanes = bColumn.children.filter((child) => child.type === "pane").map((p) => p.id);
  expect(bPanes).toEqual(["b", "c"]);
  // New pane should be focused
  expect(result.focus).toBe("c");
});

test("split on empty layout creates a single-column layout", () => {
  const layout = niriTilingAlgorithm.init([], size);
  const result = niriTilingAlgorithm.split!(layout, size, "nonexistent", "row", pane("a"));

  // insertColumn on null root builds a single-column scroll layout with the new pane
  const root = scrollOf(result);
  expect(root.children).toHaveLength(1);
  expect(layoutPanes(root.children[0]!).map((p) => p.id)).toEqual(["a"]);
  expect(result.focus).toBe("a");
});
