import { expect, test } from "bun:test";
import {
  collapse,
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
  // (80 - 1 gap) / 2 = 39, so two columns + gutter fit the viewport exactly.
  expect(root.arrangement.sizes).toEqual([39, 39, 39]);
  expect(root.children.map((child) => layoutPanes(child).map((leaf) => leaf.id))).toEqual([
    ["a"],
    ["b"],
    ["c"],
  ]);
  expect(layout.focus).toBe("a");
});

test("init of a sole pane fills the viewport instead of opening at half width", () => {
  const layout = niriTilingAlgorithm.init([pane("solo")], size);
  expect(scrollOf(layout).arrangement.sizes).toEqual([80]);
});

test("closing down to one column expands it to fill the viewport", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b")], size);
  expect(scrollOf(layout).arrangement.sizes[0]).toBe(39);
  const closed = niriTilingAlgorithm.close(layout, size, "b");
  expect(scrollOf(closed).arrangement.sizes).toEqual([80]);
  expect(layoutPanes(closed.root).map((leaf) => leaf.id)).toEqual(["a"]);
});

test("ensureVisible expands a leftover half-width sole column to the viewport", () => {
  // Simulate a saved strip that still has the half-width default for one column.
  const leftover = makeLayout({
    root: {
      type: "container",
      kind: "scroll",
      weight: 1,
      arrangement: { offset: 0, sizes: [39], active: ["a"], basisCols: 80 },
      children: [{ type: "pane", ...pane("a"), weight: 1 }],
    },
    focus: "a",
  });
  const shown = niriTilingAlgorithm.ensureVisible!(leftover, size, "a");
  expect(scrollOf(shown).arrangement.sizes).toEqual([80]);
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
  expect(root.arrangement.sizes).toEqual([39, 39]);
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

test("left/right restore each column's last-focused pane", () => {
  const single = niriTilingAlgorithm.init([pane("a"), pane("b")], size);
  const stacked = niriColumns.insertIntoColumn(
    niriColumns.insertIntoColumn(single, size, "b", pane("b2")),
    size,
    "b",
    pane("b0"),
    "before",
  );
  // Focus b2 inside column b, then stamp it via ensureVisible.
  const onB2 = niriTilingAlgorithm.ensureVisible!(
    makeLayout({ ...stacked, focus: "b2" }),
    size,
    "b2",
  );
  expect(scrollOf(onB2).arrangement.active[1]).toBe("b2");

  // Leave to column a and come back — land on b2, not the row-matched b0.
  const toA = niriTilingAlgorithm.focusInDirection(onB2, size, "b2", "left");
  expect(toA).toBe("a");
  const back = niriTilingAlgorithm.focusInDirection(onB2, size, "a", "right");
  expect(back).toBe("b2");
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

test("closing a whole column focuses the previous column's active pane", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);
  const closed = niriTilingAlgorithm.close(makeLayout({ ...layout, focus: "b" }), size, "b");
  expect(layoutPanes(scrollOf(closed).children[0]!).map((p) => p.id)).toEqual(["a"]);
  expect(layoutPanes(scrollOf(closed).children[1]!).map((p) => p.id)).toEqual(["c"]);
  expect(closed.focus).toBe("a");
});

test("moving focus to an offscreen column scrolls it into view preferring less motion", () => {
  // Three 39-cell columns with 1-cell gaps in an 80-cell viewport:
  // starts at 0, 40, 80 — [a][b] fit exactly, [c] off right.
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);

  const target = niriTilingAlgorithm.focusInDirection(layout, size, "b", "right");
  expect(target).toBe("c");
  // focusInDirection is a pure query: the input layout is untouched.
  expect(scrollOf(layout).arrangement.offset).toBe(0);
  // Column c spans [80, 119); right-align with padding wants 40, clamped to
  // contentWidth-viewport = 39 (strip ends at 119).
  const shown = niriTilingAlgorithm.ensureVisible!(layout, size, target!);
  expect(scrollOf(shown).arrangement.offset).toBe(39);

  // Column b spans [40, 79) — fully inside [39, 119) with padding — so coming
  // back keeps the offset (and stamps b as column 1's active).
  const back = niriTilingAlgorithm.focusInDirection(shown, size, "c", "left");
  expect(back).toBe("b");
  const returned = niriTilingAlgorithm.ensureVisible!(shown, size, back!);
  expect(scrollOf(returned).arrangement.offset).toBe(39);
});

test("a partially visible target scrolls just enough, a visible one not at all", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);
  // Column c spans [80, 119); the viewport moves from [0, 80) to [39, 119).
  const shifted = niriColumns.scrollIntoView(layout, size, "c");
  expect(scrollOf(shifted).arrangement.offset).toBe(39);

  // Column c is already fully visible in [39, 119).
  expect(niriTilingAlgorithm.ensureVisible!(shifted, size, "c")).toBe(shifted);

  // A partially visible target: offset 10 shows [10, 90), so column c hangs
  // off the right and the viewport right-aligns (clamped) to [39, 119).
  const shiftedRoot = scrollOf(shifted);
  const partial = makeLayout({
    ...shifted,
    root: { ...shiftedRoot, arrangement: { ...shiftedRoot.arrangement, offset: 10 } },
  });
  const eased = niriTilingAlgorithm.ensureVisible!(partial, size, "c");
  expect(scrollOf(eased).arrangement.offset).toBe(39);

  // Column a spans [0, 39); the viewport is [39, 119): shift back to 0.
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
  expect(scrollOf(wider).arrangement.sizes[0]).toBe(44);
  expect(scrollOf(wider).arrangement.sizes[1]).toBe(39);

  const narrower = niriTilingAlgorithm.resizeFocus!(wider, size, "a", "left", 5);
  expect(scrollOf(narrower).arrangement.sizes[0]).toBe(39);

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
  expect(niriTilingAlgorithm.hasNeighbour).toBeDefined();
  expect(niriTilingAlgorithm.resizeDivider).toBeDefined();
  for (const omitted of ["swap", "applyPreset"] as const) {
    expect(omitted in niriTilingAlgorithm).toBe(false);
  }
});

