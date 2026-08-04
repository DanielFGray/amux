import { expect, test } from "bun:test";
import {
  OPTIONS,
  adjustedValue,
  clearOption,
  coerceOption,
  formatOption,
  optionSections,
  optionSpec,
  optionsIn,
  resolveOptions,
  writeOption,
} from "./options.ts";

test("a hand-edited file cannot put a value into the app the UI would refuse", () => {
  const options = resolveOptions({
    "sidebar.width": 999,
    "behaviour.scrollRows": 2.7,
    "sidebar.open": "yes",
    "appearance.whichKeyDelay": null,
    "behaviour.shell": 42,
  });

  expect(options["sidebar.width"]).toBe(OPTIONS["sidebar.width"].max);
  expect(options["behaviour.scrollRows"]).toBe(2);
  // Wrong type is not clamped into range, it is not a value at all.
  expect(options["sidebar.open"]).toBe(OPTIONS["sidebar.open"].default);
  expect(options["appearance.whichKeyDelay"]).toBe(OPTIONS["appearance.whichKeyDelay"].default);
  expect(options["behaviour.shell"]).toBe(OPTIONS["behaviour.shell"].default);
});

test("resolve is total: every declared option comes back", () => {
  const options = resolveOptions({});
  for (const [name, spec] of Object.entries(OPTIONS)) {
    expect(options[name as keyof typeof OPTIONS]).toBe(spec.default);
  }
});

// The reason the store holds deltas: a file that pins every default freezes
// them at whatever they were the first time the user pressed save, and a later
// release changing a default then reaches nobody.
test("a value equal to the default is not stored at all", () => {
  const changed = writeOption({}, "sidebar.width", 42);
  expect(changed).toEqual({ "sidebar.width": 42 });

  const back = writeOption(changed, "sidebar.width", OPTIONS["sidebar.width"].default);
  expect(back).toEqual({});
  expect(resolveOptions(back)["sidebar.width"]).toBe(OPTIONS["sidebar.width"].default);
});

test("entries belonging to names this build does not declare are left alone", () => {
  const stored = { "clock.format": "%H:%M", "sidebar.width": 42 };
  expect(writeOption(stored, "sidebar.width", 20)["clock.format"]).toBe("%H:%M");
  expect(clearOption(stored, "sidebar.width")).toEqual({ "clock.format": "%H:%M" });
});

test("reset drops the entry rather than storing the default", () => {
  expect(clearOption({ "sidebar.width": 42 }, "sidebar.width")).toEqual({});
});

test("a relative edit clamps, and a boolean flips whichever way it is pushed", () => {
  const width = OPTIONS["sidebar.width"];
  expect(adjustedValue(width, 30, 1)).toBe(31);
  expect(adjustedValue(width, width.max, 1)).toBe(width.max);
  expect(adjustedValue(width, width.min, -1)).toBe(width.min);

  // ←/→ has to mean something on every row, so the table answers for booleans
  // instead of the settings window branching on the kind.
  expect(adjustedValue(OPTIONS["sidebar.open"], true, 1)).toBe(false);
  expect(adjustedValue(OPTIONS["sidebar.open"], true, -1)).toBe(false);
  expect(adjustedValue(OPTIONS["behaviour.shell"], "zsh", 1)).toBe("zsh");
});

test("coerce refuses rather than inventing a value", () => {
  expect(coerceOption(OPTIONS["sidebar.width"], "30")).toBeUndefined();
  expect(coerceOption(OPTIONS["sidebar.open"], 1)).toBeUndefined();
  expect(coerceOption(OPTIONS["behaviour.shell"], null)).toBeUndefined();
  expect(coerceOption(OPTIONS["sidebar.width"], 999)).toBe(OPTIONS["sidebar.width"].max);
});

test("an unknown name has no declaration to act on", () => {
  expect(optionSpec("sidebar.width")).toBe(OPTIONS["sidebar.width"]);
  expect(optionSpec("sidebar.nonesuch")).toBeUndefined();
  expect(optionSpec("toString")).toBeUndefined();
});

test("sections are the name prefixes, so declaring an option places its row", () => {
  expect(optionSections).toEqual(["sidebar", "appearance", "behaviour"]);
  expect(optionsIn("sidebar")).toEqual(["sidebar.open", "sidebar.width", "sidebar.agentsOnly"]);
  expect(optionsIn("nonesuch")).toEqual([]);
});

test("values read as something a person can act on", () => {
  expect(formatOption(OPTIONS["sidebar.open"], true)).toBe("yes");
  expect(formatOption(OPTIONS["sidebar.width"], 30)).toBe("30");
  expect(formatOption(OPTIONS["behaviour.shell"], "")).toBe("unset");
  expect(formatOption(OPTIONS["behaviour.shell"], "/bin/fish")).toBe("/bin/fish");
});
