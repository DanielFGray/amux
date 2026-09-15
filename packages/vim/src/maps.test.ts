import { expect, test } from "bun:test";
import {
  BUILTIN_MAP_ENTRIES,
  isMapPrefixStroke,
  mapContinuationHints,
  pushMap,
  strokeFromKey,
} from "./maps.ts";
import type { Key } from "./key.ts";

const key = (name: string, extra: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  meta: false,
  option: false,
  shift: false,
  sequence: name,
  ...extra,
});

test("g is a prefix because maps exist under it — not a hardcoded flag", () => {
  expect(isMapPrefixStroke(BUILTIN_MAP_ENTRIES, "normal", "g")).toBe(true);
  expect(isMapPrefixStroke(BUILTIN_MAP_ENTRIES, "normal", "z")).toBe(true);
  expect(isMapPrefixStroke(BUILTIN_MAP_ENTRIES, "normal", "h")).toBe(false);
  expect(isMapPrefixStroke(BUILTIN_MAP_ENTRIES, "operator", "g")).toBe(true);
  expect(isMapPrefixStroke(BUILTIN_MAP_ENTRIES, "operator", "z")).toBe(false);
});

test("pushMap pending → match for gg / zz", () => {
  expect(pushMap(BUILTIN_MAP_ENTRIES, "normal", [], "g")).toEqual({
    _tag: "pending",
    keys: ["g"],
  });
  const gg = pushMap(BUILTIN_MAP_ENTRIES, "normal", ["g"], "g");
  expect(gg._tag).toBe("matched");
  if (gg._tag === "matched") {
    expect(gg.entry).toEqual({
      _tag: "builtin",
      id: "gg",
      strokes: ["g", "g"],
      scopes: ["normal", "operator"],
    });
  }
  expect(pushMap(BUILTIN_MAP_ENTRIES, "normal", [], "z")).toEqual({
    _tag: "pending",
    keys: ["z"],
  });
});

test("operator scope excludes normal-only maps like gu / zz", () => {
  expect(pushMap(BUILTIN_MAP_ENTRIES, "operator", ["g"], "u")).toEqual({ _tag: "miss" });
  const ge = pushMap(BUILTIN_MAP_ENTRIES, "operator", ["g"], "e");
  expect(ge._tag).toBe("matched");
  expect(pushMap(BUILTIN_MAP_ENTRIES, "operator", [], "z")).toEqual({ _tag: "miss" });
});

test("strokeFromKey normalises shift+e to E", () => {
  expect(strokeFromKey(key("E"))).toBe("E");
  expect(strokeFromKey(key("e", { shift: true }))).toBe("E");
  expect(strokeFromKey(key("=", { shift: true }))).toBe("+");
});

test("mapContinuationHints lists command next keys only", () => {
  const maps = [
    ...BUILTIN_MAP_ENTRIES,
    {
      _tag: "command" as const,
      name: "lsp.references",
      strokes: ["g", "r", "r"],
      scopes: ["normal"] as const,
    },
  ];
  expect(
    mapContinuationHints(maps, ["g"], "normal", (name) =>
      name === "lsp.references" ? "LSP references" : undefined,
    ),
  ).toEqual([{ keys: ["r"], desc: "LSP references" }]);
});
