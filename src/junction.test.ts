import { test, expect, afterEach } from "vitest";
import { createHarness, run } from "./harness.ts";
import type { Window } from "./window.ts";
import { Divider } from "./divider.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup() {
  const harness = await createHarness({ width: 40, height: 12 });
  cleanup.push(harness.dispose);
  return harness;
}

/** The column of the frame's vertical seam — where its ┬ sits on the top border. */
function dividerColumn(rows: string[]): number {
  const col = rows[0]!.indexOf("┬");
  expect(col).toBeGreaterThan(0);
  return col;
}

/** Split both halves of a row split vertically at the same height, so the two
 *  horizontal seams land on the same row and both meet the vertical seam —
 *  the cell where the three lines converge wants a ┼. */
function cross(win: Window) {
  run(win.splitSpawn("row"));
  const left = win.panes[0]!;
  const right = win.panes[1]!;
  win.focus(left);
  run(win.splitSpawn("column"));
  win.focus(right);
  run(win.splitSpawn("column"));
}

test("two aligned horizontal seams meeting the vertical seam draw a ┼", async () => {
  const { window, layout, t } = await setup();
  cross(window);
  await layout();
  await t.renderOnce();

  const rows = t.captureCharFrame().split("\n");
  const col = dividerColumn(rows);
  const crosses: [number, number][] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "┼") crosses.push([x, y]);
  });

  // Exactly one cross, where both horizontal seams meet the vertical seam.
  expect(crosses).toEqual([[col, 6]]);
  // The vertical seam still finishes into the outer frame above and below.
  expect(rows[0]![col]).toBe("┬");
  expect(rows[11]![col]).toBe("┴");
});

test("two aligned vertical seams meeting the horizontal seam draw a ┼", async () => {
  const { window, layout, t } = await setup();
  // The mirror image: split horizontally, then split each half vertically at
  // the same column, so both vertical seams converge on the horizontal seam.
  run(window.splitSpawn("column"));
  const top = window.panes[0]!;
  const bottom = window.panes[1]!;
  window.focus(top);
  run(window.splitSpawn("row"));
  window.focus(bottom);
  run(window.splitSpawn("row"));
  await layout();
  await t.renderOnce();

  const rows = t.captureCharFrame().split("\n");
  // The horizontal seam is the row whose ends are ├ and ┤.
  const seamRow = rows.findIndex((row) => row[0] === "├" && row[39] === "┤");
  expect(seamRow).toBeGreaterThan(0);
  // Exactly one ┼, on the horizontal seam, where both vertical seams meet it.
  const columns = rows[seamRow]!.split("")
    .map((c, x) => (c === "┼" ? x : -1))
    .filter((x) => x >= 0);
  expect(columns).toHaveLength(1);
  expect(rows[0]![columns[0]!]).toBe("┬");
  expect(rows[11]![columns[0]!]).toBe("┴");
});

test("a tee stays a tee when the two seams do not align", async () => {
  const { window, layout, t } = await setup();
  // Three panes stacked on the left beside one pane on the right: two
  // horizontal seams at different rows both tee into the vertical seam, and
  // neither has a line continuing on the far side, so both are ┤ not ┼.
  run(window.splitSpawn("row"));
  const left = window.panes[0]!;
  window.focus(left);
  // The pane the split returns, rather than an index into `panes`: that list is
  // in tree order now, so "the one just created" is not a position.
  const under = run(window.splitSpawn("column"))!;
  window.focus(under);
  run(window.splitSpawn("column"));
  await layout();
  await t.renderOnce();

  const rows = t.captureCharFrame().split("\n");
  // No cell can be a ┼: no line crosses a seam here.
  expect(rows.join("\n")).not.toContain("┼");
  // Both seams meet the vertical divider as tees coming from the left.
  const col = dividerColumn(rows);
  const tees = rows.map((row, y) => (row[col] === "┤" ? y : -1)).filter((y) => y >= 0);
  expect(tees).toEqual([5, 9]);
});

test("a classic tee draws a tee, not a ┼", async () => {
  const { window, layout, t } = await setup();
  // One pane left of a vertical stack: the vertical seam is a continuous line
  // and the horizontal seam tees into it from the right. No crossing, so no ┼.
  run(window.splitSpawn("row"));
  const left = window.panes[0]!;
  window.focus(left);
  run(window.splitSpawn("column"));
  await layout();
  await t.renderOnce();

  const rows = t.captureCharFrame().split("\n");
  expect(rows.join("\n")).not.toContain("┼");
  const col = dividerColumn(rows);
  // The seam tees into the vertical line from the left, which runs unbroken
  // to the frame.
  expect(rows[6]![col]).toBe("┤");
  expect(rows[0]![col]).toBe("┬");
  expect(rows[11]![col]).toBe("┴");
});

test("the ┼ follows the seam when a drag moves the vertical divider", async () => {
  const { window, layout, t } = await setup();
  cross(window);
  await layout();

  // Drag the vertical seam well off centre: the two horizontal seams stay
  // aligned on the same row, so the ┼ has to move with the seam, resolved
  // fresh from geometry rather than carried over from the old layout.
  const divider = window.root.getChildren()[1] as Divider;
  divider.onDrag!(15);
  await layout();
  await t.renderOnce();

  const rows = t.captureCharFrame().split("\n");
  const col = dividerColumn(rows);
  expect(rows[6]![col]).toBe("┼");
  expect(rows[0]![col]).toBe("┬");
  expect(rows[11]![col]).toBe("┴");
});

test("a 3-by-2 grid draws a ┼ at every seam crossing", async () => {
  const { window, layout, t } = await setup();
  // Three panes across, then each one split horizontally at the same height:
  // the horizontal seam crosses both vertical seams, so two cells want a ┼.
  run(window.splitSpawn("row"));
  run(window.splitSpawn("row"));
  for (const p of [...window.panes]) {
    window.focus(p);
    run(window.splitSpawn("column"));
  }
  await layout();
  await t.renderOnce();

  const rows = t.captureCharFrame().split("\n");
  const crosses: [number, number][] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "┼") crosses.push([x, y]);
  });

  const [left, right] = [rows[0]!.indexOf("┬"), rows[0]!.lastIndexOf("┬")];
  expect(left).toBeGreaterThan(0);
  expect(right).toBeGreaterThan(left);
  // Both vertical seams meet the horizontal seam as ┼, nothing else does.
  expect(crosses).toEqual([
    [left, 6],
    [right, 6],
  ]);
});