test("resizeDivider transfers cells between adjacent columns", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);
  const width = niriColumns.defaultColumnWidth(size);
  expect(scrollOf(layout).arrangement.sizes).toEqual([width, width, width]);
  const moved = niriTilingAlgorithm.resizeDivider!(layout, size, [], 0, 5);
  expect(scrollOf(moved).arrangement.sizes).toEqual([width + 5, width - 5, width]);
  // Floor: cannot shrink a column below MIN_COLUMN_WIDTH.
  const clamped = niriTilingAlgorithm.resizeDivider!(moved, size, [], 0, -100);
  expect(scrollOf(clamped).arrangement.sizes[0]).toBe(20);
  expect(scrollOf(clamped).arrangement.sizes[1]).toBe(2 * width - 20);
});

test("resizeDivider inside a stacked column steals weight between panes", () => {
  const layout = niriTilingAlgorithm.init([pane("a")], size);
  const stacked = niriTilingAlgorithm.split!(layout, size, "a", "column", pane("a2"));
  const moved = niriTilingAlgorithm.resizeDivider!(stacked, size, [0], 0, 4);
  const column = scrollOf(moved).children[0]!;
  expect(column.type).toBe("split");
  if (column.type !== "split") return;
  expect(column.children[0]!.weight).toBeGreaterThan(column.children[1]!.weight);
  // Deeper paths are not a niri seam.
  expect(niriTilingAlgorithm.resizeDivider!(stacked, size, [0, 0], 0, 1)).toBe(stacked);
});

test("a single-column scroll root survives collapse instead of becoming a bare stack", () => {
  const layout = niriTilingAlgorithm.init([pane("a")], size);
  const stacked = niriTilingAlgorithm.split!(layout, size, "a", "column", pane("a2"));
  expect(scrollOf(stacked).children).toHaveLength(1);
  // collapse used to unwrap the container to a bare column split — the
  // reattach "rows instead of columns" bug (encode/decode both collapse).
  const kept = collapse(stacked.root);
  expect(kept?.type).toBe("container");
  expect(kept && kept.type === "container" ? kept.kind : undefined).toBe("scroll");
});

test("resizeDivider does not rescale columns when basisCols disagrees with size.cols", () => {
  // Mid-drag size.cols flicker used to adaptViewport first (rubber band).
  const wide = { cols: 81, rows: 24 };
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b")], wide);
  expect(scrollOf(layout).arrangement.sizes).toEqual([40, 40]);
  const narrow = { cols: 61, rows: 24 };
  const moved = niriTilingAlgorithm.resizeDivider!(layout, narrow, [], 0, 5);
  expect(scrollOf(moved).arrangement.sizes).toEqual([45, 35]);
  expect(scrollOf(moved).arrangement.basisCols).toBe(61);
});

test("hasNeighbour sees adjacent columns and stack rows, not outer edges", () => {
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b"), pane("c")], size);
  expect(niriTilingAlgorithm.hasNeighbour!(layout, size, "a", "row", -1)).toBe(false);
  expect(niriTilingAlgorithm.hasNeighbour!(layout, size, "a", "row", 1)).toBe(true);
  expect(niriTilingAlgorithm.hasNeighbour!(layout, size, "b", "row", -1)).toBe(true);
  expect(niriTilingAlgorithm.hasNeighbour!(layout, size, "c", "row", 1)).toBe(false);

  const stacked = niriTilingAlgorithm.split!(layout, size, "a", "column", pane("a2"));
  expect(niriTilingAlgorithm.hasNeighbour!(stacked, size, "a", "column", 1)).toBe(true);
  expect(niriTilingAlgorithm.hasNeighbour!(stacked, size, "a2", "column", -1)).toBe(true);
  expect(niriTilingAlgorithm.hasNeighbour!(stacked, size, "a", "column", -1)).toBe(false);
});

test("ensureVisible rescales column widths when the viewport shrinks", () => {
  const wide = { cols: 81, rows: 24 };
  const layout = niriTilingAlgorithm.init([pane("a"), pane("b")], wide);
  expect(scrollOf(layout).arrangement.sizes).toEqual([40, 40]);
  expect(scrollOf(layout).arrangement.basisCols).toBe(81);

  const narrow = { cols: 61, rows: 24 };
  const adapted = niriTilingAlgorithm.ensureVisible!(layout, narrow, "a");
  const sizes = scrollOf(adapted).arrangement.sizes;
  // Two columns + gap must fit the new viewport: 30+1+30 = 61.
  expect(sizes[0]! + 1 + sizes[1]!).toBeLessThanOrEqual(61);
  expect(scrollOf(adapted).arrangement.basisCols).toBe(61);
  // A second call at the same size is a no-op (reference-equal after stamp).
  expect(niriTilingAlgorithm.ensureVisible!(adapted, narrow, "a")).toBe(adapted);
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
