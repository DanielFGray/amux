/** @effect-diagnostics *:skip-file -- plain-async e2e: drives the real app PTY. */
/**
 * which-key panel: keymap pending + hintVisibility (including whichKeyDelay
 * capped by timeoutlen so a 2s delay still shows before the chord wait clears).
 */
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { launch, LEADER, E2E_TIMEOUT, defaultE2ePlugins, type App } from "./app.ts";

const REPO = join(import.meta.dir, "..");

let app: App | undefined;
afterAll(async () => {
  await app?.stop();
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
    await Bun.sleep(200);
    const screen = app.screen();
    expect(screen.includes("^s")).toBe(true);
    expect(screen.includes("split left/right")).toBe(true);
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
    await Bun.sleep(150);
    expect(app.screen().includes("split left/right")).toBe(true);
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
    await Bun.sleep(200);
    const screen = app.screen();
    expect(screen.includes("SPC")).toBe(true);
    expect(screen.includes("open an editor pane")).toBe(true);
  },
  E2E_TIMEOUT,
);
