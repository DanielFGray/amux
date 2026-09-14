/** @effect-diagnostics *:skip-file -- plain-async e2e: drives the real app PTY. */
/**
 * Regression: <leader>/ and <leader>. should open the editor file picker.
 *
 * Root cause (ts): OpenTUI Slot drops chrome whose first paint is empty
 * (`hasInitialOutput`). The file-finder overlay used to register hidden, so a
 * later setView never remounted it — chords fired, topOverlay named the
 * picker, and the screen stayed blank. file-ui now registers the overlay on
 * first open.
 */
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { launch, E2E_TIMEOUT, defaultE2ePlugins, type App } from "./app.ts";

const REPO = join(import.meta.dir, "..");

let app: App | undefined;
afterAll(async () => {
  await app?.stop();
});

test(
  "leader / opens the find-files picker",
  async () => {
    app = await launch("e2e-leader-find-file", {
      config: {
        options: { "appearance.whichKeyDelay": 0, "appearance.whichKeyHints": true },
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        plugins: [
          ...defaultE2ePlugins(),
          { path: join(REPO, "packages/editor"), enabled: true },
          { path: join(REPO, "packages/plugin-search"), enabled: true },
          { path: join(REPO, "packages/plugin-completion"), enabled: true },
        ],
      },
    });
    await app.press("bun packages/amux/src/cli.ts editor.open\r");
    await app.until(() => app!.screen().includes("[No Name]"), "editor open", 8000);
    await app.press("\x1b");
    await Bun.sleep(100);
    await app.press(" ");
    await Bun.sleep(200);
    expect(app.screen().includes("find file in project")).toBe(true);
    await app.press("/");
    await Bun.sleep(800);
    let screen = app.screen();
    expect(screen.includes("find files")).toBe(true);
    expect(screen.includes("↑↓ select")).toBe(true);
    // Empty query must list frecency hits — not a stuck "No matches" paint.
    // Stale ModalPicker `view` props used to keep the empty first paint while
    // choose() still read the live signal (Enter opened a file you couldn't see).
    expect(screen.includes("No matches.")).toBe(false);
    // Filter input must own typing — not the editor under the overlay.
    await app.press("readme");
    await Bun.sleep(800);
    screen = app.screen();
    expect(screen.toLowerCase().includes("readme")).toBe(true);
    expect(screen.includes("No matches.")).toBe(false);
    // Editor should not have entered insert / typed into the buffer.
    expect(screen.includes("-- INSERT --") || screen.includes("readme\n")).toBe(false);
  },
  E2E_TIMEOUT,
);

test(
  "leader . reports when no buffer is open (sibling picker path)",
  async () => {
    app = await launch("e2e-leader-find-sibling", {
      config: {
        options: { "appearance.whichKeyDelay": 0, "appearance.whichKeyHints": true },
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        plugins: [
          ...defaultE2ePlugins(),
          { path: join(REPO, "packages/editor"), enabled: true },
          { path: join(REPO, "packages/plugin-completion"), enabled: true },
        ],
      },
    });
    await app.press("bun packages/amux/src/cli.ts editor.open\r");
    await app.until(() => app!.screen().includes("[No Name]"), "editor open", 8000);
    await app.press("\x1b");
    await Bun.sleep(100);
    await app.press(" ");
    await Bun.sleep(200);
    expect(app.screen().includes("find sibling file")).toBe(true);
    await app.press(".");
    await Bun.sleep(500);
    const screen = app.screen();
    // Untitled buffer has no path — soft error, not a silent no-op.
    expect(screen.toLowerCase().includes("no file") || screen.includes("sibling")).toBe(true);
  },
  E2E_TIMEOUT,
);
