import { beforeAll, expect, test } from "bun:test";
import { Option } from "effect";
import { ensureGrammar } from "@danielfgray/amux-highlight";
import { findTagAt, tagDelimiters, tagTextObjectRange } from "./tags.ts";

beforeAll(() => ensureGrammar("typescriptreact").then(() => ensureGrammar("html")));

test("findTagAt picks the innermost jsx_element", () => {
  const lines = ["<div>", "  <span>hi</span>", "</div>"];
  const inner = Option.getOrThrow(
    findTagAt(lines, { row: 1, col: 6 }, Option.some("typescriptreact")),
  );
  expect(inner.name).toBe("span");
  expect(inner.open).toBe("<span>");
  expect(inner.close).toBe("</span>");
  expect(inner.selfClosing).toBe(false);

  const outer = Option.getOrThrow(
    findTagAt(lines, { row: 1, col: 1 }, Option.some("typescriptreact")),
  );
  expect(outer.name).toBe("div");
});

test("findTagAt handles self-closing jsx", () => {
  const lines = ['<div><img src="x" /></div>'];
  const match = Option.getOrThrow(
    findTagAt(lines, { row: 0, col: 8 }, Option.some("typescriptreact")),
  );
  expect(match.selfClosing).toBe(true);
  expect(match.name).toBe("img");
  expect(match.close).toBe("");
});

test("findTagAt works for html filetype", () => {
  const lines = ["<div id=a><span>x</span></div>"];
  const match = Option.getOrThrow(findTagAt(lines, { row: 0, col: 14 }, Option.some("html")));
  expect(match.name).toBe("span");
  expect(match.open).toBe("<span>");
});

test("tagDelimiters builds open/close from the typed prompt", () => {
  expect(Option.getOrThrow(tagDelimiters("div"))).toEqual({ open: "<div>", close: "</div>" });
  expect(Option.getOrThrow(tagDelimiters('div className="x"'))).toEqual({
    open: '<div className="x">',
    close: "</div>",
  });
  expect(Option.isNone(tagDelimiters(""))).toBe(true);
});

test("tagTextObjectRange it/at", () => {
  const lines = ["<div>", "  hi", "</div>"];
  const inner = Option.getOrThrow(
    tagTextObjectRange(lines, { row: 1, col: 2 }, Option.some("typescriptreact"), true),
  );
  expect(inner.from).toEqual({ row: 0, col: 5 });
  expect(inner.to).toEqual({ row: 2, col: 0 });

  const outer = Option.getOrThrow(
    tagTextObjectRange(lines, { row: 1, col: 2 }, Option.some("typescriptreact"), false),
  );
  expect(outer.from).toEqual({ row: 0, col: 0 });
  expect(outer.to).toEqual({ row: 2, col: 6 });

  const self = tagTextObjectRange(lines, { row: 0, col: 0 }, Option.some("typescriptreact"), true);
  expect(Option.isSome(self)).toBe(true);
});
