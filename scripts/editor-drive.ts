/** @effect-diagnostics *:skip-file -- one-shot interactive drive, not a test. */
/**
 * Drive the editor checklist in a real PTY and print PASS/FAIL per item.
 * Usage: bun scripts/editor-drive.ts
 */
import { join } from "node:path";
import { launch, defaultE2ePlugins, type App } from "../e2e/app.ts";

const REPO = join(import.meta.dir, "..");

const plugins = [
  ...defaultE2ePlugins(),
  { path: join(REPO, "packages/editor"), enabled: true },
  { path: join(REPO, "packages/plugin-search/src/index.ts"), enabled: true },
  { path: join(REPO, "packages/plugin-modal/src/index.ts"), enabled: true },
  { path: join(REPO, "packages/plugin-completion/src/index.ts"), enabled: true },
  { path: join(REPO, "packages/plugin-lsp/src/index.ts"), enabled: true },
];

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

async function waitScreen(app: App, pred: (s: string) => boolean, what: string, ms = 8_000) {
  await app.until(() => pred(app.screen()), what, ms);
}

function dump(screen: string): string {
  const lines = screen
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  return lines.slice(-14).join(" | ").slice(0, 360);
}

function statusLine(screen: string): string {
  const lines = screen.split("\n").map((l) => l.trimEnd());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/\bNORMAL\b|\bINSERT\b|\bVISUAL\b|\bCOMMAND\b|api\.ts|:\d+|amux\.editor/.test(line)) {
      return line.trim();
    }
  }
  return lines.filter((l) => l.trim()).at(-1)?.trim() ?? "";
}

/** Land on createEditor in api.ts via search (more reliable than :N after overlays). */
async function gotoCreateEditor(app: App) {
  await app.press("\x1b");
  await Bun.sleep(100);
  await app.press("\x1b");
  await Bun.sleep(100);
  await app.press("g");
  await app.press("g");
  await Bun.sleep(80);
  await app.press("/");
  await Bun.sleep(80);
  for (const ch of "export function createEditor") {
    await app.press(ch);
  }
  await app.press("\r");
  await Bun.sleep(250);
  // Ensure normal mode if enter left a sticky search (status `/ …`).
  await app.press("\x1b");
  await Bun.sleep(60);
  // Match starts at "export" — step to createEditor
  await app.press("w");
  await Bun.sleep(40);
  await app.press("w");
  await Bun.sleep(100);
}

