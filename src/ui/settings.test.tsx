/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { optionsIn, resolveOptions, type OptionSpec } from "../options.ts";
import type { Contribution } from "../plugin/contributions.ts";
import type { HelpGroup } from "../bindings.ts";
import {
  Settings,
  keybindGroups,
  keybindLine,
  keybindTargets,
  settingsFields,
  settingsSections,
} from "./Settings.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const GROUPS: HelpGroup[] = [
  {
    group: "panes",
    entries: [
      { name: "pane.zoom", keys: "^a z", desc: "zoom", custom: false, fixed: false },
      { name: "pane.close", keys: "^a x", desc: "close pane", custom: true, fixed: false },
      { name: "pane.send-keys", keys: "unbound", desc: "send keys", custom: false, fixed: false },
    ],
  },
  {
    group: "global",
    entries: [
      { name: "app.quit", keys: "^a q", desc: "quit", custom: false, fixed: false },
      // Not rebindable, so it takes no selection index of its own.
      { name: "app.send-prefix", keys: "^a ^a", desc: "send prefix", custom: false, fixed: true },
    ],
  },
];

/**
 * The prefix is a row like any other, and a fixed command is not.
 *
 * Row 0 being the prefix is what lets one list teach the whole keymap: the key
 * every other binding starts with is edited in the same place as the bindings
 * themselves.
 */
test("the editor enumerates the prefix and every rebindable command", () => {
  expect(keybindTargets(GROUPS)).toEqual([null, "pane.zoom", "pane.close", "app.quit"]);
});

test("the editor hides unbound actions from the keybind list", () => {
  const rows = keybindGroups(GROUPS, "ctrl+a");

  expect(rows[1]!.entries.map((entry) => entry.name)).toEqual(["pane.zoom", "pane.close"]);
  expect(keybindTargets(GROUPS)).not.toContain("pane.send-keys");
});

/** The index the key handler acts on and the row drawn on screen are the same
 *  row — which only holds if both count from one enumeration. */
test("rows carry the selection index they are drawn at", () => {
  const rows = keybindGroups(GROUPS, "ctrl+a");

  expect(rows.map((g) => g.group)).toEqual(["prefix", "panes", "global"]);
  expect(rows[0]!.entries[0]).toMatchObject({ index: 0, keys: "^a", name: null });
  expect(rows[1]!.entries.map((e) => e.index)).toEqual([1, 2]);
  // The fixed row is drawn but cannot be landed on.
  expect(rows[2]!.entries.map((e) => e.index)).toEqual([3, null]);
});

/**
 * The list is longer than the window, so the caller scrolls it — and can only
 * do that if a selection index maps to the line it was drawn on. Group
 * headings and the blank line between groups both count.
 */
test("a selection index maps to its line in the scrolled list", () => {
  // prefix heading, prefix row, blank, panes heading, zoom, close, blank...
  expect(keybindLine(GROUPS, 0)).toBe(1);
  expect(keybindLine(GROUPS, 1)).toBe(4);
  expect(keybindLine(GROUPS, 2)).toBe(5);
  expect(keybindLine(GROUPS, 3)).toBe(8);
});

test("gap setting explains separated borders", () => {
  const field = settingsFields(resolveOptions({}), "appearance")[0]!;
  expect(field.hint).toContain("separate pane borders");
});

// The row is a projection of the table, so a section holds exactly the options
// declared into it, in declaration order, and nothing has to be added here when
// one is added there.
test("a section's rows are its options, named as config.set takes them", () => {
  const fields = settingsFields(
    resolveOptions({ "appearance.whichKeyHints": false, "appearance.whichKeyDelay": 1 }),
    "appearance",
  );
  expect(fields.map((field) => field.name)).toEqual(optionsIn("appearance"));
  expect(fields.map((field) => field.label)).toEqual([
    "gap",
    "outerBorder",
    "padding",
    "whichKeyHints",
    "whichKeyDelay",
  ]);
  expect(fields.map((field) => field.value)).toEqual(["no", "yes", "no", "no", "1"]);
});

