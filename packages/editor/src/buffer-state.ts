/**
 * EditorState ↔ TextBuffer helpers.
 *
 * Cite: packages/text-buffer/src/buffer.ts — applyEdit / replaceLines /
 * sliceLines / fromLines / fromText / toText / lineCount / lineAt.
 * The editor never keeps a parallel string[] cache; derive lines on demand.
 */
import { Option } from "effect";
import {
  applyEdit,
  empty,
  fromLines,
  fromText,
  lineAt,
  lineCount,
  replaceLines,
  sliceLines,
  toText,
  type TextBuffer,
  type TextEdit,
} from "@danielfgray/amux-text-buffer";
import type { Cursor, EditorState } from "./schema.ts";

export const bufferFromLines = (lines: readonly string[]): TextBuffer => fromLines(lines);

export const bufferFromText = (text: string): TextBuffer => fromText(text);

export const textOf = (buffer: TextBuffer): string => toText(buffer);

/** Logical lines for motionCtx / tests — not stored on EditorState. */
export const linesOf = (buffer: TextBuffer): readonly string[] =>
  sliceLines(buffer, 0, lineCount(buffer));

export const lineAtRow = (buffer: TextBuffer, row: number): string =>
  Option.getOrElse(lineAt(buffer, row), () => "");

export const rowCount = (buffer: TextBuffer): number => lineCount(buffer);

export const clearPendingEdits = (state: EditorState): EditorState => ({
  ...state,
  pendingEdits: [],
});

const asEdits = (edit: TextEdit | readonly TextEdit[] | undefined): readonly TextEdit[] => {
  if (edit === undefined) return [];
  return "range" in edit ? [edit] : edit;
};

/** Install a new buffer ref; optionally append the TextEdit(s) that produced it. */
export const setBuffer = (
  state: EditorState,
  buffer: TextBuffer,
  edit?: TextEdit | readonly TextEdit[],
): EditorState => {
  const added = asEdits(edit);
  return {
    ...state,
    buffer,
    pendingEdits: added.length === 0 ? state.pendingEdits : [...state.pendingEdits, ...added],
    dirty: true,
  };
};

export const editInsert = (
  state: EditorState,
  row: number,
  col: number,
  text: string,
): EditorState => {
  const edit: TextEdit = {
    range: {
      start: { line: row, character: col },
      end: { line: row, character: col },
    },
    newText: text,
  };
  return setBuffer(state, applyEdit(state.buffer, edit), edit);
};

export const editDelete = (state: EditorState, from: Cursor, to: Cursor): EditorState => {
  const edit: TextEdit = {
    range: {
      start: { line: from.row, character: from.col },
      end: { line: to.row, character: to.col },
    },
    newText: "",
  };
  return setBuffer(state, applyEdit(state.buffer, edit), edit);
};

/** Replace lines [start, end) and record a covering LSP TextEdit. */
export const editReplaceLines = (
  state: EditorState,
  start: number,
  end: number,
  replacement: readonly string[],
): EditorState => {
  const n = rowCount(state.buffer);
  const lo = Math.max(0, Math.min(start, n));
  const hi = Math.max(lo, Math.min(end, n));
  const edit: TextEdit = {
    range: {
      start: { line: lo, character: 0 },
      end:
        hi >= n
          ? {
              line: Math.max(0, n - 1),
              character: lineAtRow(state.buffer, Math.max(0, n - 1)).length,
            }
          : { line: hi, character: 0 },
    },
    newText:
      hi >= n
        ? replacement.length === 0
          ? ""
          : `${replacement.join("\n")}\n`
        : replacement.length === 0
          ? ""
          : `${replacement.join("\n")}\n`,
  };
  const next = replaceLines(state.buffer, lo, hi, replacement);
  return setBuffer(state, next, edit);
};

export const emptyBuffer = (): TextBuffer => empty();
