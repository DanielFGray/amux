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
 *
 * Buffer body is a TextBuffer (SumTree), not Schema — see buffer-state.ts.
 */
import { Schema as S } from "effect";
import type { KeyEvent } from "@opentui/core";
import type { TextBuffer, TextEdit } from "@danielfgray/amux-text-buffer";
import type { CmdAtom } from "./cmd-atom.ts";
import type { ChangeList, JumpList } from "./jumps.ts";

export const EditorMode = S.Literals([
  "normal",
  "insert",
  "replace",
  "command",
  "visual",
  "search",
]);
export type EditorMode = S.Schema.Type<typeof EditorMode>;

export const Cursor = S.Struct({ row: S.Int, col: S.Int });
export type Cursor = S.Schema.Type<typeof Cursor>;

/** Undo snapshot — buffer refs are O(1) on a persistent SumTree. */
export type BufferSnapshot = {
  readonly buffer: TextBuffer;
  readonly cursor: Cursor;
};

/** One document state in the undo tree. */
export type UndoNode = {
  readonly id: number;
  readonly buffer: TextBuffer;
  readonly cursor: Cursor;
  readonly parentId: number | null;
  readonly childIds: readonly number[];
  /** Child `Ctrl-R` should follow (last undone, or newest edit). */
  readonly preferChildId: number | null;
  /** Chronological order for `g-` / `g+`. */
  readonly seq: number;
};

export type UndoTree = {
  readonly nodes: Readonly<Record<number, UndoNode>>;
  readonly head: number;
  readonly nextId: number;
  readonly nextSeq: number;
};

export const LastChange = S.Struct({ keys: S.Array(S.String) });
export type LastChange = S.Schema.Type<typeof LastChange>;

export const SearchDirection = S.Literals(["forward", "backward"]);
export type SearchDirection = S.Schema.Type<typeof SearchDirection>;

export const LastSearch = S.Struct({
  needle: S.String,
  direction: SearchDirection,
  /** `*`/`#` wrap with keyword bounds; `/` and `g*`/`g#` leave this false. */
  wholeWord: S.Boolean,
});
export type LastSearch = S.Schema.Type<typeof LastSearch>;

export const VisualKind = S.Literals(["char", "line"]);
export type VisualKind = S.Schema.Type<typeof VisualKind>;

export const VisualState = S.Struct({
  kind: VisualKind,
  anchor: Cursor,
});
export type VisualState = S.Schema.Type<typeof VisualState>;

/** Last visual selection for `gv` (anchor + exit cursor). */
export type LastVisual = {
  readonly kind: VisualKind;
  readonly anchor: Cursor;
  readonly cursor: Cursor;
};

/** Waiting for the replacement character after `r`. */
export const PendingReplace = S.Struct({ count: S.Int });
export type PendingReplace = S.Schema.Type<typeof PendingReplace>;

/** Waiting for the second `>` / `<` (line indent) or a motion. */
export const PendingIndent = S.Struct({
  dir: S.Literals([1, -1]),
  count: S.Int,
});
export type PendingIndent = S.Schema.Type<typeof PendingIndent>;

export type CaseKind = "toggle" | "lower" | "upper";

/** Waiting for a motion after `g~` / `gu` / `gU`. */
export type PendingCase = {
  readonly kind: CaseKind;
  readonly count: number;
};

/** Waiting for a motion after `=`, or `==` for the current line. */
export type PendingEqual = {
  readonly count: number;
};

export const OperatorKind = S.Literals(["delete", "change", "yank"]);
export type OperatorKind = S.Schema.Type<typeof OperatorKind>;

/** Neovim `oparg_T.motion_force`: force char / line / block after an operator. */
export type MotionForce = "v" | "V" | "block";

export type OperatorPending = {
  readonly kind: OperatorKind;
  readonly count: number;
  readonly textObject?: "inner" | "outer";
  readonly motionForce?: MotionForce | null;
};

/** vim-surround state: `ys`/`yss` wait for a motion then a char; `ds`/`cs` wait for targets.
 *  Tag target `t` collects a multi-char name until `>` / Enter (`phase: "tag"`). */
