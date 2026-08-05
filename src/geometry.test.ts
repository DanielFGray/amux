import { afterEach, expect, test } from "vitest";
import { computeRects, resizeDivider, resizePane } from "./geometry.ts";
import { createHarness, run } from "./harness.ts";
import { LAYOUT_VERSION, makeLayout, type Layout, type LayoutNode } from "./layout.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

const pane = (id: string, weight = 1): LayoutNode => ({ type: "pane", id, agent: id, weight });
const split = (direction: "row" | "column", children: LayoutNode[], weight = 1): LayoutNode => ({
  type: "split",
  direction,
  weight,
  children,
});
const layout = (root: LayoutNode, focus?: string): Layout => ({
  version: LAYOUT_VERSION,
  root,
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
    makeLayout(
      split("row", [
        { type: "pane", id: left.id, agent: left.agent.id, weight: 3 },
        split(
          "column",
          [
            { type: "pane", id: top.id, agent: top.agent.id, weight: 2 },
            { type: "pane", id: bottom.id, agent: bottom.agent.id, weight: 1 },
          ],
          5,
        ),
      ]),
    ),
  );
  await harness.layout();

  const expected = computeRects(window.exportLayout(), {
    cols: window.root.width,
    rows: window.root.height,
  });
  for (const pane of window.panes) {
    expect(expected.get(pane.id)).toEqual({
      x: pane.x - window.root.x,
      y: pane.y - window.root.y,
      width: pane.width,
      height: pane.height,
    });
  }
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
