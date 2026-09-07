/**
 * Motion-to-range: the pure algebra a normal-mode keypress asks for.
 *
 * Both plain motions (w, b, $, gg) and operator-driven motions (d, c, y)
 * share one result shape: a range of lines and columns the action covers.
 * The range is inclusive on the end side, so a `dl` at the end of a line is
 * a no-op and `dw` covers the word plus one trailing space when the word
 * ends the line.
 *
 * The range's kind tells operators whether to delete whole lines or just
 * characters. A linewise motion (gg, G, the empty linewise `dd`) yields
 * `linewise: true`; everything else is character-wise.
 */
import type { Cursor } from "./vim-core.ts";

export interface MotionRange {
  readonly from: Cursor;
  readonly to: Cursor;
  readonly linewise: boolean;
}

interface MotionContext {
  readonly lines: readonly string[];
  readonly cursor: Cursor;
  readonly count: number;
}

export type Motion = (ctx: MotionContext) => Cursor;

/** Compose a count with a motion that moves one unit. The range's `from`
 *  stays at the starting cursor so operators can reconstruct what was
 *  covered. */
export function applyMotion(motion: Motion, ctx: MotionContext, linewise = false): MotionRange {
  let to = ctx.cursor;
  for (let index = 0; index < ctx.count; index++) {
    to = motion({ ...ctx, cursor: to, count: 1 });
    if (to.row >= ctx.lines.length - 1 && to.col >= ctx.lines[to.row]!.length) break;
  }
  return { from: ctx.cursor, to, linewise };
}

const isWord = (char: string): boolean => /[A-Za-z0-9_]/.test(char);
const isBlank = (char: string): boolean => char === " " || char === "\t";

function classAt(line: string, col: number): "word" | "blank" | "other" {
  const char = line[col] ?? "";
  if (char === "") return "word";
  if (isWord(char)) return "word";
  if (isBlank(char)) return "blank";
  return "other";
}

export const wordForward: Motion = ({ lines, cursor }) => {
  let { row, col } = cursor;
  const line = lines[row]!;
  let current = classAt(line, col);
  // Step off the cursor's own class first so a `w` at the start of a word
  // walks past it rather than bailing out.
  col += 1;
  if (col >= line.length) {
    if (row >= lines.length - 1) return { row, col: line.length };
    return { row: row + 1, col: 0 };
  }
  // Skip the tail of whatever class we just left.
  while (col < line.length && classAt(line, col) === current) col += 1;
  if (col >= line.length) {
    if (row >= lines.length - 1) return { row, col: line.length };
    return { row: row + 1, col: 0 };
  }
  // Skip the gap between classes (e.g. trailing space after a word).
  while (col < line.length && classAt(line, col) === "blank") col += 1;
  return { row, col };
};

export const wordBackward: Motion = ({ lines, cursor }) => {
  let { row, col } = cursor;
  if (col === 0) {
    if (row === 0) return cursor;
    row -= 1;
    col = lines[row]!.length;
    while (col > 0 && isBlank(lines[row]![col - 1] ?? "")) col -= 1;
    return { row, col };
  }
  col -= 1;
  const line = lines[row]!;
  // Step off blank to the start of a word.
  if (isBlank(line[col] ?? "")) {
    while (col > 0 && isBlank(line[col - 1] ?? "")) col -= 1;
    if (col === 0 && isBlank(line[0] ?? "")) return { row, col: 0 };
    if (isBlank(line[col] ?? "")) return { row, col: 0 };
  }
  // Walk back through the class we landed in.
  let klass = classAt(line, col);
  while (col > 0 && classAt(line, col - 1) === klass) col -= 1;
  return { row, col };
};

export const wordEnd: Motion = ({ lines, cursor }) => {
  const { row } = cursor;
  const line = lines[row]!;
  if (cursor.col >= line.length - 1) {
    if (row >= lines.length - 1) return { row, col: line.length };
    // Step onto the start of the next non-blank run.
    let nextRow = row + 1;
    while (nextRow < lines.length && lines[nextRow]!.length === 0) nextRow += 1;
    if (nextRow >= lines.length) return { row, col: line.length };
    return { row: nextRow, col: 0 };
  }
  // `e` places the cursor on the last char of the word, matching vim's
  // standalone motion. Operators and text objects convert this to an
  // exclusive end cursor themselves.
  let col = cursor.col + 1;
  while (col < line.length && isBlank(line[col] ?? "")) col += 1;
  while (col < line.length - 1 && classAt(line, col + 1) === "word") col += 1;
  return { row, col };
};

export const firstNonBlank: Motion = ({ lines, cursor }) => {
  const line = lines[cursor.row]!;
  let col = 0;
  while (col < line.length && isBlank(line[col] ?? "")) col += 1;
  return { row: cursor.row, col };
};

export const lineEnd: Motion = ({ lines, cursor }) => ({
  row: cursor.row,
  col: lines[cursor.row]!.length,
});

export const firstColumn: Motion = ({ cursor }) => ({ row: cursor.row, col: 0 });

export const lineDown: Motion = ({ lines, cursor }) => {
  if (cursor.row >= lines.length - 1) return cursor;
  return { row: cursor.row + 1, col: 0 };
};

export const lineUp: Motion = ({ cursor }) => {
  if (cursor.row === 0) return cursor;
  return { row: cursor.row - 1, col: 0 };
};

export const firstLine: Motion = () => ({ row: 0, col: 0 });

export const lastLine: Motion = ({ lines, count }) => {
  // Bare `G` jumps to the last line; `nG` jumps to line n. A count of 1
  // is the "no count was typed" case the operator arm produces, and it
  // must still mean "last line", so we special-case it.
  if (count <= 1) return { row: lines.length - 1, col: 0 };
  return { row: Math.min(count - 1, lines.length - 1), col: 0 };
};

export const leftChar: Motion = ({ cursor }) => {
  if (cursor.col > 0) return { row: cursor.row, col: cursor.col - 1 };
  return cursor;
};

export const rightChar: Motion = ({ lines, cursor }) => {
  const line = lines[cursor.row]!;
  if (cursor.col < line.length) return { row: cursor.row, col: cursor.col + 1 };
  return cursor;
};

export const allMotions = {
  h: leftChar,
  l: rightChar,
  j: lineDown,
  k: lineUp,
  w: wordForward,
  b: wordBackward,
  e: wordEnd,
  "0": firstColumn,
  $: lineEnd,
  "^": firstNonBlank,
  G: lastLine,
  firstLine: firstLine,
} satisfies Record<string, Motion>;
