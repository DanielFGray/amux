/** @effect-diagnostics *:skip-file -- plain-async e2e: drives the real app PTY. */
/**
 * The editor pane through real keys: it opens on the file the command names,
 * `:e` completes a path, and `:q!` gives the pane back to the shell.
 *
 * Placing the pane and loading its content are two steps, and only the first
 * was covered — leader-find.test.ts opens a bare editor and asserts `[No Name]`
 * — so a descriptor that never reached the buffer went unnoticed.
 */
import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { launch, E2E_TIMEOUT, defaultE2ePlugins, type App } from "./app.ts";
import { tempDir } from "../packages/amux/src/test-tmp.ts";

const REPO = join(import.meta.dir, "..");

const editorConfig = () => ({
  options: { "appearance.whichKeyDelay": 0 },
  keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
  plugins: [
    ...defaultE2ePlugins(),
    { path: join(REPO, "packages/editor"), enabled: true },
    { path: join(REPO, "packages/plugin-completion"), enabled: true },
  ],
});

/** Every pane type the session file names, layout JSON included. */
const paneTypes = async (target: App): Promise<string> =>
  JSON.stringify((await target.session())?.spaces ?? []);

let app: App | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

test(
  "editor.open --file shows the file it names",
  async () => {
    // The check owns its fixture: a line from a repo source file would make an
    // ordinary edit to that file fail this test.
    const file = join(tempDir("editor-open"), "note.txt");
    await Bun.write(file, "OPENED-BY-DESCRIPTOR\n");
    app = await launch("e2e-editor-open-file", { config: editorConfig() });
    await app.press(`bun run cli editor.open --file=${file}\r`);
    await app.until(
      () => app?.screen().includes("note.txt") === true,
      "the editor to name the opened file",
      15_000,
    );
    await app.until(
      () => app?.screen().includes("OPENED-BY-DESCRIPTOR") === true,
      "the file content to load",
      15_000,
    );
  },
  E2E_TIMEOUT,
);

test(
  "`:e` completes a path and `:q!` gives the pane back to the shell",
  async () => {
    app = await launch("e2e-editor-commands", { config: editorConfig() });
    await app.press("bun run cli editor.open\r");
    await app.until(() => app?.screen().includes("[No Name]") === true, "an empty editor", 15_000);

    // `:e <tab>` completes against the working directory — this repo, so the
    // files it must offer are the ones checked in at the root.
    await app.press("\x1b");
    await app.press(":");
    await app.press("e");
    await app.press(" ");
    await app.press("\t");
    await app.until(
      () => app?.screen().includes("bun.lock") === true,
      "the completion to list the working directory",
      10_000,
    );

    // A prefix narrows it: what does not match must leave the list.
    await app.press("\x1b");
    await app.press("\x1b");
    await app.press(":");
    await app.press("e");
    await app.press(" ");
    await app.press("A");
    await app.press("\t");
    await app.until(
      () => app?.screen().includes("AGENTS.md") === true,
      "the completion to narrow to the typed prefix",
      10_000,
    );
    expect(app.screen().includes("bun.lock")).toBe(false);

    // Accepting an entry opens that file: the buffer stops being the empty one.
    await app.press("\r");
    await app.until(
      () => app?.screen().includes("[No Name]") === false,
      "the completed file to open",
      15_000,
    );
    expect(app.screen().includes("AGENTS.md")).toBe(true);

    // `:q!` closes the editor pane. The session file, not the screen: the
    // displaced shell repaints over the editor either way. One key per write —
    // a single chunk can reach the buffer before `:` has opened the command
    // line, and `q` in normal mode starts recording a macro instead.
    await app.press("\x1b");
    await app.press(":q!");
    // Enter only once the command line holds the command: `:` and the keys
    // after it can arrive as one input event, and `q` in normal mode starts
    // recording a macro instead.
    await app.until(() => /:q!/.test(app?.screen() ?? ""), "the command line to hold :q!", 5_000);
    await app.press("\r");
    await app.until(
      async () => !(await paneTypes(app!)).includes("amux.editor"),
      "the editor pane to leave the layout",
      15_000,
    );
  },
  E2E_TIMEOUT,
);