export const SurroundPending = S.Union([
  S.Struct({ mode: S.Literal("add"), phase: S.Literal("motion"), count: S.Int }),
  S.Struct({
    mode: S.Literal("add"),
    phase: S.Literal("motion"),
    count: S.Int,
    textObject: S.Literals(["inner", "outer"]),
  }),
  S.Struct({
    mode: S.Literal("add"),
    phase: S.Literal("char"),
    count: S.Int,
    from: Cursor,
    to: Cursor,
    linewise: S.Boolean,
    inclusive: S.Boolean,
  }),
  S.Struct({
    mode: S.Literal("add"),
    phase: S.Literal("tag"),
    count: S.Int,
    from: Cursor,
    to: Cursor,
    linewise: S.Boolean,
    inclusive: S.Boolean,
    name: S.String,
  }),
  S.Struct({ mode: S.Literal("delete") }),
  S.Struct({ mode: S.Literal("change"), phase: S.Literal("old") }),
  S.Struct({ mode: S.Literal("change"), phase: S.Literal("new"), old: S.String }),
  S.Struct({
    mode: S.Literal("change"),
    phase: S.Literal("tag"),
    old: S.Literal("t"),
    name: S.String,
  }),
]);
export type SurroundPending = S.Schema.Type<typeof SurroundPending>;

export const FindKind = S.Literals(["f", "F", "t", "T"]);
export type FindKind = S.Schema.Type<typeof FindKind>;

export const Viewport = S.Struct({ top: S.Int, height: S.Int });
export type Viewport = S.Schema.Type<typeof Viewport>;

export const Register = S.Struct({
  text: S.Array(S.String),
  linewise: S.Boolean,
});
export type Register = S.Schema.Type<typeof Register>;

/** Key input profile — vim modal vs CUA/modeless (ep-b64a91). */
export type EditorKeyProfile = "vim" | "cua";

/** `:set`-able options (checklist H / ties ts-ff924c settings UI). */
export type EditorOptions = {
  readonly tabstop: number;
  readonly expandtab: boolean;
  readonly number: boolean;
  readonly hlsearch: boolean;
  /** Which key profile owns input; settings `editor.keyProfile`. */
  readonly keyProfile: EditorKeyProfile;
};

export const EditorRequest = S.TaggedUnion({
  open: {
    path: S.String,
    /** Optional cursor after `:e` / LSP goto lands. */
    row: S.optional(S.Int),
    col: S.optional(S.Int),
  },
  write: {},
  close: {},
  "write-close": {},
  /** A user-registered ex command — the pane looks up `run` on the editor service. */
  invoke: {
    name: S.String,
    arg: S.String,
    bang: S.Boolean,
  },
  /**
   * Push text to the host clipboard via OSC 52 (`"+` / `"*`).
   * Fulfilled by the pane shell through `PaneViewProps.copyText`.
   */
  clipboard: {
    text: S.String,
    target: S.Literals(["clipboard", "primary"]),
  },
  /**
   * `:r path` — read file contents and insert after `afterRow` (0-based).
   * Address `0` → `afterRow: -1` (insert at the top). Fulfilled via EditorIo.read.
   */
  read: {
    path: S.String,
    afterRow: S.Int,
  },
  /**
   * `:r!{cmd}` — run a shell command and insert its stdout after `afterRow`.
   * Cite: vim `:r!`; workflow `:0r! curl -sL …`.
   */
  "shell-read": {
    cmd: S.String,
    afterRow: S.Int,
  },
});
export type EditorRequest = S.Schema.Type<typeof EditorRequest>;

