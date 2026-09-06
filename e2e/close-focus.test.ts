/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/**
 * Closing a pane must always leave a focused, keyable pane.
 *
 * session.kill and a natural exit both prune the dead session's pane out of
 * the layout and used to DROP focus entirely — the window came back with no
 * pane focused, so typing went nowhere. `pane.close` itself was already fine;
 * the two `prune`-based paths were not. Each check closes the focused pane by a
 * different route and then types, so a dead window shows up as "keys go
 * nowhere" instead of as a model field nobody reads.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { launch, LEADER, E2E_TIMEOUT, type App } from "./app.ts";

let app: App;

beforeAll(async () => {
  app = await launch("e2e-close-focus");
}, E2E_TIMEOUT);

afterAll(async () => {
  await app?.stop();
});

/** The active window's persisted layout's focus pane, or null when unfocused. */
async function activeWindowLayoutFocus(app: App): Promise<string | null> {
  const session = await app.session();
  const space = session?.spaces?.[0];
  const window = space?.windows.find((w) => w.number === space.activeWindow);
  if (typeof window?.layout !== "string") return null;
  const layout = JSON.parse(window.layout) as { focus?: string };
  return layout.focus ?? null;
}

/** Split the active window, and wait for the projection to settle so typing
 *  after this lands in the newcomer rather than racing the split's focus move. */
async function splitAndSettle(): Promise<void> {
  await app.press(`${LEADER}|`);
  await app.until(
    async () => (await app.workspaceSummary()) === "1sp 1win 2ag",
    "the split to add a second agent",
  );
  await Bun.sleep(500);
}

/** The window must name a focused pane in the model, and that pane must answer
 *  typed input — the two halves of "a pane has focus". */
async function expectFocusedAndKeyable(marker: string): Promise<void> {
  expect(await activeWindowLayoutFocus(app)).toBeTruthy();
  await app.press(`echo ${marker}\n`);
  await app.until(() => app.screen().includes(marker), `the surviving pane to receive typed input`);
}

test(
  "pane.close of the focused pane leaves a survivor focused and keyable",
  async () => {
    expect(await app.workspaceSummary()).toBe("1sp 1win 1ag");
    await splitAndSettle();
    await app.press(`${LEADER}x`);
    await app.until(
      async () => (await app.workspaceSummary()) === "1sp 1win 1ag",
      "the close to remove one agent",
    );
    await expectFocusedAndKeyable("after-close");
  },
  E2E_TIMEOUT,
);

test(
  "closing the focused pane of the active window transfers focus to the successor window",
  async () => {
    expect(await app.workspaceSummary()).toBe("1sp 1win 1ag");
    await app.press(`${LEADER}c`); // window 2
    await app.until(
      async () => (await app.workspaceSummary()) === "1sp 2win 2ag",
      "a second window",
    );
    await app.press(`${LEADER}1`); // back to window 1
    await app.until(
      async () => (await app.session())?.spaces?.[0]?.activeWindow === 1,
      "window 1 to be active",
    );

    // Window 1 has one pane; closing it empties the window, so the daemon
    // collapses it and activates window 2, which must be focused and keyable.
    await app.press(`${LEADER}x`);
    await app.until(
      async () => (await app.workspaceSummary()) === "1sp 1win 1ag",
      "window 1 to close into window 2",
    );
    expect((await app.session())?.spaces?.[0]?.activeWindow).toBe(2);
    await expectFocusedAndKeyable("successor-focused");
  },
  E2E_TIMEOUT,
);

test(
  "session.kill of the focused session leaves a survivor focused and keyable",
  async () => {
    await splitAndSettle();
    await app.press(`${LEADER}K`);
    await app.until(
      async () => (await app.workspaceSummary()) === "1sp 1win 1ag",
      "the kill to remove one agent",
    );
    await expectFocusedAndKeyable("kill-survivor");
  },
  E2E_TIMEOUT,
);

test(
  "a natural exit of the focused shell leaves a survivor focused and keyable",
  async () => {
    await splitAndSettle();
    // The exited session record stays (the sidebar shows it as done), so the
    // layout collapsing to one pane is the model signal the exit was handled.
    await app.press("exit\n");
    await app.until(async () => {
      const rows = app
        .screen()
        .split("\n")
        .map((line, row) => (line.includes("┌") ? row : -1))
        .filter((row) => row !== -1);
      return rows.length === 1;
    }, "the exited pane to close, leaving one pane");
    await expectFocusedAndKeyable("exit-survivor");
  },
  E2E_TIMEOUT,
);
