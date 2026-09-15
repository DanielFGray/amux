/**
 * Builtin and plugin multi-key maps (`gg`, `grr`, `zz`, …). Live wait lives in
 * reduceEditor as {@link EditorState.pendingMap} against {@link EditorState.maps}
 * — same grammar role as operators and `f{char}`. Not mux keymap sequences:
 * pane-history can feed the engine with no editor plugin loaded.
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

/** Where a map is active. */
export type MapScope = "normal" | "operator";

/**
 * One map the engine can match. Builtin ids run {@link runBuiltinMap}; command
 * names set an EditorRequest the plugin fulfills via the registered CommandSpec.
 */
export type MapEntry =
  | {
      readonly _tag: "builtin";
      readonly id: BuiltinMapId;
      readonly strokes: readonly string[];
      readonly scopes: readonly MapScope[];
    }
  | {
      readonly _tag: "command";
      readonly name: string;
      readonly strokes: readonly string[];
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

/** Builtin table as {@link MapEntry} rows for {@link EditorState.maps}. */
export const BUILTIN_MAP_ENTRIES: readonly MapEntry[] = [
  { _tag: "builtin", id: "gg", strokes: ["g", "g"], scopes: ["normal", "operator"] },
  { _tag: "builtin", id: "ge", strokes: ["g", "e"], scopes: ["normal", "operator"] },
  { _tag: "builtin", id: "gE", strokes: ["g", "E"], scopes: ["normal", "operator"] },
  { _tag: "builtin", id: "g-", strokes: ["g", "-"], scopes: ["normal"] },
  { _tag: "builtin", id: "g+", strokes: ["g", "+"], scopes: ["normal"] },
  { _tag: "builtin", id: "g;", strokes: ["g", ";"], scopes: ["normal"] },
  { _tag: "builtin", id: "g,", strokes: ["g", ","], scopes: ["normal"] },
  { _tag: "builtin", id: "gv", strokes: ["g", "v"], scopes: ["normal"] },
  { _tag: "builtin", id: "gi", strokes: ["g", "i"], scopes: ["normal"] },
  { _tag: "builtin", id: "gu", strokes: ["g", "u"], scopes: ["normal"] },
  { _tag: "builtin", id: "gU", strokes: ["g", "U"], scopes: ["normal"] },
  { _tag: "builtin", id: "g~", strokes: ["g", "~"], scopes: ["normal"] },
  { _tag: "builtin", id: "g*", strokes: ["g", "*"], scopes: ["normal"] },
  { _tag: "builtin", id: "g#", strokes: ["g", "#"], scopes: ["normal"] },
  { _tag: "builtin", id: "zz", strokes: ["z", "z"], scopes: ["normal"] },
  { _tag: "builtin", id: "zt", strokes: ["z", "t"], scopes: ["normal"] },
  { _tag: "builtin", id: "zb", strokes: ["z", "b"], scopes: ["normal"] },
];

export type MapPushResult =
  | { readonly _tag: "pending"; readonly keys: readonly string[] }
  | { readonly _tag: "matched"; readonly entry: MapEntry; readonly keys: readonly string[] }
  | { readonly _tag: "miss" };

const strokesEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((stroke, i) => stroke === b[i]);

const isStrictPrefix = (prefix: readonly string[], full: readonly string[]): boolean =>
  prefix.length < full.length && prefix.every((stroke, i) => stroke === full[i]);

const mapsInScope = (maps: readonly MapEntry[], scope: MapScope): readonly MapEntry[] =>
  maps.filter((entry) => entry.scopes.includes(scope));

/** Push one stroke against a map table for `scope`. */
export const pushMap = (
  maps: readonly MapEntry[],
  scope: MapScope,
  pending: readonly string[],
  stroke: string,
): MapPushResult => {
  if (stroke.length === 0 || stroke === "escape") return { _tag: "miss" };
  const active = mapsInScope(maps, scope);
  const candidate = [...pending, stroke];
  const longer = active.some((entry) => isStrictPrefix(candidate, entry.strokes));
  const exact = active.find((entry) => strokesEqual(candidate, entry.strokes));
  if (longer) return { _tag: "pending", keys: candidate };
  if (exact) return { _tag: "matched", entry: exact, keys: candidate };
  return { _tag: "miss" };
};

/** True when `stroke` alone is a strict prefix of some map in scope. */
export const isMapPrefixStroke = (
  maps: readonly MapEntry[],
  scope: MapScope,
  stroke: string,
): boolean =>
  mapsInScope(maps, scope).some((entry) => entry.strokes[0] === stroke && entry.strokes.length > 1);

/** Next-key which-key rows for a pending map prefix (command entries only). */
export const mapContinuationHints = (
  maps: readonly MapEntry[],
  pending: readonly string[],
  scope: MapScope,
  descOf: (name: string) => string | undefined,
): readonly { keys: string[]; desc: string }[] => {
  const out: { keys: string[]; desc: string }[] = [];
  for (const entry of mapsInScope(maps, scope)) {
    if (entry.strokes.length <= pending.length) continue;
    if (pending.some((stroke, i) => entry.strokes[i] !== stroke)) continue;
    const next = entry.strokes[pending.length];
    if (next === undefined) continue;
    if (entry._tag === "builtin") continue;
    const desc = descOf(entry.name);
    if (desc === undefined) continue;
    const existing = out.find((row) => row.desc === desc);
    if (existing) {
      if (!existing.keys.includes(next)) existing.keys.push(next);
    } else {
      out.push({ keys: [next], desc });
    }
  }
  return out;
};
