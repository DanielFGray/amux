import { expect, test } from "bun:test";
import { parsersFromFileNames } from "./parsers.ts";

const LANGUAGES = [
  "tree-sitter-json.wasm",
  "tree-sitter-c_sharp.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-go.wasm",
  "README.md",
];
const QUERIES = ["json-256dee0a.scm", "csharp-30f85cda.scm", "go-2c6db0b6.scm"];

test("cached grammars map to registrations with absolute asset paths", () => {
  const parsers = parsersFromFileNames("/data/languages", "/data/queries", LANGUAGES, QUERIES);
  expect(parsers.map((parser) => parser.filetype).sort()).toEqual(["csharp", "go", "json"]);
  const json = parsers.find((parser) => parser.filetype === "json")!;
  expect(json.wasm).toBe("/data/languages/tree-sitter-json.wasm");
  expect(json.queries).toEqual({ highlights: ["/data/queries/json-256dee0a.scm"] });
});

test("c_sharp wasm pairs with the csharp query", () => {
  const parsers = parsersFromFileNames("/d/l", "/d/q", LANGUAGES, QUERIES);
  const csharp = parsers.find((parser) => parser.filetype === "csharp")!;
  expect(csharp.wasm).toBe("/d/l/tree-sitter-c_sharp.wasm");
  expect(csharp.queries).toEqual({ highlights: ["/d/q/csharp-30f85cda.scm"] });
});

test("bundled grammars are never overridden", () => {
  const parsers = parsersFromFileNames("/d/l", "/d/q", LANGUAGES, QUERIES);
  expect(parsers.some((parser) => parser.filetype === "typescript")).toBe(false);
});

test("a grammar without a query is skipped", () => {
  const parsers = parsersFromFileNames("/d/l", "/d/q", ["tree-sitter-rust.wasm"], QUERIES);
  expect(parsers).toEqual([]);
});

test("empty listings yield no parsers", () => {
  expect(parsersFromFileNames("/d/l", "/d/q", [], [])).toEqual([]);
});
