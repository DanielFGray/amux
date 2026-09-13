import { expect, test } from "bun:test";
import {
  appendPane,
  closeLayout,
  LAYOUT_PRESETS,
  layoutPanes,
  makeLayout,
  presetLayout,
  splitLayout,
  swapLayout,
  type Layout,
  type LayoutNode,
  type PaneRef,
} from "./layout.ts";
import {
  paneHasNeighbour,
  paneInDirection,
  resizeDivider,
  resizePane,
  type LayoutSize,
} from "./geometry.ts";
import { defaultTilingMethods } from "./tiling-algorithm-default.ts";

const size: LayoutSize = { cols: 80, rows: 24 };

const pane = (id: string): PaneRef => ({
  id,
  content: { kind: "pty", session: id },
});

const node = (id: string, weight = 1): LayoutNode => ({
  type: "pane",
  ...pane(id),
  weight,
});

const layout = (root: LayoutNode, focus?: string): Layout => makeLayout({ root, focus });

test("init appends panes in the same order as the existing layout builder", () => {
  const panes = [pane("a"), pane("b"), pane("c")];
  let expected = makeLayout({ root: null });
  for (const ref of panes) {
    expected = appendPane(expected, ref);
  }

  const actual = defaultTilingMethods.init(panes, size);
  expect(actual).toEqual(expected);
});

test("delegates split, swap, and close without changing layout behavior", () => {
  const original = layout(
    {
      type: "split",
      direction: "row",
      weight: 1,
      children: [
        node("a"),
        { type: "split", direction: "column", weight: 2, children: [node("b"), node("c")] },
      ],
    },
    "b",
  );
  const added = pane("d");
  const split = defaultTilingMethods.split!(original, size, "b", "row", added);
  expect(split).toEqual(splitLayout(original, 1, "row", added));

  const swapped = defaultTilingMethods.swap!(split, size, "d", -1);
  const panes = layoutPanes(split.root);
  const index = panes.findIndex((candidate) => candidate.id === "d");
  expect(swapped).toEqual(swapLayout(split, index, (index - 1 + panes.length) % panes.length));

  expect(defaultTilingMethods.close!(swapped, size, "c")).toEqual(closeLayout(swapped, "c"));

  const onePane = closeLayout(
    layout({ type: "split", direction: "row", weight: 1, children: [node("x"), node("y")] }, "y"),
    "x",
  );
  expect(
    defaultTilingMethods.close!(
      layout({ type: "split", direction: "row", weight: 1, children: [node("x"), node("y")] }, "y"),
      size,
      "x",
    ),
  ).toEqual(onePane);
});

test("delegates presets while preserving the non-tiled planes", () => {
  const original = makeLayout({
    root: { type: "split", direction: "row", weight: 1, children: [node("a"), node("b")] },
    floats: [{ ...pane("float"), x: 0.1, y: 0.1, width: 0.4, height: 0.4 }],
    docks: { left: [pane("dock")], right: [], top: [], bottom: [] },
    dockSizes: { left: 30 },
    focus: "b",
  });
  for (const preset of LAYOUT_PRESETS) {
    const result = presetLayout(layoutPanes(original.root), preset, original.focus);
    const expected = makeLayout({
      ...result,
      floats: original.floats,
      docks: original.docks,
      dockSizes: original.dockSizes,
    });
    expect(defaultTilingMethods.applyPreset!(original, size, preset)).toEqual(expected);
  }
});

test("delegates focused and divider resizing", () => {
  const original = layout(
    { type: "split", direction: "row", weight: 1, children: [node("a"), node("b"), node("c")] },
    "b",
  );
  expect(defaultTilingMethods.resizeFocus!(original, size, "b", "right", 4)).toEqual(
    resizePane(original, size, "b", "right", 4),
  );
  expect(defaultTilingMethods.resizeDivider!(original, size, [], 1, -3)).toEqual(
    resizeDivider(original, size, [], 1, -3),
  );
});

test("delegates directional focus queries", () => {
  const original = layout(
    { type: "split", direction: "row", weight: 1, children: [node("a"), node("b")] },
    "a",
  );
  expect(defaultTilingMethods.focusInDirection(original, size, "a", "left")).toBe(
    paneInDirection(original, size, "a", "left"),
  );
  expect(defaultTilingMethods.focusInDirection(original, size, "a", "right")).toBe(
    paneInDirection(original, size, "a", "right"),
  );
  expect(paneHasNeighbour(original, "a", "row", 1)).toBe(true);
  expect(paneHasNeighbour(original, "a", "row", -1)).toBe(false);
});