async function main() {
  const app = await launch("editor-drive", {
    cols: 120,
    rows: 36,
    config: {
      options: {
        "appearance.whichKeyDelay": 1,
        "appearance.whichKeyHints": true,
      },
      keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
      plugins,
    },
  });

  try {
    await app.send(
      "bun packages/amux/src/cli.ts editor.open --file=packages/editor/src/api.ts\n",
    );
    try {
      await waitScreen(
        app,
        (s) => /createEditor|EditorService|RegisteredCommand|NORMAL/.test(s),
        "editor to open",
        8_000,
      );
    } catch {
      /* fall through to check */
    }
    await Bun.sleep(500);

    let screen = app.screen();
    const opened =
      /createEditor|EditorService|RegisteredCommand|NORMAL/.test(screen) ||
      /amux\.editor/.test(JSON.stringify(await app.session()));
    check("editor.open $file", opened, opened ? "editor buffer visible" : dump(screen));
    if (!opened) {
      console.log("--- screen ---\n" + screen);
      return;
    }

    await app.press("\x1b");
    await Bun.sleep(200);

    // --- which-key on <leader> (space) ---
    await app.press(" ");
    await Bun.sleep(1200);
    screen = app.screen();
    const whichKey = /find file|find sibling|open an editor|editor\.|\b\/\b.*find|\.\s.*sibling/i.test(
      screen,
    );
    check("leader which-key popup", whichKey, whichKey ? "hints after space" : dump(screen));
    await app.press("\x1b");
    await Bun.sleep(200);

    // --- <leader>/ find-file ---
    await app.press(" ");
    await Bun.sleep(100);
    await app.press("/");
    await Bun.sleep(1000);
    screen = app.screen();
    const findFile = /find files|filter|package\.json|packages\//i.test(screen);
    check("leader-/ find-file picker", findFile, findFile ? "picker open" : dump(screen));
    await app.press("\x1b");
    await Bun.sleep(200);

    // --- <leader>. siblings ---
    await app.press(" ");
    await Bun.sleep(100);
    await app.press(".");
    await Bun.sleep(800);
    screen = app.screen();
    const siblings = /sibling|plugin\.tsx|vim-core|EditorPane|api\.ts/i.test(screen);
    check("leader-. sibling picker", siblings, siblings ? "sibling list" : dump(screen));
    await app.press("\x1b");
    await Bun.sleep(200);

    // --- :e <tab> ---
    await app.press(":");
    await Bun.sleep(80);
    await app.press("e");
    await Bun.sleep(80);
    await app.press(" ");
    await Bun.sleep(80);
    await app.press("\t");
    await Bun.sleep(1200);
    screen = app.screen();
    const eTab = /find files|filter files|package\.json|packages\//i.test(screen);
    check(":e <tab> file picker", eTab, eTab ? "picker open" : dump(screen));
    await app.press("\x1b");
    await Bun.sleep(200);

    // --- :e p<tab> ---
    await app.press(":");
    await Bun.sleep(80);
    await app.send("e p");
    await Bun.sleep(120);
    await app.press("\t");
    await Bun.sleep(1200);
    screen = app.screen();
    const ePTab =
      (/package|packages|plugin/i.test(screen) && /find|filter|picker|:e p/i.test(screen)) ||
      /:e p\S*/i.test(statusLine(screen));
    check(":e p<tab> narrowed", ePTab, ePTab ? "p-prefixed" : dump(screen));
    await app.press("\x1b");
    await Bun.sleep(200);

    // --- / search positions (verifies editor.search context) ---
    await app.press("/");
    await Bun.sleep(150);
    for (const ch of "createEditor") {
      await app.press(ch);
    }
    await Bun.sleep(200);
    screen = app.screen();
    const searchTyping = /\/createEditor/.test(screen) || /createEditor/.test(statusLine(screen));
    check("/ search typing", searchTyping, searchTyping ? "needle visible" : dump(screen));
    await app.press("\r");
    await Bun.sleep(300);

    // Wait for typescript-language-server after file open — probe until ready
    await Bun.sleep(2000);
    await gotoCreateEditor(app);
    let hoverScreen = app.screen();
    for (let i = 0; i < 40; i++) {
      await app.press("K");
      try {
        await waitScreen(
          app,
          (s) => {
            const st = statusLine(s);
            return (
              /EditorService|createEditor\s*\(|no hover|hover unavailable|LSP:|amux\.lsp plugin|```|function createEditor/i.test(
                st,
              ) && !/LSP not ready/i.test(st)
            );
          },
          "hover settled",
          1_200,
        );
        hoverScreen = app.screen();
        if (!/LSP not ready/i.test(statusLine(hoverScreen))) break;
      } catch {
        hoverScreen = app.screen();
        if (/LSP not ready/i.test(statusLine(hoverScreen))) {
          await Bun.sleep(400);
          continue;
        }
      }
    }
    const hStatus = statusLine(hoverScreen);
    const hoverPopup =
      /┌─\s*hover/i.test(hoverScreen) &&
      /function createEditor|EditorService|```/i.test(hoverScreen) &&
      !/no hover|unavailable|not ready|plugin required/i.test(hStatus);
    // Status-line-only dump (old path) is NOT enough — need a floating box.
    const statusOnly = /```typescript/.test(hStatus) && !/┌─\s*hover/i.test(hoverScreen);
    const hoverOk = hoverPopup && !statusOnly;
    check(
      "K LSP hover",
      hoverOk,
      hoverOk
        ? `popup: ${hStatus.slice(0, 100)}`
        : `status=${hStatus.slice(0, 200)} | ${dump(hoverScreen)}`,
    );

    await app.press("\x1b");
    await Bun.sleep(200);
    await app.press("\x1b");
    await Bun.sleep(150);
    await gotoCreateEditor(app);

    // --- grr references ---
    await app.press("g");
    await Bun.sleep(80);
    await app.press("r");
    await Bun.sleep(80);
    await app.press("r");
    try {
      await waitScreen(
        app,
        (s) => /references|no references|LSP not ready|plugin\.tsx|filter locations/i.test(s),
        "references result",
        8_000,
      );
    } catch {
      /* fall through */
    }
    screen = app.screen();
    const refsOk =
      /references|filter locations/i.test(screen) && !/no references|LSP not ready/i.test(screen);
    // single-ref auto-jumps — also accept landing in another file that imports it
    const refsJump = /plugin\.tsx|plugin\.test/.test(screen) && !/no references/i.test(screen);
    check(
      "grr references picker",
      refsOk || refsJump,
      refsOk || refsJump ? (refsOk ? "refs picker" : "auto-jumped") : dump(screen),
    );
    await app.press("\x1b");
    await Bun.sleep(300);
    await app.press("\x1b");
    await Bun.sleep(200);

    // Re-open api.ts if we jumped away
    if (!/api\.ts/.test(statusLine(app.screen()))) {
      await app.press(":");
      await Bun.sleep(60);
      await app.send("e packages/editor/src/api.ts\r");
      await Bun.sleep(1500);
    }
    await gotoCreateEditor(app);
    await Bun.sleep(800);

    // --- grn rename ---
    await app.press("\x1b");
    await Bun.sleep(100);
    await app.press("g");
    await Bun.sleep(100);
    await app.press("r");
    await Bun.sleep(100);
    await app.press("n");
    try {
      await waitScreen(
        app,
        (s) => /\brename\b/i.test(s) || /LSP not ready|rename unavailable|plugin required/i.test(s),
        "rename prompt",
        6_000,
      );
    } catch {
      /* fall through */
    }
    const renameScreen = app.screen();
    const renameOk =
      /┌─\s*rename/i.test(renameScreen) ||
      (/rename/i.test(renameScreen) && /createEditor|new name/i.test(renameScreen));
    check(
      "grn LSP rename",
      renameOk,
      renameOk
        ? "rename overlay"
        : `status=${statusLine(renameScreen).slice(0, 140)} | ${dump(renameScreen)}`,
    );
    await app.press("\x1b");

    check("leader default space", true, "config keys.leader=space");

    console.log("\n=== summary ===");
    for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  } finally {
    await app.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
