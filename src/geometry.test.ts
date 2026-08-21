import { afterEach, expect, test } from "bun:test";
import { computeRects, moveFloat, paneInDirection, resizeDivider, resizePane } from "./geometry.ts";
import { createHarness, run } from "./harness.ts";
import { LAYOUT_VERSION, makeLayout, type Layout, type LayoutNode } from "./layout.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

const pane = (id: string, weight = 1): LayoutNode => ({
  type: "pane",
  id,
  content: { kind: "pty", session: id },
  weight,
});
const split = (direction: "row" | "column", children: LayoutNode[], weight = 1): LayoutNode => ({
  type: "split",
  direction,
  weight,
  children,
});
const layout = (root: LayoutNode, focus?: string): Layout => ({
  version: LAYOUT_VERSION,
  root,
  floats: [],
  focus,
});

test("computeRects rounds cumulative boundaries and charges one cell per divider", () => {
  const rects = computeRects(layout(split("row", [pane("a", 2), pane("b"), pane("c")])), {
    cols: 13,
    rows: 7,
  });

  expect([...rects.values()]).toEqual([
    { x: 0, y: 0, width: 6, height: 7 },
    { x: 7, y: 0, width: 2, height: 7 },
    { x: 10, y: 0, width: 3, height: 7 },
  ]);
  expect([...rects.values()].reduce((sum, rect) => sum + rect.width, 0) + 2).toBe(13);
});

test("borders stay inside pane rectangles and nested axes use their parent's exact allocation", () => {
  const rects = computeRects(
    layout(split("row", [pane("left"), split("column", [pane("top"), pane("bottom", 2)], 2)])),
    { cols: 20, rows: 11 },
  );

  expect(rects.get("left")).toEqual({ x: 0, y: 0, width: 6, height: 11 });
  expect(rects.get("top")).toEqual({ x: 7, y: 0, width: 13, height: 3 });
  expect(rects.get("bottom")).toEqual({ x: 7, y: 4, width: 13, height: 7 });
  expect(computeRects(layout(pane("only")), { cols: 20, rows: 11 }).get("only")).toEqual({
    x: 0,
    y: 0,
    width: 20,
    height: 11,
  });
});

test("pure rectangles are a fixed point of OpenTUI flex layout", async () => {
  const harness = await createHarness({ width: 37, height: 17 });
  cleanup.push(harness.dispose);
  const { window } = harness;
  const left = window.panes[0]!;
  const top = run(window.splitSpawn("row"))!;
  const bottom = run(window.splitSpawn("column"))!;

  window.applyLayout(
    makeLayout({
      root: split("row", [
        {
          type: "pane",
          id: left.id,
          content: { kind: "pty", session: left.session!.id },
          weight: 3,
        },
        split(
          "column",
          [
            {
              type: "pane",
              id: top.id,
              content: { kind: "pty", session: top.session!.id },
              weight: 2,
            },
            {
              type: "pane",
              id: bottom.id,
              content: { kind: "pty", session: bottom.session!.id },
              weight: 1,
            },
          ],
          5,
        ),
      ]),
    }),
  );
  await harness.layout();

  const expected = computeRects(window.exportLayout(), {
    cols: window.root.width,
    rows: window.root.height,
  });
  expect(window.panes).toHaveLength(3);
  for (const pane of window.panes) {
    expect(expected.get(pane.id)).toEqual({
      x: pane.x - window.root.x,
      y: pane.y - window.root.y,
      width: pane.width,
      height: pane.height,
    });
  }
});

