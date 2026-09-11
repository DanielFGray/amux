/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test";
import { Effect } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createBindings, nextKeys, type CommandSpec } from "../bindings.ts";
import { Hints, hintVisibility } from "./Hints.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const COMMANDS: CommandSpec[] = [
  {
    name: "pane.split",
    key: ["<prefix>|", "<prefix>\\"],
    desc: "split",
    group: "panes",
    run: Effect.void,
  },
  { name: "pane.zoom", key: "<prefix>z", desc: "zoom", group: "panes", run: Effect.void },
  { name: "window.new", key: "<prefix>c", desc: "new window", group: "windows", run: Effect.void },
  // A sibling covered by another entry: hidden, so no hint of its own.
  {
    name: "window.two",
    key: "<prefix>2",
    desc: "select 2",
    hidden: true,
    group: "windows",
    run: Effect.void,
  },
  // Two keys deep, so it must not show up until the leader has been pressed.
  { name: "app.deep", key: "<prefix>gg", desc: "deep", group: "global", run: Effect.void },
];

async function keymap() {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  return { t, keymap: createBindings(t.renderer, COMMANDS, { onUnhandled: () => true }) };
}

/** The compiled parts the pendingSequence event hands us, by display name. */
const seq = (...displays: string[]) => displays.map((display) => ({ display }));

test("nextKeys lists what a half-typed sequence can still become", async () => {
  const { keymap: km } = await keymap();
  const groups = nextKeys(km, COMMANDS, [], seq("<prefix>"));

  expect(groups.map((g) => g.group)).toEqual(["panes", "windows", "global"]);
  expect(groups[0]!.entries).toEqual([
    // Both sequences for one command collapse onto its single entry.
    { keys: ["|", "\\"], desc: "split" },
    { keys: ["z"], desc: "zoom" },
  ]);
  // The hidden sibling contributes nothing.
  expect(groups[1]!.entries).toEqual([{ keys: ["c"], desc: "new window" }]);
  expect(groups[2]!.entries).toEqual([{ keys: ["g"], desc: "deep" }]);
});

test("nextKeys narrows as the sequence advances, and collapses to the leader before it starts", async () => {
  const { keymap: km } = await keymap();

  // Every COMMANDS entry here is prefix-bound, so before the prefix is
  // pressed there is nothing to say per-command — only that the prefix
  // itself still reaches all of them, one collapsed entry rather than one
  // per command (bindings.ts's `prefixReachable`).
  expect(nextKeys(km, COMMANDS, [], [])).toEqual([
    { group: "", entries: [{ keys: ["^s"], desc: "mux prefix" }] },
  ]);
  // One key in on a two-key binding: only that branch survives.
  const deep = nextKeys(km, COMMANDS, [], seq("<prefix>", "g"));
  expect(deep).toEqual([{ group: "global", entries: [{ keys: ["g"], desc: "deep" }] }]);
});

test("which-key visibility transitions are deterministic for untriggered, disabled, immediate and delayed states", () => {
  expect(hintVisibility(false, true, 1)).toEqual({ visible: false, delayMs: 0 });
  expect(hintVisibility(true, false, 1)).toEqual({ visible: false, delayMs: 0 });
  expect(hintVisibility(true, true, 0)).toEqual({ visible: true, delayMs: 0 });
  expect(hintVisibility(true, true, 0.5)).toEqual({ visible: false, delayMs: 500 });
  // Delay ≥ timeoutlen → show immediately (panel would only flash otherwise).
  expect(hintVisibility(true, true, 2, 1000)).toEqual({ visible: true, delayMs: 0 });
  // Shorter delay keeps a reading margin before timeoutlen.
  expect(hintVisibility(true, true, 0.3, 1000)).toEqual({ visible: false, delayMs: 300 });
  expect(hintVisibility(true, true, 0.8, 1000)).toEqual({ visible: false, delayMs: 600 });
});

test("the panel draws the reachable keys under the sequence so far", async () => {
  const { t, keymap: km } = await keymap();
  const groups = nextKeys(km, COMMANDS, [], seq("<prefix>"));

  await render(
    () => <Hints groups={groups} pending="^a" left={0} width={80} height={20} />,
    t.renderer,
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();

  expect(frame).toContain("^a");
  expect(frame).toContain("panes");
  expect(frame).toContain("|·\\ split");
  expect(frame).toContain("z zoom");
  expect(frame).toContain("c new window");
});
