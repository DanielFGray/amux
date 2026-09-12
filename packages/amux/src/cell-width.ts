/**
 * Grapheme → display-cell map for one line of text.
 *
 * Terminal layout is in cells: CJK and emoji are two cells wide, combining
 * marks and variation selectors attach to their cluster, and a ZWJ family
 * collapses into one. A string index into the text is not a cell column.
 * Rather than approximate wcwidth, we walk with libghostty-vt's own width
 * engine — the same tables the terminal used when it printed the row — so
 * the mapping cannot drift from the layout the terminal actually made.
 *
 * Lives in amux core (not the editor package): copy mode and the scrollback
 * surface need it, and the editor peer-depends on amux. Putting it in editor
 * would make amux import editor — a cycle. text-buffer is an Effect-only leaf
 * and cannot carry the FFI.
 */
import { dlopen, FFIType as T, ptr } from "bun:ffi";
import { LIB } from "./ghostty-library.ts";

/** libghostty-vt's grapheme-width probe. Measures already-laid-out text. */
const graphemeWidth = (() => {
  const lib = LIB;
  const { symbols } = dlopen(lib, {
    ghostty_unicode_grapheme_width: {
      args: [T.ptr, T.u64, T.ptr],
      returns: T.u64,
    },
  });
  const width = new Uint8Array(1);
  return (cps: Uint32Array) => {
    if (cps.length === 0) return { consumed: 0, width: 0 };
    width[0] = 0;
    const consumed = Number(
      symbols.ghostty_unicode_grapheme_width(ptr(cps), BigInt(cps.length), ptr(width)),
    );
    return { consumed, width: width[0]! };
  };
})();

/**
 * A grapheme boundary in a row: the string index of its leading edge and the
 * terminal cell column it sits at. The final entry is the row's end
 * (`at` = text length), so every string index and every cell column has a
 * value to resolve to.
 */
export interface RowMap {
  at: number[];
  col: number[];
}

/**
 * Map a row's text onto its terminal cells: one entry per grapheme (the
 * terminal's own cluster segmentation), plus the row's end. Printable ASCII
 * text maps to the identity — `at[i] === col[i]` — so cell-aware search and
 * word motion degrade to the plain string layer on ordinary rows. Rows
 * holding anything else (control characters included) fall through to the
 * cluster engine, whose width is the only source of truth.
 */
export function rowCells(text: string): RowMap {
  // Fast path: printable ASCII is one cell per code unit, so the map is the
  // identity without touching the FFI engine. Capture expands tabs to spaces,
  // so this covers every ordinary row; anything exotic falls through below.
  if (/^[\x20-\x7e]*$/.test(text)) {
    const n = text.length;
    const at = Array.from({ length: n + 1 }, (_, i) => i);
    const col = Array.from({ length: n + 1 }, (_, i) => i);
    return { at, col };
  }
  const cps = new Uint32Array([...text].map((ch) => ch.codePointAt(0)!));
  const at: number[] = [0];
  const col: number[] = [0];
  let i = 0;
  let str = 0;
  while (i < cps.length) {
    const { consumed, width } = graphemeWidth(cps.subarray(i));
    for (let k = 0; k < consumed; k++) str += cps[i + k]! > 0xffff ? 2 : 1;
    i += consumed;
    at.push(str);
    col.push(col[col.length - 1]! + width);
  }
  return { at, col };
}

/** Width of text in terminal cells, rather than UTF-16 code units. */
export function cellWidth(text: string): number {
  return rowCells(text).col.at(-1) ?? 0;
}

/**
 * The cell column of the grapheme that contains string index `at`. A match
 * always begins on a grapheme boundary, so a match index lands on its own
 * leading cell.
 */
export function cellColumnOf(map: RowMap, at: number): number {
  let lo = 0;
  let hi = map.at.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.at[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return map.col[lo]!;
}

/**
 * The string index of the first grapheme whose leading cell is at or past
 * `col`: where a scan starting at a cursor cell must begin. Columns past the
 * row resolve to the row's end.
 */
export function stringIndexOf(map: RowMap, col: number): number {
  let lo = 0;
  let hi = map.col.length - 1;
  let res = map.at[map.at.length - 1]!;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map.col[mid]! >= col) {
      res = map.at[mid]!;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return res;
}

/**
 * The string index of the grapheme that occupies display cell `col` (vim
 * `coladvance` for a finite virtual column). A column that falls in the
 * second half of a wide grapheme lands on that grapheme. Columns past the
 * line land on the last grapheme; an empty line stays at 0.
 */
export function stringIndexAtCell(map: RowMap, col: number): number {
  if (map.at.length <= 1) return 0;
  // Exclude the end sentinel: last real grapheme is at length - 2.
  let lo = 0;
  let hi = map.at.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.col[mid]! <= col) lo = mid;
    else hi = mid - 1;
  }
  return map.at[lo]!;
}

/**
 * Display rows one buffer line occupies when soft-wrapped at `width` cells.
 * Without wrapping (`width` non-positive or infinite), one buffer line is one
 * display line. Soft-wrap later has this one owner.
 */
export function displayHeightOf(line: string, width: number): number {
  if (!(width > 0) || !Number.isFinite(width)) return 1;
  const cells = cellWidth(line);
  if (cells === 0) return 1;
  return Math.max(1, Math.ceil(cells / width));
}

/**
 * Buffer-line span of a window. Motions keep `{top,height}` in buffer lines;
 * {@link viewportForWindow} is who derives that span from display height.
 */
export interface BufferViewport {
  readonly top: number;
  readonly height: number;
}

/**
 * Buffer-line viewport covering `windowHeight` display rows starting at
 * buffer line `top`, wrapping each line at `width` cells. Motion signatures
 * keep `{top,height}` in buffer lines; this is who derives that span.
 */
export function viewportForWindow(
  lines: readonly string[],
  top: number,
  windowHeight: number,
  width: number,
): BufferViewport {
  const h = Math.max(1, windowHeight);
  if (lines.length === 0) return { top: 0, height: h };
  const start = Math.max(0, Math.min(top, lines.length - 1));
  let used = 0;
  let count = 0;
  for (let row = start; row < lines.length && used < h; row++) {
    used += displayHeightOf(lines[row]!, width);
    count += 1;
  }
  return { top: start, height: Math.max(1, count) };
}