// The float's fractions and the percentages yoga is handed are the same
// numbers, so this is the test that they round to the same cells. Everything
// downstream of a rect — click routing, directional focus, the copy overlay —
// reads computeRects rather than the renderable, so a disagreement here would
// show up as a pane that is not where the model thinks it is.
test("a rendered float is the exact rectangle computeRects gives it", async () => {
  const harness = await createHarness({ width: 37, height: 17 });
  cleanup.push(harness.dispose);
  const { window } = harness;
  const tiled = window.panes[0]!;
  const floated = run(window.splitSpawn("row"))!;

  window.applyLayout(
    makeLayout({
      root: {
        type: "pane",
        id: tiled.id,
        content: { kind: "pty", session: tiled.session!.id },
        weight: 1,
      },
      floats: [
        {
          id: floated.id,
          content: { kind: "pty", session: floated.session!.id },
          x: 0.25,
          y: 0.1,
          width: 0.5,
          height: 0.75,
        },
      ],
      focus: floated.id,
    }),
  );
  await harness.layout();

  const expected = computeRects(window.exportLayout(), {
    cols: window.root.width,
    rows: window.root.height,
  });
  expect(expected.get(floated.id)).toEqual({
    x: floated.x - window.root.x,
    y: floated.y - window.root.y,
    width: floated.width,
    height: floated.height,
  });
  // The tiled pane still has the whole window: a float overlaps rather than
  // taking space, which is the entire difference between the two planes.
  expect(expected.get(tiled.id)).toEqual({
    x: 0,
    y: 0,
    width: window.root.width,
    height: window.root.height,
  });
  // Nothing draws a float's edges but the float, so it draws all four.
  expect(floated.edges).toEqual({ top: true, right: true, bottom: true, left: true });
});

// Panes are reused across rebuilds, so the absolute placement a float is given
// outlives the float unless the tiled path takes it back off. A pane still
// carrying it would be lifted straight out of the split it was just put into.
test("a pane that was floating is sized by the split again once tiled", async () => {
  const harness = await createHarness({ width: 40, height: 12 });
  cleanup.push(harness.dispose);
  const { window } = harness;
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  const both = window.exportLayout();

  window.applyLayout(
    makeLayout({
      root: {
        type: "pane",
        id: first.id,
        content: { kind: "pty", session: first.session!.id },
        weight: 1,
      },
      floats: [
        {
          id: second.id,
          content: { kind: "pty", session: second.session!.id },
          x: 0.25,
          y: 0.25,
          width: 0.5,
          height: 0.5,
        },
      ],
    }),
  );
  await harness.layout();
  window.applyLayout(both);
  await harness.layout();

  const rects = computeRects(window.exportLayout(), {
    cols: window.root.width,
    rows: window.root.height,
  });
  expect(window.panes).toHaveLength(2);
  for (const pane of window.panes) {
    expect(rects.get(pane.id)).toEqual({
      x: pane.x - window.root.x,
      y: pane.y - window.root.y,
      width: pane.width,
      height: pane.height,
    });
  }
  // Side by side, sharing the window between them rather than one of them
  // still hovering at a quarter of it.
  expect(first.width + second.width).toBe(window.root.width - 1);
});

// "The pane to the right" means the one across a shared edge. A float shares no
// edge with what it covers, so there is no direction between the planes.
test("directional focus neither enters the floating plane nor leaves it", () => {
  const size = { cols: 30, rows: 10 };
  const current: Layout = {
    version: LAYOUT_VERSION,
    root: split("row", [pane("a"), pane("b")]),
    floats: [{ id: "f", content: { kind: "pty", session: "f" }, x: 0, y: 0, width: 1, height: 1 }],
    focus: "f",
  };
  // The float covers everything, so a rect-only rule would make it every
  // pane's nearest neighbour in every direction.
  expect(paneInDirection(current, size, "a", "right")).toBe("b");
  expect(paneInDirection(current, size, "b", "left")).toBe("a");
  expect(paneInDirection(current, size, "f", "left")).toBeNull();
  expect(paneInDirection(current, size, "f", "right")).toBeNull();
});

test("resize rewrites the model, preserves other siblings, and stops at three cells", () => {
  const size = { cols: 30, rows: 10 };
  let current = layout(split("row", [pane("a"), pane("b"), pane("c")]), "b");
  const before = computeRects(current, size);
  current = resizeDivider(current, size, [], 0, 2);
  const moved = computeRects(current, size);

  expect(moved.get("a")!.width).toBe(before.get("a")!.width + 2);
  expect(moved.get("b")!.width).toBe(before.get("b")!.width - 2);
  expect(moved.get("c")).toEqual(before.get("c"));

  for (let i = 0; i < 100; i++) current = resizePane(current, size, "a", "right");
  expect(computeRects(current, size).get("b")!.width).toBe(3);
  expect(current.focus).toBe("b");
});