test("the shell setting is displayed as intentionally read-only", () => {
  const shell = settingsFields(resolveOptions({ "behaviour.shell": "/bin/fish" }), "behaviour")[1]!;

  expect(shell.value).toBe("/bin/fish");
  expect(shell.hint).toContain("read-only");
  expect(shell.hint).toContain("new agents");
});

/** A plugin option contribution, the shape `optionContributions.all()` hands
 *  the settings window in the running app. */
function pluginOption(name: string, spec: OptionSpec): Contribution<OptionSpec> {
  return { owner: { id: "test.plugin", generation: 0 }, name, value: spec };
}

// A plugin-registered option is not in the closed OPTIONS table, so it has no
// section of its own until one is derived from its dotted name — the same
// rule a core option's section comes from.
test("a plugin-registered option gets its own settings tab", () => {
  const entry = pluginOption("harness.temperature", {
    kind: "number",
    default: 1,
    min: 0,
    max: 2,
    desc: "sampling temperature",
  });
  expect(settingsSections([], [entry])).toContain("harness");
});

test("a plugin-registered option renders alongside the core options in its section", () => {
  const entry = pluginOption("appearance.reverseVideo", {
    kind: "boolean",
    default: false,
    desc: "invert the palette",
  });
  const fields = settingsFields(resolveOptions({}), "appearance", [entry]);

  expect(fields.map((field) => field.name)).toEqual([
    ...optionsIn("appearance"),
    "appearance.reverseVideo",
  ]);
  const plugin = fields.at(-1)!;
  expect(plugin.label).toBe("reverseVideo");
  expect(plugin.hint).toContain("invert the palette");
  expect(plugin.value).toBe("no");
});

test("a plugin option's stored value renders the same way a core option's does", () => {
  const entry = pluginOption("harness.temperature", {
    kind: "number",
    default: 1,
    min: 0,
    max: 2,
    desc: "sampling temperature",
  });
  const options = { ...resolveOptions({}), "harness.temperature": 1.5 };
  const fields = settingsFields(options, "harness", [entry]);

  expect(fields).toEqual([
    {
      name: "harness.temperature",
      label: "temperature",
      value: "1.5",
      raw: 1.5,
      kind: "number",
      hint: "sampling temperature · enter edits",
    },
  ]);
});

async function draw(over: Partial<Parameters<typeof Settings>[0]> = {}) {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  await render(
    () => (
      <Settings
        options={resolveOptions({})}
        section="keybinds"
        selected={0}
        groups={GROUPS}
        leader="ctrl+a"
        conflicts={[]}
        capturing={false}
        width={80}
        height={20}
        dirty={false}
        focus="items"
        onEditInput={() => {}}
        onEditSubmit={() => {}}
        {...over}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();
  return t.captureCharFrame();
}

test("the keybinds tab lists the prefix alongside the commands it prefixes", async () => {
  const frame = await draw();

  expect(frame).toContain("prefix");
  expect(frame).toContain("^a z");
  expect(frame).toContain("zoom");
  // A rebound command is marked as no longer the default.
  expect(frame).toContain("close pane *");
});

test("a rebound prefix is what the whole list reads as", async () => {
  const frame = await draw({ leader: "ctrl+b" });

  // The prefix row shows the new key; the commands keep whatever the keymap
  // handed back, which is the same list re-read after the rebuild.
  expect(frame).toContain("^b");
});

test("the row being recorded says so, in place of its keys", async () => {
  const frame = await draw({ capturing: true, selected: 1 });

  expect(frame).toContain("press a key…");
  expect(frame).toContain("esc cancels");
  // Only the selected row is in capture; the others still show their keys.
  expect(frame).toContain("^a q");
});

/** A collision leaves one of the two commands dead. Saying so beats the crash
 *  this used to be, now that a user can cause one. */
test("a conflict is reported rather than hidden", async () => {
  const frame = await draw({
    conflicts: [{ sequence: "^a k", commands: ["pane.focus-up", "agent.kill"] }],
  });

  expect(frame).toContain("^a k");
  expect(frame).toContain("agent.kill");
});

test("a failed settings save is visible while the dirty marker remains", async () => {
  const frame = await draw({
    dirty: true,
    error: "could not save settings: permission denied",
  });

  expect(frame).toContain("could not save settings");
  expect(frame).toContain("permission denied");
  expect(frame).toContain("unsaved");
});
