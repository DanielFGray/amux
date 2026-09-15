import { expect, test } from "bun:test";
import { Option } from "effect";
import { findTagAt, tagDelimiters } from "./tags.ts";

test("tagDelimiters builds open/close from the typed prompt", () => {
  expect(Option.getOrThrow(tagDelimiters("div"))).toEqual({ open: "<div>", close: "</div>" });
  expect(Option.getOrThrow(tagDelimiters('div className="x"'))).toEqual({
    open: '<div className="x">',
    close: "</div>",
  });
  expect(Option.isNone(tagDelimiters(""))).toBe(true);
});

test("findTagAt is none when grammar is absent", () => {
  const lines = ["<div>hi</div>"];
  expect(Option.isNone(findTagAt(lines, { row: 0, col: 2 }, Option.none()))).toBe(true);
});
