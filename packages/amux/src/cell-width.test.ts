/**
 * Direct geometry tests for the grapheme → display-cell map.
 *
 * These mirror the CJK / emoji / ZWJ / variation-selector fixtures that
 * copy.test.ts exercises through CopyMode against a real ghostty terminal.
 * The module is the single source of truth; copy mode and the editor both
 * import it.
 */
import { expect, test } from "bun:test";
import {
  cellColumnOf,
  cellWidth,
  displayHeightOf,
  rowCells,
  stringIndexAtCell,
  stringIndexOf,
  viewportForWindow,
} from "./cell-width.ts";

test("printable ASCII is the identity map", () => {
  const map = rowCells("foo bar");
  expect(map.at).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(map.col).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(cellWidth("foo bar")).toBe(7);
});

test("CJK characters occupy two cells each", () => {
  // 你@0-1, 好@2-3, so "foo" begins at cell 4 — not string index 2.
  const map = rowCells("你好foo");
  expect(cellWidth("你好foo")).toBe(7);
  expect(cellColumnOf(map, 0)).toBe(0);
  expect(cellColumnOf(map, 1)).toBe(2);
  expect(cellColumnOf(map, 2)).toBe(4);
  expect(stringIndexOf(map, 4)).toBe(2);
  expect(stringIndexAtCell(map, 0)).toBe(0);
  expect(stringIndexAtCell(map, 1)).toBe(0);
  expect(stringIndexAtCell(map, 2)).toBe(1);
  expect(stringIndexAtCell(map, 3)).toBe(1);
  expect(stringIndexAtCell(map, 4)).toBe(2);
});

test("an emoji surrogate pair is two cells, then CJK", () => {
  // 👨@0-1, 你@2-3, so "foo" starts at cell 5 even though its string index is 4.
  const map = rowCells("👨你 foo");
  expect(cellColumnOf(map, 4)).toBe(5);
  expect(stringIndexOf(map, 5)).toBe(4);
  expect(stringIndexAtCell(map, 1)).toBe(0);
});

test("a ZWJ family is one wide grapheme", () => {
  // Family renders as one two-cell grapheme; "hit" begins at cell 3, not index 9.
  const map = rowCells("👨‍👩‍👧 hit");
  expect(cellWidth("👨‍👩‍👧")).toBe(2);
  expect(stringIndexOf(map, 3)).toBe(9);
  expect(cellColumnOf(map, 9)).toBe(3);
});

test("a variation-selector emoji widens like CJK", () => {
  // ❤ + VS16 is two cells, 你 is two more; "foo" begins at cell 5, string index 4.
  const map = rowCells("❤️你 foo");
  expect(cellWidth("❤️")).toBe(2);
  expect(stringIndexOf(map, 5)).toBe(4);
  expect(cellColumnOf(map, 4)).toBe(5);
});

test("colAdvance-shaped clamp: past the line lands on the last grapheme", () => {
  const map = rowCells("你好");
  expect(stringIndexAtCell(map, 99)).toBe(1);
  expect(stringIndexAtCell(rowCells(""), 0)).toBe(0);
});

test("displayHeightOf wraps a wide line at width", () => {
  // 你好 = 4 cells → two display rows at width 2; one at width 80.
  expect(displayHeightOf("你好", 2)).toBe(2);
  expect(displayHeightOf("你好", 80)).toBe(1);
  expect(displayHeightOf("你好", Infinity)).toBe(1);
});

test("viewportForWindow covers windowHeight display rows in buffer lines", () => {
  const lines = ["你好", "ab", "你好你好"];
  // width 2: first line is 2 display rows, so height 2 display → 1 buffer line.
  expect(viewportForWindow(lines, 0, 2, 2)).toEqual({ top: 0, height: 1 });
  // width 80: one buffer line per display row.
  expect(viewportForWindow(lines, 0, 2, 80)).toEqual({ top: 0, height: 2 });
  expect(viewportForWindow(lines, 1, 10, 80)).toEqual({ top: 1, height: 2 });
});
