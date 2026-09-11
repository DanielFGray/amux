import { expect, test, beforeAll } from "bun:test";
import {
  ensureGrammar,
  ensureStructure,
  grammarForFiletype,
  nodeAt,
  parseStructure,
  structureReady,
  utf16ColToByteCol,
  byteColToUtf16Col,
} from "./structure.ts";

beforeAll(() =>
  ensureStructure()
    .then(() => ensureGrammar("typescript"))
    .then(() => ensureGrammar("typescriptreact"))
    .then(() => ensureGrammar("javascript"))
    .then(() => ensureGrammar("html")),
);

test("grammarForFiletype maps react aliases to jsx-capable grammars", () => {
  expect(grammarForFiletype("typescriptreact")).toBe("tsx");
  expect(grammarForFiletype("javascriptreact")).toBe("javascript");
  expect(grammarForFiletype("rust")).toBe("rust");
});

test("ensureGrammar primes requested grammars on demand", () => {
  expect(structureReady("typescript")).toBe(true);
  expect(structureReady("typescriptreact")).toBe(true);
  expect(structureReady("javascript")).toBe(true);
});

test("parseStructure returns null for unknown / unloaded filetype", () => {
  expect(parseStructure("const x = 1", "definitely-not-a-lang")).toBeNull();
});

test("nodeAt finds a jsx_element under the cursor in TSX", () => {
  const content = `const el = (
  <div className="a">
    <span>hi</span>
  </div>
);
`;
  const tree = parseStructure(content, "typescriptreact");
  expect(tree).not.toBeNull();
  const node = nodeAt(tree!, 2, 8);
  expect(node).not.toBeNull();
  const types = [...node!.ancestors()].map((n) => n.type);
  expect(types).toContain("jsx_element");
});

test("nodeAt UTF-16 columns survive multi-byte characters", () => {
  const line = 'const s = "café";';
  expect(utf16ColToByteCol(line, 11)).toBe(11);
  const afterCafe = utf16ColToByteCol(line, 15);
  expect(byteColToUtf16Col(line, afterCafe)).toBe(15);
  expect(utf16ColToByteCol(line, 15) - utf16ColToByteCol(line, 14)).toBe(2);

  const content = `${line}\n`;
  const tree = parseStructure(content, "typescript");
  expect(tree).not.toBeNull();
  const node = nodeAt(tree!, 0, 12);
  expect(node?.type === "string" || node?.type === "string_fragment").toBe(true);
});

test("ensureGrammar loads html from cache or download", () =>
  ensureGrammar("html").then((ok) => {
    expect(ok).toBe(true);
    const tree = parseStructure("<div><span>x</span></div>", "html");
    expect(tree).not.toBeNull();
    const node = nodeAt(tree!, 0, 10);
    const types = [...node!.ancestors()].map((n) => n.type);
    expect(types.some((t) => t === "element" || t === "tag_name")).toBe(true);
  }));

test("ensureGrammar loads a cached non-catalog grammar (rust) when present", () =>
  ensureGrammar("rust").then((ok) => {
    if (!ok) return;
    expect(structureReady("rust")).toBe(true);
    const tree = parseStructure("fn main() {}", "rust");
    expect(tree).not.toBeNull();
  }));