/** Plain TS union — see the file's header note. */
export type EditorEvent =
  | { readonly _tag: "key"; readonly key: KeyEvent }
  | { readonly _tag: "command-complete"; readonly command: string }
  | {
      readonly _tag: "loaded";
      readonly file: string;
      readonly lines: readonly string[];
      /** Daemon store generation when opened through AMUX_SESSION. */
      readonly generation?: number;
    }
  | {
      readonly _tag: "remote";
      readonly lines: readonly string[];
      readonly generation: number;
      readonly dirty: boolean;
    }
  | { readonly _tag: "written" }
  | { readonly _tag: "write-error"; readonly message: string }
  /** Mouse wheel / programmatic viewport pan (does not record for `.`). */
  | { readonly _tag: "scroll"; readonly delta: number }
  /** LSP / tag jump — same-file moves the cursor; other files open then land. */
  | {
      readonly _tag: "goto";
      readonly path: string;
      readonly row: number;
      readonly col: number;
    };

/**
 * Editor algebra state. `buffer` / `pendingEdits` are plain TS — TextBuffer is
 * an opaque SumTree, not Schema-decodable.
 */
export type EditorState = {
  readonly mode: EditorMode;
  readonly buffer: TextBuffer;
  /** Edits since last successful document sync (keystroke flush). */
  readonly pendingEdits: readonly TextEdit[];
  readonly cursor: Cursor;
  /**
   * Preferred virtual (display-cell) column for `j`/`k` / half-page —
   * neovim `w_curswant`. `MAXCOL` (`motions.MAXCOL`) means "stick to EOL"
   * after `$`. Distinct from `cursor.col`, which is a UTF-16 string index.
   */
  readonly curswant: number;
  /**
   * When true, the next vertical motion syncs `curswant` from the cursor's
   * display column first — neovim `w_set_curswant`.
   */
  readonly setCurswant: boolean;
  /**
   * When true, refuse buffer mutations with E21 — vim `'nomodifiable'`.
   * Motions, search, visual, and yank still run. Cite: ep-7e80cc decision 5.
   */
  readonly nomodifiable: boolean;
  readonly command: string;
  readonly file: string | null;
  /** Daemon OpenDocumentStore generation; null for scratch / offline buffers. */
  readonly generation: number | null;
  readonly dirty: boolean;
  readonly message: string | null;
  readonly request: EditorRequest | null;
  readonly count: string;
  /** Waiting for the target character after `f`/`F`/`t`/`T`. */
  readonly pendingFind: { readonly kind: FindKind } | null;
  /** Last character-find, for `;` and `,`. */
  readonly lastFind: { readonly kind: FindKind; readonly char: string } | null;
  /** Visible window used by H/M/L and Ctrl-D/U. */
  readonly viewport: Viewport;
  readonly pending: OperatorPending | null;
  /** Armed `ys` / `ds` / `cs` sequence (tpope/vim-surround). */
  readonly pendingSurround: SurroundPending | null;
  readonly pendingReplace: PendingReplace | null;
  readonly pendingIndent: PendingIndent | null;
  /** Visual / CUA selection anchor. Vim: non-null iff `mode === "visual"`.
   *  CUA (`keyProfile === "cua"`): may be set while `mode === "insert"` for
   *  Shift-select; range is half-open [anchor, cursor) (or swapped). */
  readonly visual: VisualState | null;
  /** `/` / `?` direction while `mode === "search"`. */
  readonly searchDirection: SearchDirection;
  readonly lastSearch: LastSearch | null;
  /** Vim-style undo tree (branch-preserving); nodes hold TextBuffer refs. */
  readonly undoTree: UndoTree;
  /** Snapshot taken when the current change began; null when idle. */
  readonly changeBase: BufferSnapshot | null;
  /** Keys that constitute the in-flight change, for `.`. */
  readonly recording: readonly string[] | null;
  readonly lastChange: LastChange | null;
  /** True while `.` is replaying `lastChange` — don't overwrite it. */
  readonly repeating: boolean;
  /**
   * True while multicursor cascade is replaying `lastAtom` at extra cursors —
   * finishChange skips undo nodes / atom overwrite (amend happens after).
   */
  readonly cascading: boolean;
  readonly register: Register;
  /**
   * Named / numbered / special register bank (`a`–`z`, `0`–`9`, `.` `:` `/`
   * `+` `*`). Unnamed lives in `register`. Cite: vim registers.
   */
  readonly registers: Readonly<Record<string, Register>>;
  /**
   * Register selected by `"x` for the next yank/delete/put. Empty → unnamed.
   * Cleared when the op writes (or on black-hole write).
   */
  readonly selectedRegister: string;
  /**
   * Last settled user action as a CmdAtom (nvim CmdAtom / PR 41297).
   * `.` replays `lastAtom.keys`; multicursor cascade replays at `extraCursors`.
   */
  readonly lastAtom: CmdAtom | null;
  /**
   * Secondary cursors for CmdAtom cascade (nvim g_atoms / clock-edge).
   * Plain positions for now — extmarks when decoration seams exist.
   */
  readonly extraCursors: readonly Cursor[];
  /** Bumps when a content atom settles — emit seam for pane / `onAtom`. */
  readonly atomGeneration: number;
  /** Named marks `a`–`z` (local to this buffer). */
  readonly marks: Readonly<Record<string, Cursor>>;
  /** Positions left by far motions / mark jumps — Ctrl-o / Ctrl-i. */
  readonly jumpList: JumpList;
  /** Positions of nontrivial edits — g; / g,. */
  readonly changeList: ChangeList;
  /** Cursor where insert last left (for `gi`), before the normal-mode step-back. */
  readonly lastInsert: Cursor | null;
  /** Last visual selection for `gv`. */
  readonly lastVisual: LastVisual | null;
  /** Waiting for the mark name after `m`. */
  readonly pendingMark: boolean;
  /** Waiting for the mark name after `'` (linewise) or `` ` `` (exact). */
  readonly pendingJump: "'" | "`" | null;
  /** Armed `g~` / `gu` / `gU` awaiting a motion. */
  readonly pendingCase: PendingCase | null;
  /** Armed `=` awaiting a motion (or `==`). */
  readonly pendingEqual: PendingEqual | null;
  /** Insert: Ctrl-r waiting for a register name. */
  readonly pendingInsertReg: boolean;
  /**
   * Insert: Ctrl-o armed — one normal command, then return to insert.
   * Distinct from jumplist Ctrl-o (normal mode only).
   */
  readonly insertCtrlO: boolean;
  /** Text typed during the current insert — fed into register `".` on leave. */
  readonly insertAccum: string;
  /**
   * Named-register picker after `"`. Empty = idle; `REGISTER_PICKING` ("?")
   * while waiting for the name. Cite: registers.ts.
   */
  readonly pendingRegister: string;
  /** `q` waiting for the macro register name. */
  readonly pendingMacro: boolean;
  /** `@` waiting for the macro register name. */
  readonly pendingAt: boolean;
  /**
   * Macro tape register currently recording into — null when idle.
   * Separate from `recording` (the `.` change tape). Cite: checklist E.
   */
  readonly macroReg: string | null;
  /** Keys captured while `macroReg` is set. */
  readonly macroKeys: readonly string[];
  /** Stored macros keyed by register name (`a`–`z`). */
  readonly macros: Readonly<Record<string, readonly string[]>>;
  /** Last played macro register, for `@@`. */
  readonly lastMacro: string | null;
  /** True while `@` is replaying — blocks nested infinite `@` loops. */
  readonly replayingMacro: boolean;
  /** `:set` options — tabstop / expandtab / number / hlsearch. */
  readonly options: EditorOptions;
  /**
   * Whether the last search should be highlighted (`:noh` clears without
   * flipping `options.hlsearch`). Cite: vim :nohlsearch.
   */
  readonly searchHighlight: boolean;
  /** Previous `:` lines for Up/Down in command mode. */
  readonly commandHistory: readonly string[];
  /** Index into `commandHistory` while browsing; -1 when typing fresh. */
  readonly commandHistoryIdx: number;
};

/** The drainer fiber's mode. */
export const Phase = S.TaggedUnion({
  Ready: {},
  Io: {},
  Closed: {},
});
export type Phase = S.Schema.Type<typeof Phase>;
