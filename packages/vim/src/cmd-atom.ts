/**
 * CmdAtom — structured, replayable user actions.
 *
 * Borrowed from Neovim's CmdAtom (PR 41297 / input_cmdatom_defs.h / :help
 * dev-cmdatom). Amux keeps atoms as pure values produced by the reducer —
 * not a port of nvim's bytes-layer typeahead.
 *
 * Multicursor: after the primary cursor settles `lastAtom`, {@link cascadeAtom}
 * replays it at each `extraCursors` entry (nvim `g_atoms` / clock-edge).
 * Undo amends the head node so one `u` reverts the whole cascade.
 */
import type { TextBuffer } from "@danielfgray/amux-text-buffer";
import type { Cursor, EditorState, UndoTree } from "./schema.ts";
import { encodeKey, type Key } from "./key.ts";

/** Subset of nvim CmdAtomType — enough for dot-repeat and cascade. */
export type CmdAtomType = "operator" | "insert" | "visual" | "motion" | "jump" | "ex" | "normal";

/**
 * Structured redo fields. Mirrors nvim CmdSpec lightly: register + count are
 * the functional prefix; `body` is the resolved keysequence without that
 * prefix (we store the full replay Keys on `CmdAtom.keys`).
 */
export type CmdSpec = {
  readonly register: string | null;
  readonly count: number;
  readonly body: string;
};

export type CmdAtom = {
  readonly type: CmdAtomType;
  /** Resolved keys for replay (includes count/register when recorded). */
  readonly keys: readonly Key[];
  readonly spec: CmdSpec;
  /** Cursor before the action — cascade / jump context. */
  readonly origin: Cursor;
  readonly changed: boolean;
};

const headGlyph = (key: Key): string | null => {
  if (key.ctrl || key.meta || key.option) return null;
  if (key.sequence.length === 1) return key.sequence;
  if (key.name.length === 1) {
    return key.shift && /[a-z]/.test(key.name) ? key.name.toUpperCase() : key.name;
  }
  return null;
};

export const atomTypeFromKeys = (keys: readonly Key[]): CmdAtomType => {
  const head = keys[0];
  if (head === undefined) return "operator";
  const ch = headGlyph(head);
  if (
    ch === "i" ||
    ch === "a" ||
    ch === "A" ||
    ch === "I" ||
    ch === "o" ||
    ch === "O" ||
    ch === "s" ||
    ch === "S" ||
    ch === "c" ||
    ch === "C"
  ) {
    return "insert";
  }
  if (ch === "v" || ch === "V") return "visual";
  return "operator";
};

const bodyOf = (keys: readonly Key[]): string => keys.map((key) => encodeKey(key) ?? "").join("");

export const atomFromKeys = (
  type: CmdAtomType,
  keys: readonly Key[],
  origin: Cursor,
  changed: boolean,
  register: string | null = null,
  count = 1,
): CmdAtom => ({
  type,
  keys,
  spec: {
    register,
    count,
    body: bodyOf(keys),
  },
  origin: { ...origin },
  changed,
});

/** Infer type from the recorded key list (dot-repeat settlement). */
export const atomFromRecording = (
  keys: readonly Key[],
  origin: Cursor,
  changed: boolean,
): CmdAtom => atomFromKeys(atomTypeFromKeys(keys), keys, origin, changed);

/**
 * Whether an atom should fan out to extra cursors.
 * Jumps/ex collapse every cursor onto one target in nvim — skip those.
 */
export const isCascadeable = (atom: CmdAtom): boolean =>
  atom.changed &&
  atom.keys.length > 0 &&
  atom.type !== "jump" &&
  atom.type !== "ex" &&
  atom.type !== "motion";

const sameCursor = (a: Cursor, b: Cursor): boolean => a.row === b.row && a.col === b.col;

/** Replace the undo head's buffer with the post-cascade document (one `u`). */
export const amendHeadBuffer = (tree: UndoTree, buffer: TextBuffer, cursor: Cursor): UndoTree => {
  const head = tree.nodes[tree.head];
  if (head === undefined) return tree;
  return {
    ...tree,
    nodes: {
      ...tree.nodes,
      [head.id]: { ...head, buffer, cursor: { ...cursor } },
    },
  };
};

export type ReduceKey = (state: EditorState, key: Key) => EditorState;

/**
 * Replay `atom` at each extra cursor on a state where the primary has already
 * applied it. Marks `cascading` so finishChange skips undo nodes / lastAtom.
 */
export function cascadeAtom(state: EditorState, atom: CmdAtom, reduceKey: ReduceKey): EditorState {
  if (!isCascadeable(atom) || state.extraCursors.length === 0) return state;

  const primary = { ...state.cursor };
  let current: EditorState = {
    ...state,
    cascading: true,
    repeating: true,
  };
  const nextExtras: Cursor[] = [];

  for (const cursor of state.extraCursors) {
    if (sameCursor(cursor, primary)) {
      nextExtras.push({ ...primary });
      continue;
    }
    current = { ...current, cursor: { ...cursor }, changeBase: null, recording: null };
    for (const key of atom.keys) {
      current = reduceKey(current, key);
    }
    nextExtras.push({ ...current.cursor });
  }

  return {
    ...current,
    cursor: primary,
    extraCursors: nextExtras,
    cascading: false,
    repeating: false,
    changeBase: null,
    recording: null,
    // Primary already committed an undo node; amend it to the cascaded buffer.
    undoTree: amendHeadBuffer(state.undoTree, current.buffer, primary),
    dirty: true,
  };
}

export const withExtraCursors = (state: EditorState, cursors: readonly Cursor[]): EditorState => ({
  ...state,
  extraCursors: cursors.map((cursor) => ({ ...cursor })),
});

export const clearExtraCursors = (state: EditorState): EditorState => ({
  ...state,
  extraCursors: [],
});

export const addExtraCursor = (state: EditorState, cursor: Cursor): EditorState => {
  if (state.extraCursors.some((c) => sameCursor(c, cursor))) return state;
  if (sameCursor(state.cursor, cursor)) return state;
  return { ...state, extraCursors: [...state.extraCursors, { ...cursor }] };
};
