/** @effect-diagnostics *:skip-file -- plain-async by design: this test drives the real TUI through a PTY. */
import { afterAll, test } from "bun:test";
import { E2E_TIMEOUT, LEADER, hasSidebarFooter, launch, type App } from "./app.ts";

let app: App;

afterAll(async () => {
  await app?.stop();
});

/**
 * Escape from an edit row closes the settings window (settingsEditKey), not
 * just the in-progress edit. Opens settings the same way as options.test —
 * default leader, no modal plugin — so the chord is a real `<prefix>shift+s`
 * sequence rather than a modal alias that races mode entry on a cold client.
 */
test(
  "Escape closes settings while editing a field",
  async () => {
    app = await launch("e2e-settings-escape");
    await app.until(() => hasSidebarFooter(app.screen()), "the sidebar to draw its footer");
    await app.press(`${LEADER}S`);
    await app.until(() => app.screen().includes(" settings "), "the settings window to open");

    await app.press("\r");
    await app.press("\x1b");
    await app.until(
      () => !app.screen().includes(" settings "),
      "the settings window to close with Escape",
    );
  },
  E2E_TIMEOUT,
);
