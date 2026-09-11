import { expect, test } from "bun:test";
import { isMapPrefixStroke, pushBuiltinMap, strokeFromKey } from "./maps.ts";
import type { KeyEvent } from "@opentui/core";

const key = (name: string, extra: Partial<KeyEvent> = {}): KeyEvent =>
  ({
    name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    sequence: name,
    ...extra,
  }) as KeyEvent;

test("g is a prefix because maps exist under it — not a hardcoded flag", () => {
  expect(isMapPrefixStroke("normal", "g")).toBe(true);
  expect(isMapPrefixStroke("normal", "z")).toBe(true);
  expect(isMapPrefixStroke("normal", "h")).toBe(false);
  expect(isMapPrefixStroke("operator", "g")).toBe(true);
  expect(isMapPrefixStroke("operator", "z")).toBe(false);
});

test("pushBuiltinMap pending → match for gg / zz", () => {
  expect(pushBuiltinMap("normal", [], "g")).toEqual({ _tag: "pending", keys: ["g"] });
  expect(pushBuiltinMap("normal", ["g"], "g")).toEqual({
    _tag: "matched",
    id: "gg",
    keys: ["g", "g"],
  });
  expect(pushBuiltinMap("normal", ["g"], "*")).toEqual({
    _tag: "matched",
    id: "g*",
    keys: ["g", "*"],
  });
  expect(pushBuiltinMap("normal", [], "z")).toEqual({ _tag: "pending", keys: ["z"] });
  expect(pushBuiltinMap("normal", ["z"], "z")).toEqual({
    _tag: "matched",
    id: "zz",
    keys: ["z", "z"],
  });
});

test("operator scope excludes normal-only maps like gu / zz", () => {
  expect(pushBuiltinMap("operator", ["g"], "u")).toEqual({ _tag: "miss" });
  expect(pushBuiltinMap("operator", ["g"], "e")).toEqual({
    _tag: "matched",
    id: "ge",
    keys: ["g", "e"],
  });
  expect(pushBuiltinMap("operator", [], "z")).toEqual({ _tag: "miss" });
});

test("strokeFromKey normalises shift+e to E", () => {
  expect(strokeFromKey(key("E"))).toBe("E");
  expect(strokeFromKey(key("e", { shift: true }))).toBe("E");
  expect(strokeFromKey(key("=", { shift: true }))).toBe("+");
});
