/** @effect-diagnostics *:skip-file -- plain-async by design: this test drives the real TUI through a PTY. */
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { E2E_TIMEOUT, defaultE2ePlugins, launch, type App } from "./app.ts";

let app: App;

afterAll(async () => {
  await app?.stop();
});

async function layout() {
  const session = await app.session();
  return session?.spaces[0]?.windows[0]?.layout;
}

test(
  "vim mode retains amux mode after a resize",
  async () => {
    app = await launch("e2e-modal", {
      config: {
        options: { "modal.vimMode": true },
        keys: { leader: "ctrl+s", bindings: {} },
        plugins: [
          ...defaultE2ePlugins(),
          { path: join(process.cwd(), "packages/plugin-modal/src/index.ts"), enabled: true },
        ],
      },
    });
    await app.press("\x13S");
    await app.until(() => app.screen().includes(" settings "), "the settings window");
    await app.press("\t");
    for (let attempt = 0; attempt < 8 && !app.screen().includes("vimMode"); attempt++)
      await app.press("j");
    expect(app.screen()).toContain("vimMode");
    expect(app.screen()).toContain("yes");
    await app.press("\x1b");
    await app.until(() => !app.screen().includes(" settings "), "settings to close");

    await app.press("\x13|");
    await app.until(async () => (await app.workspaceSummary()) === "1sp 1win 2ag", "the split");
    await Bun.sleep(500);

    const before = await layout();
    await app.press("\x13h");
    await app.until(async () => (await layout()) !== before, "the first resize");
    const first = await layout();

    await app.press("l");
    await app.until(async () => (await layout()) !== first, "the second resize without a prefix");
    expect(await layout()).not.toBe(before);
  },
  E2E_TIMEOUT,
);
