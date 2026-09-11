import { expect } from "bun:test";
import { describe, test } from "bun:test";
import {
  DEFAULT_SEMANTIC_TOKEN_TYPES,
  decodeSemanticTokens,
  semanticGroupToHighlight,
  tokenCoverage,
} from "./semantic-tokens.ts";

describe("decodeSemanticTokens", () => {
  test("expands delta-encoded tuples into absolute ranges", () => {
    // line 0 char 0 len 5 keyword; same line char 6 len 3 variable
    const ranges = decodeSemanticTokens({ data: [0, 0, 5, 15, 0, 0, 6, 3, 8, 0] });
    expect(ranges).toEqual([
      { line: 0, startChar: 0, length: 5, group: "keyword" },
      { line: 0, startChar: 6, length: 3, group: "variable" },
    ]);
  });

  test("advances the line and resets character on deltaLine > 0", () => {
    const ranges = decodeSemanticTokens({ data: [0, 0, 2, 15, 0, 1, 4, 3, 8, 0] });
    expect(ranges[1]).toEqual({ line: 1, startChar: 4, length: 3, group: "variable" });
  });

  test("falls back when the legend index is unknown", () => {
    const ranges = decodeSemanticTokens({ data: [0, 0, 1, 99, 0] }, ["keyword"]);
    expect(ranges[0]?.group).toBe("tokenType:99");
  });

  test("DEFAULT_SEMANTIC_TOKEN_TYPES covers the LSP 3.17 set", () => {
    expect(DEFAULT_SEMANTIC_TOKEN_TYPES).toContain("keyword");
    expect(DEFAULT_SEMANTIC_TOKEN_TYPES).toContain("decorator");
  });
});

describe("semanticGroupToHighlight", () => {
  test("maps LSP groups onto the Catppuccin highlight table", () => {
    expect(semanticGroupToHighlight("keyword")).toBe("keyword");
    expect(semanticGroupToHighlight("method")).toBe("function");
    expect(semanticGroupToHighlight("interface")).toBe("type");
    expect(semanticGroupToHighlight("mystery")).toBe("variable");
  });
});

describe("tokenCoverage", () => {
  test("sums token lengths", () => {
    expect(
      tokenCoverage([
        { line: 0, startChar: 0, length: 5, group: "keyword" },
        { line: 0, startChar: 6, length: 3, group: "variable" },
      ]),
    ).toBe(8);
  });
});
