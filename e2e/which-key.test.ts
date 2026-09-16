/** @effect-diagnostics *:skip-file -- plain-async e2e: drives the real app PTY. */
/**
 * which-key panel: keymap pending + hintVisibility (including whichKeyDelay
 * capped by timeoutlen so a 2s delay still shows before the chord wait clears).
 */
import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { launch, LEADER, E2E_TIMEOUT, defaultE2ePlugins, type App } from "./app.ts";

const REPO = join(import.meta.dir, "..");

let app: App | undefined;
// Each test launches its own app. A leaked one keeps its daemon alive and the
// next run that reuses the session name attaches to it and finds no agent.
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

test(
  "which-key lists prefix bindings immediately when delay is 0",
  async () => {
    app = await launch("e2e-which-key", {
      config: {
        options: { "appearance.whichKeyDelay": 0, "appearance.whichKeyHints": true },
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        plugins: defaultE2ePlugins(),
      },
    });
    await app.press(LEADER);
    await app.until(
      () => app?.screen().includes("split left/right") === true,
      "the which-key panel",
      5000,
    );
    expect(app.screen().includes("^s")).toBe(true);
  },
  E2E_TIMEOUT,
);

test(
  "which-key still appears when whichKeyDelay exceeds timeoutlen",
  async () => {
    app = await launch("e2e-which-key-delay", {
      config: {
        options: { "appearance.whichKeyDelay": 2, "appearance.whichKeyHints": true },
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        plugins: defaultE2ePlugins(),
      },
    });
    await app.press(LEADER);
    // Under the 2s delay the panel would never draw this early; timeoutlen caps it.
    await app.until(
      () => app?.screen().includes("split left/right") === true,
      "the which-key panel before the 2s delay would fire",
      1500,
    );
    await Bun.sleep(800);
    expect(app.screen().includes("split left/right")).toBe(true);
  },
  E2E_TIMEOUT,
);

test(
  "which-key lists editor leader chords",
  async () => {
    app = await launch("e2e-which-key-leader", {
      config: {
        options: { "appearance.whichKeyDelay": 0, "appearance.whichKeyHints": true },
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        plugins: [
          ...defaultE2ePlugins(),
          { path: join(REPO, "packages/editor"), enabled: true },
          { path: join(REPO, "packages/plugin-modal"), enabled: true },
        ],
      },
    });
    await app.press("bun packages/amux/src/cli.ts editor.open\r");
    await app.until(() => app!.screen().includes("[No Name]"), "editor open", 8000);
    await app.press("\x1b");
    await Bun.sleep(100);
    await app.press(" ");
    await app.until(
      () => app?.screen().includes("open an editor pane") === true,
      "the editor leader chords",
      5000,
    );
    expect(app.screen().includes("SPC")).toBe(true);
  },
  E2E_TIMEOUT,
);
