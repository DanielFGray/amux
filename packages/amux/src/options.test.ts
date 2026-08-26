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
    "behaviour.scrollRows": 999,
    "appearance.whichKeyDelay": 2.7,
    "appearance.outerBorder": "yes",
    "behaviour.shell": 42,
  });

  expect(options["behaviour.scrollRows"]).toBe(OPTIONS["behaviour.scrollRows"].max);
  expect(options["appearance.whichKeyDelay"]).toBe(2);
  // Wrong type is not clamped into range, it is not a value at all.
  expect(options["appearance.outerBorder"]).toBe(OPTIONS["appearance.outerBorder"].default);
  expect(options["behaviour.shell"]).toBe(OPTIONS["behaviour.shell"].default);
});

test("resolve is total: every declared option comes back", () => {
  const options = resolveOptions({});
  expect(Object.keys(OPTIONS).length).toBeGreaterThan(0);
  for (const [name, spec] of Object.entries(OPTIONS)) {
    expect(options[name as keyof typeof OPTIONS]).toBe(spec.default);
  }
});

// The reason the store holds deltas: a file that pins every default freezes
// them at whatever they were the first time the user pressed save, and a later
// release changing a default then reaches nobody.
test("a value equal to the default is not stored at all", () => {
  const changed = writeOption({}, "behaviour.scrollRows", OPTIONS["behaviour.scrollRows"], 10);
  expect(changed).toEqual({ "behaviour.scrollRows": 10 });

  const back = writeOption(
    changed,
    "behaviour.scrollRows",
    OPTIONS["behaviour.scrollRows"],
    OPTIONS["behaviour.scrollRows"].default,
  );
  expect(back).toEqual({});
  expect(resolveOptions(back)["behaviour.scrollRows"]).toBe(
    OPTIONS["behaviour.scrollRows"].default,
  );
});

test("entries belonging to names this build does not declare are left alone", () => {
  const stored = { "clock.format": "%H:%M", "behaviour.scrollRows": 10 };
  expect(
    writeOption(stored, "behaviour.scrollRows", OPTIONS["behaviour.scrollRows"], 5)["clock.format"],
  ).toBe("%H:%M");
  expect(clearOption(stored, "behaviour.scrollRows")).toEqual({
    "clock.format": "%H:%M",
  });
});

test("reset drops the entry rather than storing the default", () => {
  expect(clearOption({ "behaviour.scrollRows": 10 }, "behaviour.scrollRows")).toEqual({});
});

test("a relative edit clamps, and a boolean flips whichever way it is pushed", () => {
  const rows = OPTIONS["behaviour.scrollRows"];
  expect(adjustedValue(rows, 3, 1)).toBe(4);
  expect(adjustedValue(rows, rows.max, 1)).toBe(rows.max);
  expect(adjustedValue(rows, rows.min, -1)).toBe(rows.min);

  // ←/→ has to mean something on every row, so the table answers for booleans
  // instead of the settings window branching on the kind.
  expect(adjustedValue(OPTIONS["appearance.outerBorder"], true, 1)).toBe(false);
  expect(adjustedValue(OPTIONS["appearance.outerBorder"], true, -1)).toBe(false);
  expect(adjustedValue(OPTIONS["behaviour.shell"], "zsh", 1)).toBe("zsh");
});

test("coerce refuses rather than inventing a value", () => {
  expect(coerceOption(OPTIONS["behaviour.scrollRows"], "3")).toBeUndefined();
  expect(coerceOption(OPTIONS["appearance.outerBorder"], 1)).toBeUndefined();
  expect(coerceOption(OPTIONS["behaviour.shell"], null)).toBeUndefined();
  expect(coerceOption(OPTIONS["behaviour.scrollRows"], 999)).toBe(
    OPTIONS["behaviour.scrollRows"].max,
  );
});

test("an unknown name has no declaration to act on", () => {
  expect(optionSpec("behaviour.scrollRows")).toBe(OPTIONS["behaviour.scrollRows"]);
  expect(optionSpec("behaviour.nonesuch")).toBeUndefined();
  expect(optionSpec("toString")).toBeUndefined();
});

test("sections are the name prefixes, so declaring an option places its row", () => {
  expect(optionSections).toEqual(["window", "status", "appearance", "behaviour"]);
  expect(optionsIn("appearance")).toEqual([
    "appearance.gap",
    "appearance.outerBorder",
    "appearance.padding",
    "appearance.whichKeyHints",
    "appearance.whichKeyDelay",
  ]);
  expect(optionsIn("nonesuch")).toEqual([]);
});

test("values read as something a person can act on", () => {
  expect(formatOption(OPTIONS["appearance.outerBorder"], true)).toBe("yes");
  expect(formatOption(OPTIONS["behaviour.scrollRows"], 3)).toBe("3");
  expect(formatOption(OPTIONS["behaviour.shell"], "")).toBe("unset");
  expect(formatOption(OPTIONS["behaviour.shell"], "/bin/fish")).toBe("/bin/fish");
});
