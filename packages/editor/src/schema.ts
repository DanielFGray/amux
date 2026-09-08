/**
 * Schema for the editor's data model.
 *
 * Most of the editor's data is a `Schema` value, with the reducer's types
 * derived from the schemas. `EditorEvent` is the one place we keep a plain
 * TS discriminated union: the `key` variant carries a `KeyEvent` from
 * `@opentui/core`, a third-party type the editor does not own. Forcing
 * it through `S.Any as S.Schema<KeyEvent>` would be a lie to the type
 * system. The reducer never decodes `EditorEvent` from JSON, so the union
 * is internal-only.
 *
 * `Phase` uses `Schema.TaggedUnion` — the only place in the repo we
 * diverge from the established `TaggedStruct` + `Union` pattern — because
 * the drainer wants an exhaustive `Phase.match` for free.
 */
import { Schema as S } from "effect";
import type { KeyEvent } from "@opentui/core";

export const EditorMode = S.Literals(["normal", "insert", "command"]);
export type EditorMode = S.Schema.Type<typeof EditorMode>;

export const Cursor = S.Struct({ row: S.Int, col: S.Int });
export type Cursor = S.Schema.Type<typeof Cursor>;

export const OperatorKind = S.Literals(["delete", "change", "yank"]);
export type OperatorKind = S.Schema.Type<typeof OperatorKind>;

export const OperatorPending = S.Union([
  S.Struct({ kind: OperatorKind, count: S.Int }),
  S.Struct({
    kind: OperatorKind,
    count: S.Int,
    textObject: S.Literals(["inner", "outer"]),
  }),
]);
export type OperatorPending = S.Schema.Type<typeof OperatorPending>;

export const Register = S.Struct({
  text: S.Array(S.String),
  linewise: S.Boolean,
});
export type Register = S.Schema.Type<typeof Register>;

export const EditorRequest = S.TaggedUnion({
  open: { path: S.String },
  write: {},
  close: {},
  "write-close": {},
});
export type EditorRequest = S.Schema.Type<typeof EditorRequest>;

/** Plain TS union — see the file's header note. */
export type EditorEvent =
  | { readonly _tag: "key"; readonly key: KeyEvent }
  | { readonly _tag: "loaded"; readonly file: string; readonly lines: readonly string[] }
  | { readonly _tag: "written" }
  | { readonly _tag: "write-error"; readonly message: string };

export const EditorState = S.Struct({
  mode: EditorMode,
  lines: S.Array(S.String),
  cursor: Cursor,
  command: S.String,
  file: S.NullOr(S.String),
  dirty: S.Boolean,
  message: S.NullOr(S.String),
  request: S.NullOr(EditorRequest),
  count: S.String,
  pendingG: S.Boolean,
  pending: S.NullOr(OperatorPending),
  register: Register,
});
export type EditorState = S.Schema.Type<typeof EditorState>;

/** The drainer fiber's mode. */
export const Phase = S.TaggedUnion({
  Ready: {},
  Io: {},
  Closed: {},
});
export type Phase = S.Schema.Type<typeof Phase>;
