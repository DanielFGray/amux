/**
 * ^a z fills the window with one pane, and pressing it again puts the
 * arrangement back exactly.
 *
 * Worth pressing the key for because of HOW zoom is implemented. It does not
 * park the renderable tree off to one side and hang it back afterwards; it
 * captures the arrangement as a Layout, re-projects the window with a single
 * pane mounted, and projects the capture again on the way out. Whether that
 * round trip is exact or merely approximate is not something the model can
 * answer about itself — the screen has to.
 *
 * So the divider is dragged well off centre first. An even split would come
 * back right under almost any restore, including a wrong one; a seam three
 * cells off centre only lands in the same column if the weights, the nesting
 * and the divider all survived.
 *
 * The marker is the tee where the divider meets the window's top frame line,
 * the same one resize.test.ts uses. A zoomed window has no dividers at all, so
 * its absence is the signal that the zoom took.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { launch, teeColumn, LEADER, E2E_TIMEOUT, type App } from "./app.ts";

const CTRL_LEFT = "\x1b[1;5D";

let app: App;
/** Where the seam sits after being dragged off centre — what an exact restore
 *  has to reproduce. */
let dragged = -1;

beforeAll(async () => {
  app = await launch("e2e-zoom");
  await app.press(`${LEADER}|`); // split left/right
  await app.until(() => teeColumn(app.screen()) !== -1, "the split to draw a divider");

  // Off centre, so a restore that merely rebuilds an even split is not mistaken
  // for one that restored the actual arrangement.
  const even = teeColumn(app.screen());
  for (let i = 0; i < 3; i++) {
    await app.press(LEADER);
    app.send(CTRL_LEFT);
  }
  await app.until(
    () => teeColumn(app.screen()) === even - 3,
    "the divider to move three cells left",
  );
  dragged = teeColumn(app.screen());
}, E2E_TIMEOUT);

afterAll(async () => {
  await app?.stop();
});

test(
  "^a z fills the window, leaving no divider on screen",
  async () => {
    await app.press(`${LEADER}z`);
    await app.until(
      () => teeColumn(app.screen()) === -1,
      "the zoom to take the divider off screen",
    );
    expect(teeColumn(app.screen())).toBe(-1);
  },
  E2E_TIMEOUT,
);

test(
  "^a z again brings the second pane back",
  async () => {
    await app.press(`${LEADER}z`);
    await app.until(() => teeColumn(app.screen()) !== -1, "the unzoom to bring the divider back");
    expect(teeColumn(app.screen())).not.toBe(-1);
  },
  E2E_TIMEOUT,
);

test("the restored seam is where the drag left it, not re-evened", () => {
  expect(teeColumn(app.screen())).toBe(dragged);
});
