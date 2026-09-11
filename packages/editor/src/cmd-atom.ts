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

/** Subset of nvim CmdAtomType — enough for dot-repeat and cascade. */
export type CmdAtomType = "operator" | "insert" | "visual" | "motion" | "jump" | "ex" | "normal";

/**
 * Structured redo fields. Mirrors nvim CmdSpec lightly: register + count are
 * the functional prefix; `body` is the resolved keysequence without that
 * prefix (we store the full replay string on `CmdAtom.keys`).
 */
export type CmdSpec = {
  readonly register: string | null;
  readonly count: number;
  readonly body: string;
};

export type CmdAtom = {
  readonly type: CmdAtomType;
  /** Resolved keysequence for replay (includes count/register when recorded). */
  readonly keys: readonly string[];
  readonly spec: CmdSpec;
  /** Cursor before the action — cascade / jump context. */
  readonly origin: Cursor;
  readonly changed: boolean;
};

export const atomTypeFromKeys = (keys: readonly string[]): CmdAtomType => {
  const head = keys[0];
  if (
    head === "i" ||
    head === "a" ||
    head === "A" ||
    head === "I" ||
    head === "o" ||
    head === "O" ||
    head === "s" ||
    head === "S" ||
    head === "c" ||
    head === "C"
  ) {
    return "insert";
  }
  if (head === "v" || head === "V") return "visual";
  return "operator";
};

export const atomFromKeys = (
  type: CmdAtomType,
  keys: readonly string[],
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
    body: keys.join(""),
  },
  origin: { ...origin },
  changed,
});

/** Infer type from the recorded key list (dot-repeat settlement). */
export const atomFromRecording = (
  keys: readonly string[],
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

export type ReduceKey = (state: EditorState, keyName: string) => EditorState;

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
    for (const name of atom.keys) {
      current = reduceKey(current, name);
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
