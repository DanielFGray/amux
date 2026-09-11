/**
 * Line-oriented text buffer on a B+ SumTree of UTF-8-sized chunks.
 *
 * Cite: Zed rope (CHUNK_BASE leaves, TextSummary) + Zed sum_tree (TREE_BASE).
 * Storage form is continuous text: empty → ""; non-empty always ends with `\n`.
 */
import { Option, Result, Schema as S } from "effect";
import * as Tree from "./sumtree.ts";

export const Position = S.Struct({
  line: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  character: S.Int.check(S.isGreaterThanOrEqualTo(0)),
});
export type Position = typeof Position.Type;

export const Range = S.Struct({
  start: Position,
  end: Position,
});
export type Range = typeof Range.Type;

export const TextEdit = S.Struct({
  range: Range,
  newText: S.String,
});
export type TextEdit = typeof TextEdit.Type;

export class TextBufferError extends S.TaggedError<TextBufferError>()("TextBufferError", {
  message: S.String,
}) {}

/** Opaque document body — B+ SumTree of text chunks. */
export type TextBuffer = Tree.SumTree;

/** Empty document is one logical blank line (zero bytes in the rope). */
export const empty = (): TextBuffer => Tree.empty();

/**
 * Build from logical lines (no trailing newline per line). Serializes to the
 * continuous storage form with a final `\n`, matching `toText`.
 */
export const fromLines = (lines: readonly string[]): TextBuffer => {
  if (lines.length === 0) return empty();
  if (lines.length === 1 && lines[0] === "") return empty();
  return Tree.fromString(`${lines.join("\n")}\n`);
};

export const fromText = (text: string): TextBuffer => {
  if (text.length === 0) return empty();
  const endsWithNewline = text.endsWith("\n");
  const body = endsWithNewline ? text.slice(0, -1) : text;
  if (body.length === 0) return empty();
  return Tree.fromString(`${body}\n`);
};

export const toText = (buffer: TextBuffer): string => Tree.toString(buffer);

export const lineCount = (buffer: TextBuffer): number => Tree.lineCount(buffer);

export const lineAt = (buffer: TextBuffer, row: number): Option.Option<string> =>
  Tree.lineAt(buffer, row);

/** UTF-8 byte length of serialized text — O(1) from the root summary. */
export const byteLength = (buffer: TextBuffer): number => Tree.byteCount(buffer);

/** UTF-16 length of serialized text — O(1) from the root summary. */
export const charCount = (buffer: TextBuffer): number => Tree.charCount(buffer);

export const sliceLines = (buffer: TextBuffer, start: number, end: number): readonly string[] =>
  Tree.sliceLines(buffer, start, end);

/**
 * Replace lines [start, end) with `replacement`. Structural splice on the rope.
 */
export const replaceLines = (
  buffer: TextBuffer,
  start: number,
  end: number,
  replacement: readonly string[],
): TextBuffer => {
  const n = Tree.lineCount(buffer);
  const lo = Math.max(0, Math.min(start, n));
  const hi = Math.max(lo, Math.min(end, n));
  if (Tree.isEmpty(buffer)) {
    return replacement.length === 0 || (replacement.length === 1 && replacement[0] === "")
      ? empty()
      : fromLines(replacement);
  }
  const startOff = Tree.charOffsetOfLine(buffer, lo);
  const endOff = hi >= n ? Tree.charCount(buffer) : Tree.charOffsetOfLine(buffer, hi);
  const mid =
    replacement.length === 0
      ? ""
      : replacement.length === 1 && replacement[0] === "" && lo === 0 && hi >= n
        ? ""
        : `${replacement.join("\n")}\n`;
  const next = Tree.replaceChars(buffer, startOff, endOff, mid);
  return Tree.isEmpty(next) ? empty() : next;
};

const clampColumn = (line: string, character: number): number =>
  Math.max(0, Math.min(character, line.length));

const comparePosition = (a: Position, b: Position): number =>
  a.line !== b.line ? a.line - b.line : a.character - b.character;

/** Apply one LSP-shaped edit. Ranges are UTF-16 code units (JS string indexes). */
export const applyEdit = (buffer: TextBuffer, edit: TextEdit): TextBuffer => {
  if (Tree.isEmpty(buffer)) {
    return fromText(edit.newText);
  }
  const last = Math.max(0, Tree.lineCount(buffer) - 1);
  const startLine = Math.max(0, Math.min(edit.range.start.line, last));
  const endLine = Math.max(startLine, Math.min(edit.range.end.line, last));
  const startLineText = Option.getOrThrow(Tree.lineAt(buffer, startLine));
  const endLineText = Option.getOrThrow(Tree.lineAt(buffer, endLine));
  const startCol = clampColumn(startLineText, edit.range.start.character);
  const endCol = clampColumn(endLineText, edit.range.end.character);
  const startOff = Tree.charOffsetOfLine(buffer, startLine) + startCol;
  const endOff = Tree.charOffsetOfLine(buffer, endLine) + endCol;
  const next = Tree.replaceChars(buffer, startOff, endOff, edit.newText);
  return Tree.isEmpty(next) ? empty() : next;
};

/**
 * Apply edits high-to-low so earlier ranges stay valid. Overlapping ranges are
 * rejected — callers must rebase.
 */
export const applyEdits = (
  buffer: TextBuffer,
  edits: readonly TextEdit[],
): Result.Result<TextBuffer, TextBufferError> => {
  if (edits.length === 0) return Result.succeed(buffer);
  const ordered = [...edits].sort((a, b) => comparePosition(b.range.start, a.range.start));
  for (let i = 0; i < ordered.length - 1; i++) {
    const later = ordered[i]!;
    const earlier = ordered[i + 1]!;
    if (comparePosition(earlier.range.end, later.range.start) > 0) {
      return Result.fail(new TextBufferError({ message: "overlapping text edits" }));
    }
  }
  return Result.succeed(ordered.reduce((doc, edit) => applyEdit(doc, edit), buffer));
};
