/**
 * ^a ctrl+arrow resizes the pane by keyboard.
 *
 * The unit suite checks the pieces separately — a binding compiles and
 * dispatches (bindings.test.ts), a window method moves the weights
 * (window.test.ts). What only a real app can show is the pieces joined up: the
 * keymap reaching the command, the command reaching the window, and the
 * divider actually moving on screen. That is the ts-456094 class of bug — a
 * command that quietly does nothing — so it is worth pressing the key for.
 *
 * Plain arrows are focus, not resize, so they are checked against moving the
 * divider at all.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { launch, teeColumn, LEADER, E2E_TIMEOUT, type App } from "./app.ts";

/** ctrl+left as xterm writes it. Sent whole via App.send — press() writes one
 *  character per write with a gap, and the streaming parser would split this
 *  sequence on its escape timeout. */
const CTRL_LEFT = "\x1b[1;5D";
const RIGHT = "\x1b[C";

let app: App;
let afterSplit = -1;

beforeAll(async () => {
  app = await launch("e2e-resize");
  await app.press(`${LEADER}|`); // split left/right
  await app.until(() => teeColumn(app.screen()) !== -1, "the split to draw a divider");
  afterSplit = teeColumn(app.screen());
}, E2E_TIMEOUT);

afterAll(async () => {
  await app?.stop();
});

test(
  "^a ctrl+left moves the divider one cell per press",
  async () => {
    await app.press(LEADER);
    app.send(CTRL_LEFT);
    await app.until(
      () => teeColumn(app.screen()) === afterSplit - 1,
      "the divider to move one cell left",
    );
    expect(teeColumn(app.screen())).toBe(afterSplit - 1);

    await app.press(LEADER);
    app.send(CTRL_LEFT);
    await app.press(LEADER);
    app.send(CTRL_LEFT);
    await app.until(() => teeColumn(app.screen()) === afterSplit - 3, "three cells left");
    expect(teeColumn(app.screen())).toBe(afterSplit - 3);
  },
  E2E_TIMEOUT,
);

test(
  "^a right focuses instead of resizing",
  async () => {
    // The plain arrow shares the prefix with resize but means focus: the divider
    // must not move under it. There is no state to wait FOR here — the assertion
    // is that nothing happens — so this is the one place a sleep is the check.
    const before = teeColumn(app.screen());
    await app.press(LEADER);
    app.send(RIGHT);
    await Bun.sleep(500);
    expect(teeColumn(app.screen())).toBe(before);
  },
  E2E_TIMEOUT,
);
