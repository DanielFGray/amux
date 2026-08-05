/**
 * A rebound key actually fires, and the settings window can rebind it.
 *
 * Two things that only pressing a key can establish. The keymap will happily
 * register a binding that never dispatches (lrn-42d64b), so "the config says
 * ^a g is bound" and "^a g splits the pane" are separate claims and this checks
 * the second. And ts-8b3867's Definition of Done asks for capture, reset and
 * save to still work once a command's `run` became an Effect — the settings
 * window rebuilds the whole keymap layer on every change, which is the path
 * that would break if running a command had.
 *
 * Two apps rather than one: the config-bound half has to be launched with the
 * binding already in place, and the settings half has to start from a default
 * config it can edit.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { launch, LEADER, E2E_TIMEOUT, type App } from "./app.ts";

// ^a g is bound to nothing by default, so a split appearing under it can only
// have come from the config.
const REBOUND = { keys: { leader: "ctrl+a", bindings: { "pane.split-row": ["<leader>g"] } } };

let configured: App;
let edited: App;
let beforeSplit = "";
let afterSplit = "";
let captured: Record<string, any> | null = null;
let reset: Record<string, any> | null = null;

beforeAll(async () => {
  configured = await launch("e2e-keybind-config", { config: REBOUND });
  beforeSplit = await configured.shape();
  await configured.press(`${LEADER}g`);
  await configured.until(
    async () => (await configured.shape()) === "1sp 1win 2ag",
    "the rebound split to persist",
  );
  afterSplit = await configured.shape();

  // The settings window's keybind tab: row 0 is the prefix, so j lands on the
  // first real command (panes/pane.split-row). Enter captures the next
  // keystroke, u resets the row, s writes the config.
  edited = await launch("e2e-keybind-edit");
  await edited.press(`${LEADER}?`);
  await edited.until(
    () => edited.screen().includes(" settings ") && edited.screen().includes("split left/right"),
    "the keybind settings to open",
  );
  await edited.press("j");
  await edited.press("\r");
  await edited.until(
    () => edited.screen().includes("press a key…"),
    "pane.split-row to enter key capture",
  );
  await edited.press("g");
  await edited.press("s");
  await edited.until(
    async () => (await edited.config())?.keys?.bindings?.["pane.split-row"]?.[0] === "<leader>g",
    "the captured binding to be saved",
  );
  captured = await edited.config();

  await edited.press("u");
  await edited.until(
    () => edited.screen().includes("unsaved"),
    "pane.split-row to return to its default",
  );
  await edited.press("s");
  await edited.until(
    async () => !Object.hasOwn((await edited.config())?.keys?.bindings ?? {}, "pane.split-row"),
    "the reset binding to be saved",
  );
  reset = await edited.config();
}, E2E_TIMEOUT);

afterAll(async () => {
  await configured?.stop();
  await edited?.stop();
});

test("a config-bound key dispatches its command", () => {
  expect(beforeSplit).toBe("1sp 1win 1ag");
  expect(afterSplit).toBe("1sp 1win 2ag");
});

test("save writes the binding to the config", () => {
  expect(captured).not.toBeNull();
});

test("capture records the pressed key under the prefix", () => {
  expect(captured?.keys?.bindings?.["pane.split-row"]?.[0]).toBe("<leader>g");
});

test("reset takes the row back to its default", () => {
  expect(reset?.keys?.bindings ?? {}).not.toHaveProperty("pane.split-row");
});
