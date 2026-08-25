/**
 * A setting changed through the app reaches the screen, and reaches the file as
 * a delta.
 *
 * The delta half is the reason this is here rather than in the unit suite. Save
 * used to write the whole config — every option, defaults included — so the
 * first time anyone pressed `s` their file pinned the current value of every
 * *other* setting, and changing a default in a later release reached nobody who
 * had ever opened the settings window. That is invisible to a test that only
 * reads values back, because reading back gives the right answer either way.
 * The only thing that distinguishes the two is what is actually on disk, so
 * this drives the real window and then looks at the file.
 *
 * The screen half is the other claim the options table makes: the sidebar's
 * visibility IS `sidebar.open`, not a signal that happens to be seeded from it.
 * `^a b` and the settings row are two ways to reach one value, and if they were
 * ever two values again, only one of these assertions would fail.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  launch,
  LEADER,
  E2E_TIMEOUT,
  hasSidebarFooter,
  type App,
  type E2eConfig,
} from "./app.ts";

let app: App;
/** The file after toggling the sidebar off through the settings window. */
let saved: E2eConfig | null = null;

beforeAll(async () => {
  app = await launch("e2e-options");
  await app.until(() => hasSidebarFooter(app.screen()), "the sidebar to draw its footer");

  // Settings opens on the sidebar section, whose first row is sidebar.open.
  await app.press(`${LEADER}S`);
  await app.until(() => app.screen().includes("open"), "the settings window to list the option");
  app.send("\x1b[C"); // right arrow, in one write so the parser sees a key
  await app.press("s");
  await app.until(
    async () => (await app.config()) !== null,
    "the settings window to write the config",
  );
  saved = await app.config();
}, E2E_TIMEOUT);

afterAll(async () => {
  await app?.stop();
});

test("the settings row is named after the option, not prettified", () => {
  // "open", under the "sidebar" tab: what the row is called is what the option
  // is called, so acting on it from anywhere else needs no translation table.
  expect(app.screen()).toContain("open");
});

test("only the option that was changed is written", () => {
  expect(saved?.options).toEqual({ "sidebar.open": false });
});

test(
  "the sidebar closes because the option is what it was reading",
  async () => {
    await app.press(`${LEADER}S`); // leave the settings window
    await app.until(
      () => !app.screen().includes(" settings ") && !hasSidebarFooter(app.screen()),
      "the settings window to close with the sidebar hidden",
    );
  },
  E2E_TIMEOUT,
);

test(
  "^a b puts it back, and the file empties rather than pinning the default",
  async () => {
    await app.press(`${LEADER}b`);
    await app.until(() => hasSidebarFooter(app.screen()), "the sidebar to come back");

    await app.press(`${LEADER}S`);
    await app.until(() => app.screen().includes(" settings "), "the settings window to open");
    await app.press("s");
    await app.until(
      async () => Object.keys((await app.config())?.options ?? {}).length === 0,
      "the entry to be dropped",
    );
    expect((await app.config())?.options).toEqual({});
  },
  E2E_TIMEOUT,
);
