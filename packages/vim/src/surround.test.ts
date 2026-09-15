import { expect, test } from "bun:test";
import { Option } from "effect";
import {
  addSurround,
  changeSurround,
  deleteSurround,
  delimitersFor,
  findSurrounding,
} from "./surround.ts";

test("delimitersFor spaces open forms and aliases close forms", () => {
  expect(Option.getOrThrow(delimitersFor("("))).toEqual({ open: "( ", close: " )" });
  expect(Option.getOrThrow(delimitersFor(")"))).toEqual({ open: "(", close: ")" });
  expect(Option.getOrThrow(delimitersFor("b"))).toEqual({ open: "(", close: ")" });
  expect(Option.getOrThrow(delimitersFor('"'))).toEqual({ open: '"', close: '"' });
});

test("findSurrounding matches nested brackets across lines", () => {
  const lines = ["outer(", "  inner(x)", ")"];
  const match = Option.getOrThrow(findSurrounding(lines, { row: 1, col: 8 }, ")"));
  expect(match).toEqual({
    openPos: { row: 1, col: 7 },
    closePos: { row: 1, col: 9 },
    open: "(",
    close: ")",
  });
  const outer = Option.getOrThrow(findSurrounding(lines, { row: 1, col: 2 }, ")"));
  expect(outer.openPos).toEqual({ row: 0, col: 5 });
  expect(outer.closePos).toEqual({ row: 2, col: 0 });
});

test("addSurround wraps a charwise range", () => {
  const result = Option.getOrThrow(
    addSurround(
      ["hello world"],
      { from: { row: 0, col: 6 }, to: { row: 0, col: 11 }, linewise: false, inclusive: false },
      ")",
    ),
  );
  expect(result.lines).toEqual(["hello (world)"]);
  expect(result.cursor).toEqual({ row: 0, col: 6 });
});

test("addSurround spaced form and yss-style linewise", () => {
  const spaced = Option.getOrThrow(
    addSurround(
      ["hello world"],
      { from: { row: 0, col: 6 }, to: { row: 0, col: 11 }, linewise: false, inclusive: false },
      "(",
    ),
  );
  expect(spaced.lines).toEqual(["hello ( world )"]);

  const line = Option.getOrThrow(
    addSurround(
      ["  hello"],
      { from: { row: 0, col: 0 }, to: { row: 0, col: 7 }, linewise: true, inclusive: false },
      '"',
    ),
  );
  expect(line.lines).toEqual(['  "hello"']);
  expect(line.cursor).toEqual({ row: 0, col: 2 });
});

test("deleteSurround and changeSurround rewrite the pair", () => {
  const deleted = Option.getOrThrow(deleteSurround(['say "hi" now'], { row: 0, col: 5 }, '"'));
  expect(deleted.lines).toEqual(["say hi now"]);

  const spaced = Option.getOrThrow(deleteSurround(["( foo )"], { row: 0, col: 3 }, "("));
  expect(spaced.lines).toEqual(["foo"]);

  const kept = Option.getOrThrow(deleteSurround(["( foo )"], { row: 0, col: 3 }, ")"));
  expect(kept.lines).toEqual([" foo "]);

  const changed = Option.getOrThrow(changeSurround(["(foo)"], { row: 0, col: 2 }, ")", "]"));
  expect(changed.lines).toEqual(["[foo]"]);
});
