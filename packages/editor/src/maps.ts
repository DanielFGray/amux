/**
 * Builtin multi-key maps. Live prefix-wait is {@link ChordMatcher} via
 * CommandSpec → syncCommandChords (one trie). This module stays the pure
 * trie for tests / documentation — not a second pending buffer in
 * EditorState. Cite: chord-matcher.ts; ts-b36737.
 */
import type { KeyEvent } from "@opentui/core";

export type BuiltinMapId =
  | "gg"
  | "ge"
  | "gE"
  | "g-"
  | "g+"
  | "g;"
  | "g,"
  | "gv"
  | "gi"
  | "gu"
  | "gU"
  | "g~"
  | "g*"
  | "g#"
  | "zz"
  | "zt"
  | "zb";

/** Where a builtin map is active. */
export type MapScope = "normal" | "operator";

export type BuiltinMap = {
  readonly id: BuiltinMapId;
  /** Canonical strokes for the algebra trie (`typeKeys` / reduceEditor). */
  readonly strokes: readonly string[];
  /**
   * Binding-layer strokes for `Bindings.chords` (may use `shift+e` where the
   * algebra uses `E`). Same `id` — one handler.
   */
  readonly bindingStrokes: readonly string[];
  readonly scopes: readonly MapScope[];
};

/**
 * Normalize a key to a map stroke. Printable letters honour shift as uppercase
 * so `E` and shift+e both encode as `E` (gE).
 */
export const strokeFromKey = (key: KeyEvent): string | null => {
  if (key.ctrl || key.meta || key.option) return null;
  if (key.name === "escape") return "escape";
  if (key.sequence === "*" || (key.shift && key.name === "8")) return "*";
  if (key.sequence === "#" || (key.shift && key.name === "3")) return "#";
  if (key.name.length === 1) {
    if (key.shift && key.name === "=") return "+";
    if (/[a-z]/.test(key.name) && key.shift) return key.name.toUpperCase();
    return key.name;
  }
  if (key.shift && key.name === "e") return "E";
  if (key.shift && key.name === "u") return "U";
  if (key.shift && key.name === "=") return "+";
  if (key.name === "return" || key.name === "enter") return "enter";
  return key.name;
};

export const BUILTIN_MAPS: readonly BuiltinMap[] = [
  { id: "gg", strokes: ["g", "g"], bindingStrokes: ["g", "g"], scopes: ["normal", "operator"] },
  { id: "ge", strokes: ["g", "e"], bindingStrokes: ["g", "e"], scopes: ["normal", "operator"] },
  {
    id: "gE",
    strokes: ["g", "E"],
    bindingStrokes: ["g", "shift+e"],
    scopes: ["normal", "operator"],
  },
  { id: "g-", strokes: ["g", "-"], bindingStrokes: ["g", "-"], scopes: ["normal"] },
  { id: "g+", strokes: ["g", "+"], bindingStrokes: ["g", "+"], scopes: ["normal"] },
  { id: "g;", strokes: ["g", ";"], bindingStrokes: ["g", ";"], scopes: ["normal"] },
  { id: "g,", strokes: ["g", ","], bindingStrokes: ["g", ","], scopes: ["normal"] },
  { id: "gv", strokes: ["g", "v"], bindingStrokes: ["g", "v"], scopes: ["normal"] },
  { id: "gi", strokes: ["g", "i"], bindingStrokes: ["g", "i"], scopes: ["normal"] },
  { id: "gu", strokes: ["g", "u"], bindingStrokes: ["g", "u"], scopes: ["normal"] },
  { id: "gU", strokes: ["g", "U"], bindingStrokes: ["g", "shift+u"], scopes: ["normal"] },
  { id: "g~", strokes: ["g", "~"], bindingStrokes: ["g", "~"], scopes: ["normal"] },
  { id: "g*", strokes: ["g", "*"], bindingStrokes: ["g", "*"], scopes: ["normal"] },
  { id: "g#", strokes: ["g", "#"], bindingStrokes: ["g", "#"], scopes: ["normal"] },
  { id: "zz", strokes: ["z", "z"], bindingStrokes: ["z", "z"], scopes: ["normal"] },
  { id: "zt", strokes: ["z", "t"], bindingStrokes: ["z", "t"], scopes: ["normal"] },
  { id: "zb", strokes: ["z", "b"], bindingStrokes: ["z", "b"], scopes: ["normal"] },
];

export type MapPushResult =
  | { readonly _tag: "pending"; readonly keys: readonly string[] }
  | { readonly _tag: "matched"; readonly id: BuiltinMapId; readonly keys: readonly string[] }
  | { readonly _tag: "miss" };

const strokesEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((stroke, i) => stroke === b[i]);

const isStrictPrefix = (prefix: readonly string[], full: readonly string[]): boolean =>
  prefix.length < full.length && prefix.every((stroke, i) => stroke === full[i]);

const mapsInScope = (scope: MapScope): readonly BuiltinMap[] =>
  BUILTIN_MAPS.filter((entry) => entry.scopes.includes(scope));

/** Push one stroke against the builtin trie for `scope`. */
export const pushBuiltinMap = (
  scope: MapScope,
  pending: readonly string[],
  stroke: string,
): MapPushResult => {
  if (stroke.length === 0 || stroke === "escape") return { _tag: "miss" };
  const maps = mapsInScope(scope);
  const candidate = [...pending, stroke];
  const longer = maps.some((entry) => isStrictPrefix(candidate, entry.strokes));
  const exact = maps.find((entry) => strokesEqual(candidate, entry.strokes));
  if (longer) return { _tag: "pending", keys: candidate };
  if (exact) return { _tag: "matched", id: exact.id, keys: candidate };
  return { _tag: "miss" };
};

/** True when `stroke` alone is a strict prefix of some map in scope. */
export const isMapPrefixStroke = (scope: MapScope, stroke: string): boolean =>
  mapsInScope(scope).some((entry) => entry.strokes[0] === stroke && entry.strokes.length > 1);