const size = { cols: 40, rows: 20 };
const floatLayout = (x: number, y: number, width: number, height: number): Layout => ({
  version: LAYOUT_VERSION,
  root: split("row", [pane("a"), pane("b")]),
  floats: [{ id: "f", content: { kind: "pty", session: "f" }, x, y, width, height }],
  focus: "f",
});
// The float's rect at {cols:40, rows:20}: x=10, y=2, right=30, bottom=17.
const floatRect = floatLayout(0.25, 0.1, 0.5, 0.75);

test("resizePane grows a float right and down, keeping the origin fixed", () => {
  const grown = resizePane(floatRect, size, "f", "right");
  expect(computeRects(grown, size).get("f")).toEqual({ x: 10, y: 2, width: 21, height: 15 });

  const lowered = resizePane(floatRect, size, "f", "down");
  expect(computeRects(lowered, size).get("f")).toEqual({ x: 10, y: 2, width: 20, height: 16 });
});

test("resizePane shrinks a float left and up, keeping the far edge fixed", () => {
  const shrunk = resizePane(floatRect, size, "f", "left");
  expect(computeRects(shrunk, size).get("f")).toEqual({ x: 11, y: 2, width: 19, height: 15 });

  const raised = resizePane(floatRect, size, "f", "up");
  expect(computeRects(raised, size).get("f")).toEqual({ x: 10, y: 3, width: 20, height: 14 });
});

test("a float stops growing at the window edge and shrinking at the minimum", () => {
  const atRight = floatLayout(0.9, 0.1, 0.1, 0.5);
  const rightEdge = resizePane(atRight, size, "f", "right");
  expect(rightEdge).toBe(atRight); // already flush against the window's right edge

  let squeezed = floatRect;
  for (let i = 0; i < 100; i++) squeezed = resizePane(squeezed, size, "f", "left");
  expect(computeRects(squeezed, size).get("f")!.width).toBe(3); // MIN_CELLS
  const floor = resizePane(squeezed, size, "f", "left");
  expect(floor).toBe(squeezed);
});

test("moveFloat slides a float one cell per press in the direction of the arrow", () => {
  expect(computeRects(moveFloat(floatRect, size, "f", "right"), size).get("f")).toEqual({
    x: 11,
    y: 2,
    width: 20,
    height: 15,
  });
  expect(computeRects(moveFloat(floatRect, size, "f", "left"), size).get("f")).toEqual({
    x: 9,
    y: 2,
    width: 20,
    height: 15,
  });
  expect(computeRects(moveFloat(floatRect, size, "f", "up"), size).get("f")).toEqual({
    x: 10,
    y: 1,
    width: 20,
    height: 15,
  });
  expect(computeRects(moveFloat(floatRect, size, "f", "down"), size).get("f")).toEqual({
    x: 10,
    y: 3,
    width: 20,
    height: 15,
  });
});

test("a float cannot be pushed off the window, either edge", () => {
  let current = floatLayout(0.25, 0.1, 0.5, 0.75);
  for (let i = 0; i < 100; i++) current = moveFloat(current, size, "f", "right");
  // Flush against the right edge (x + width lands on the last column) and
  // still its original size: movement never resizes.
  expect(computeRects(current, size).get("f")).toEqual({ x: 20, y: 2, width: 20, height: 15 });
  const stuck = moveFloat(current, size, "f", "right");
  expect(stuck).toBe(current);

  current = floatLayout(0.25, 0.1, 0.5, 0.75);
  for (let i = 0; i < 100; i++) current = moveFloat(current, size, "f", "left");
  expect(computeRects(current, size).get("f")!.x).toBe(0);
  const stuckLeft = moveFloat(current, size, "f", "left");
  expect(stuckLeft).toBe(current);
});

test("moving and resizing a float leaves a tiled pane and a sibling float alone", () => {
  const stacked: Layout = {
    version: LAYOUT_VERSION,
    root: split("row", [pane("a"), pane("b")]),
    floats: [
      {
        id: "f",
        content: { kind: "pty", session: "f" },
        x: 0.25,
        y: 0.1,
        width: 0.5,
        height: 0.75,
      },
      { id: "g", content: { kind: "pty", session: "g" }, x: 0.6, y: 0.6, width: 0.3, height: 0.3 },
    ],
    focus: "f",
  };
  const moved = moveFloat(stacked, size, "f", "right");
  expect(moved.floats.map((float) => float.id)).toEqual(["f", "g"]);
  expect(moved.floats[1]).toBe(stacked.floats[1]);

  const resized = resizePane(stacked, size, "f", "right");
  expect(resized.floats[1]).toBe(stacked.floats[1]);
  expect(resizePane(stacked, size, "a", "right")).not.toBe(stacked);

  // A pane the layout does not float is not moved by moveFloat.
  expect(moveFloat(stacked, size, "a", "left")).toBe(stacked);
  expect(moveFloat(stacked, size, "ghost", "left")).toBe(stacked);
});

