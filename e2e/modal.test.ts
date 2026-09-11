/** @effect-diagnostics *:skip-file -- plain-async by design: this test drives the real TUI through a PTY. */
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { E2E_TIMEOUT, defaultE2ePlugins, launch, type App } from "./app.ts";

let app: App;

afterAll(async () => {
  await app?.stop();
});

/** The active window's focused pane id — same decode as e2e/close-focus.test.ts. */
async function focusedPane(): Promise<string | null> {
  const session = await app.session();
  const window = session?.spaces?.[0]?.windows[0];
  if (typeof window?.layout !== "string") return null;
  const layout = JSON.parse(window.layout) as { focus?: string };
  return layout.focus ?? null;
}

/** Enter amux mode, then run a leader-alias key. The modal plugin consumes the
 *  leader as "enter mode"; the follow-up only aliases once that context is
 *  active, so the two strokes must not share a single press() burst. */
async function amux(key: string): Promise<void> {
  await app.press("\x13");
  await Bun.sleep(300);
  await app.press(key);
}

test(
  "vim mode retains amux mode after a command",
  async () => {
    // modal.vimMode is set in config. While amux mode is active, global
    // <prefix> bindings are re-exposed without the leader. A column split
    // (`-`, not `|` — the pipe alias does not fire from a PTY `|` byte)
    // makes j/k move focus between panes; vimMode keeps amux mode so the
    // second focus needs no new leader.
    app = await launch("e2e-modal", {
      config: {
        options: { "modal.vimMode": true },
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        plugins: [
          ...defaultE2ePlugins(),
          { path: join(process.cwd(), "packages/plugin-modal/src/index.ts"), enabled: true },
        ],
      },
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      if ((await app.workspaceSummary()) === "1sp 1win 2ag") break;
      await amux("-");
      await Bun.sleep(400);
    }
    await app.until(async () => (await app.workspaceSummary()) === "1sp 1win 2ag", "the split");

    // Enter mode and focus up with a leader. vimMode must keep mode so the
    // following bare `j` can focus down without another leader.
    await amux("k");
    const afterFirst = await focusedPane();
    expect(afterFirst).not.toBeNull();

    await app.press("j");
    await app.until(
      async () => (await focusedPane()) !== afterFirst,
      "focus without a second leader",
    );
    expect(await focusedPane()).not.toBe(afterFirst);
  },
  E2E_TIMEOUT,
);
