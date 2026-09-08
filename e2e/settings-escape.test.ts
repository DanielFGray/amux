/** @effect-diagnostics *:skip-file -- plain-async by design: this test drives the real TUI through a PTY. */
import { afterAll, test } from "bun:test";
import { join } from "node:path";
import { E2E_TIMEOUT, defaultE2ePlugins, launch, type App } from "./app.ts";

let app: App;

afterAll(async () => {
  await app?.stop();
});

test(
  "Escape closes settings while editing a field",
  async () => {
    app = await launch("e2e-settings-escape", {
      config: {
        keys: { leader: "ctrl+s", bindings: {} },
        plugins: [
          ...defaultE2ePlugins(),
          { path: join(process.cwd(), "packages/plugin-modal/src/index.ts"), enabled: true },
        ],
      },
    });
    await app.press("\x13S");
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
