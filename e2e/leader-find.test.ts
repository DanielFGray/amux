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
import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { launch, E2E_TIMEOUT, LEADER, defaultE2ePlugins, type App } from "./app.ts";

const REPO = join(import.meta.dir, "..");
/** Editor mapleader (space). Distinct from e2e `LEADER`, which is the mux prefix. */
const MAPLEADER = " ";

let app: App | undefined;
// Each test launches its own app. A leaked one keeps its daemon alive and the
// next run that reuses the session name attaches to it and finds no agent.
afterEach(async () => {
  await app?.stop();
  app = undefined;
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
    await app.press(MAPLEADER);
    await app.until(
      () => app!.screen().includes("find file in project"),
      "find-files which-key after leader",
    );
    await app.press("/");
    await app.until(() => app!.screen().includes("find files"), "find-files picker");
    let screen = app.screen();
    expect(screen.includes("↑↓ select")).toBe(true);
    // Empty query must list frecency hits — not a stuck "No matches" paint.
    // Stale ModalPicker `view` props used to keep the empty first paint while
    // choose() still read the live signal (Enter opened a file you couldn't see).
    expect(screen.includes("No matches.")).toBe(false);
    // Filter input must own typing — not the editor under the overlay.
    await app.press("readme");
    await app.until(
      () => app!.screen().toLowerCase().includes("readme"),
      "find-files filter results",
    );
    screen = app.screen();
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
    await app.press(MAPLEADER);
    await app.until(
      () => app!.screen().includes("find sibling file"),
      "sibling which-key after leader",
    );
    await app.press(".");
    // Untitled buffer has no path — soft error to the console, not a silent no-op.
    await app.until(() => /\d+ err/.test(app!.screen()), "the error marker after sibling find");
    // Console is mux `<prefix>\`` (e2e LEADER is ctrl+s), not editor mapleader.
    await app.press(`${LEADER}\``);
    await app.until(() => {
      const screen = app!.screen().toLowerCase();
      // OpenTUI console can split the message on the pane border
      // (`'no file —│open a buffer first'`), so match either half.
      return screen.includes("no file") || screen.includes("open a buffer");
    }, "sibling find error in the console");
    await app.press(`${LEADER}\``);
    await app.until(() => {
      const screen = app!.screen().toLowerCase();
      return !screen.includes("no file") && !screen.includes("open a buffer");
    }, "the console to close");
  },
  E2E_TIMEOUT,
);
