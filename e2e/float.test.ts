/**
 * `^a f` lifts the focused pane out of the split and puts it back.
 *
 * Worth pressing the key for because floating crosses every layer this project
 * keeps separate: the binding, the command, the daemon's layout transform, and
 * the renderer, which places a float by percentage while the model holds
 * fractions. The unit tests pin each of those; only the screen says they agree.
 *
 * Two signals, and they have to move together. A float leaves the tiled plane,
 * so the divider between the two panes goes away — the tee where it meets the
 * top frame is the same marker zoom.test.ts and resize.test.ts read. And a
 * float draws its own frame, so a second top-left corner appears below the
 * window's. Either alone is ambiguous: losing the divider is also what a zoom
 * looks like, and one corner is just the window. Together they are a pane
 * drawn over the others.
 *
 * This check earned its place by failing. The wire schema for a window's layout
 * listed no floats field, and Effect Schema strips what a struct does not name —
 * so the daemon held a float the client was never sent, and pressing the key
 * dropped the connection. Every unit test passed, because none of them crossed
 * that boundary.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { launch, teeColumn, LEADER, E2E_TIMEOUT, type App } from "./app.ts";

let app: App;

/**
 * Rows carrying a pane's top-left corner.
 *
 * However many panes are tiled, they share one top edge and so one corner: a
 * side facing another pane belongs to the divider between them, which draws a
 * tee rather than a corner. A second corner row therefore means a second frame
 * that touches nothing — a float.
 */
const cornerRows = (screen: string) =>
  screen
    .split("\n")
    .map((line, row) => (line.includes("┌") ? row : -1))
    .filter((row) => row !== -1);

beforeAll(async () => {
  app = await launch("e2e-float");
  await app.press(`${LEADER}|`); // split left/right
  await app.until(() => teeColumn(app.screen()) !== -1, "the split to draw a divider");
}, E2E_TIMEOUT);

afterAll(async () => {
  await app?.stop();
});

test(
  "^a f takes the pane out of the split and draws it over the rest",
  async () => {
    expect(cornerRows(app.screen())).toHaveLength(1);
    await app.press(`${LEADER}f`);
    await app.until(
      () => cornerRows(app.screen()).length === 2,
      "the float to draw its own frame inside the window",
    );
    // The divider is gone because only one pane is tiled now, and the second
    // corner is the float's own frame, well below the window's top edge.
    expect(teeColumn(app.screen())).toBe(-1);
    const [outer, float] = cornerRows(app.screen());
    expect(float).toBeGreaterThan(outer!);
  },
  E2E_TIMEOUT,
);

test(
  "^a f again puts it back in the split",
  async () => {
    await app.press(`${LEADER}f`);
    await app.until(() => teeColumn(app.screen()) !== -1, "the divider to come back");
    expect(cornerRows(app.screen())).toHaveLength(1);
  },
  E2E_TIMEOUT,
);
