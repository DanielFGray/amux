import { expect, test } from "bun:test";
import { splitFences } from "./fences.ts";

test("prose without fences is one text segment", () => {
  expect(splitFences("hello\nworld")).toEqual([{ kind: "text", text: "hello\nworld" }]);
});

test("a fenced block splits into text, code, text", () => {
  expect(splitFences('before\n```ts\nconst x = 1;\n```\nafter')).toEqual([
    { kind: "text", text: "before" },
    { kind: "code", language: "ts", code: "const x = 1;" },
    { kind: "text", text: "after" },
  ]);
});

test("an untagged fence keeps an empty language", () => {
  expect(splitFences("```\nplain\n```")).toEqual([{ kind: "code", language: "", code: "plain" }]);
});

test("an unclosed fence runs to the end (streaming answers have no closer yet)", () => {
  expect(splitFences('text\n```py\nprint("hi")')).toEqual([
    { kind: "text", text: "text" },
    { kind: "code", language: "py", code: 'print("hi")' },
  ]);
});

test("tilde fences stay prose", () => {
  expect(splitFences("~~~\nnot code\n~~~")).toEqual([{ kind: "text", text: "~~~\nnot code\n~~~" }]);
});

test("empty text yields no segments", () => {
  expect(splitFences("")).toEqual([{ kind: "text", text: "" }]);
});
