/**
 * A float is moved by the arrows and resized by ctrl+arrows.
 *
 * Worth pressing the keys for because the bug it guards was a command that
 * quietly did nothing: resizePane walked the tiled tree for the focused pane's
 * path, a float has no path in it, so both gestures came back with the layout
 * unchanged and the screen never moved. A unit test can assert the model edits
 * its fractions; only the screen can say the fractions reached the renderer,
 * the way the float's borders are placed by percentage while the model holds
 * fractions.
 *
 * The float's own frame is the signal. It draws all four borders, so its
 * top-left corner row is the second ┌ row on screen (the window's is the
 * first), and its left and right edges are the ┌ and ┐ of that row. Moving
 * shifts both by one cell; growing right shifts only the ┐.
 *
 * Plain arrows move a float, but for a tiled pane the same key is focus — so
 * the move check has to read the float's own cells and see them travel, not
 * trust that the key "just did something".
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { launch, LEADER, E2E_TIMEOUT, type App } from "./app.ts";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const CTRL_RIGHT = "\x1b[1;5C";

let app: App;
let start = { left: -1, right: -1 };

/** Rows carrying a pane's top-left corner; the float's is the second one. */
const cornerRows = (screen: string) =>
  screen
    .split("\n")
    .map((line, row) => (line.includes("┌") ? row : -1))
    .filter((row) => row !== -1);

/** The float's left and right edges, or null while it is mid-reprojection: a
 *  layout change unmounts and remounts the float's frame, so for a poll it can
 *  be absent without meaning the float is gone. A wait polls through that. */
const floatEdges = (screen: string): { left: number; right: number } | null => {
  const rows = cornerRows(screen);
  if (rows.length !== 2) return null;
  const line = screen.split("\n")[rows[1]!]!;
  return { left: line.indexOf("┌"), right: line.indexOf("┐") };
};

beforeAll(async () => {
  app = await launch("e2e-floatmove");
  await app.press(`${LEADER}|`); // split left/right
  await app.until(() => cornerRows(app.screen()).length === 1, "the split to draw");
  await app.press(`${LEADER}f`);
  await app.until(
    () => cornerRows(app.screen()).length === 2,
    "the float to draw its own frame over the tiled pane",
  );
  start = floatEdges(app.screen())!;
}, E2E_TIMEOUT);

afterAll(async () => {
  await app?.stop();
});

test(
  "^a left moves the float one cell without resizing it",
  async () => {
    await app.press(LEADER);
    app.send(LEFT);
    await app.until(
      () => floatEdges(app.screen())?.left === start.left - 1,
      "the float to move one cell left",
    );
    const moved = floatEdges(app.screen())!;
    expect(moved.right).toBe(start.right - 1);
    // A move changes the origin, never the size: the edges travel together.
    expect(moved.right - moved.left).toBe(start.right - start.left);
  },
  E2E_TIMEOUT,
);

test(
  "^a ctrl+right grows the float, keeping its left edge put",
  async () => {
    const before = floatEdges(app.screen())!;
    await app.press(LEADER);
    app.send(CTRL_RIGHT);
    await app.until(
      () => floatEdges(app.screen())?.right === before.right + 1,
      "the float to grow one cell right",
    );
    const grown = floatEdges(app.screen())!;
    expect(grown.left).toBe(before.left);
  },
  E2E_TIMEOUT,
);

test(
  "^a right moves the float back, not towards a tiled neighbour",
  async () => {
    const before = floatEdges(app.screen())!;
    await app.press(LEADER);
    app.send(RIGHT);
    await app.until(
      () => floatEdges(app.screen())?.left === before.left + 1,
      "the float to move one cell right",
    );
    expect(floatEdges(app.screen())!.right).toBe(before.right + 1);
  },
  E2E_TIMEOUT,
);