test("dock geometry reserves corners in the documented order", () => {
  const ref = (id: string) => ({ id, content: { kind: "pty" as const, session: id } });
  const current = makeLayout({
    root: pane("centre"),
    docks: {
      left: [ref("left")],
      right: [ref("right")],
      top: [ref("top")],
      bottom: [ref("bottom")],
    },
  });
  const rects = computeRects(current, { cols: 100, rows: 50 });
  expect(rects.get("left")).toEqual({ x: 0, y: 12, width: 40, height: 26 });
  expect(rects.get("right")).toEqual({ x: 60, y: 12, width: 40, height: 26 });
  expect(rects.get("top")).toEqual({ x: 40, y: 0, width: 20, height: 12 });
  expect(rects.get("bottom")).toEqual({ x: 0, y: 38, width: 100, height: 12 });
  expect(rects.get("centre")).toEqual({ x: 40, y: 12, width: 20, height: 26 });
});

test("dock resize changes its fixed strip without touching the tiled tree", () => {
  const current = makeLayout({
    root: pane("centre"),
    docks: {
      left: [{ id: "left", content: { kind: "pty", session: "left" } }],
      right: [],
      top: [],
      bottom: [],
    },
  });
  const resized = resizePane(current, { cols: 100, rows: 50 }, "left", "left");
  expect(resized.dockSizes?.left).toBe(41);
  expect(computeRects(resized, { cols: 100, rows: 50 }).get("centre")).toEqual({
    x: 41,
    y: 0,
    width: 59,
    height: 50,
  });
});

test("window projection keeps the geometry gap between same-side dock panes", async () => {
  const harness = await createHarness({ width: 40, height: 20 });
  cleanup.push(harness.dispose);
  const { window } = harness;
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  window.applyLayout(
    makeLayout({
      root: null,
      docks: {
        left: [
          { id: first.id, content: { kind: "pty", session: first.session!.id } },
          { id: second.id, content: { kind: "pty", session: second.session!.id } },
        ],
        right: [],
        top: [],
        bottom: [],
      },
    }),
  );
  await harness.layout();
  expect(second.y - first.y).toBeGreaterThan(first.height);
  expect(second.y).toBe(first.y + first.height + 1);
});

test("window projection clamps a dock to half a narrow viewport", async () => {
  const harness = await createHarness({ width: 40, height: 20 });
  cleanup.push(harness.dispose);
  const { window } = harness;
  const pane = window.panes[0]!;
  window.applyLayout(
    makeLayout({
      root: null,
      docks: {
        left: [{ id: pane.id, content: { kind: "pty", session: pane.session!.id } }],
        right: [],
        top: [],
        bottom: [],
      },
    }),
  );
  await harness.layout();

  expect(computeRects(window.exportLayout(), { cols: 40, rows: 20 }).get(pane.id)).toEqual({
    x: 0,
    y: 0,
    width: pane.width,
    height: pane.height,
  });
});

test("window projection places a top dock between side docks", async () => {
  const harness = await createHarness({ width: 100, height: 50 });
  cleanup.push(harness.dispose);
  const { window } = harness;
  const left = window.panes[0]!;
  const top = run(window.splitSpawn("row"))!;
  window.applyLayout(
    makeLayout({
      root: null,
      docks: {
        left: [{ id: left.id, content: { kind: "pty", session: left.session!.id } }],
        right: [],
        top: [{ id: top.id, content: { kind: "pty", session: top.session!.id } }],
        bottom: [],
      },
    }),
  );
  await harness.layout();

  const expected = computeRects(window.exportLayout(), { cols: 100, rows: 50 });
  expect(expected.get(top.id)).toEqual({ x: top.x, y: top.y, width: top.width, height: top.height });
});
