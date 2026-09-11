/**
 * Decode LSP `textDocument/semanticTokens/full` data into per-token ranges.
 * The wire format is a flat uint32 array of 5-tuples:
 *   [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
 * Token type indices are server-defined; callers pass the legend from
 * initialize capabilities (or the LSP defaults below).
 */
import type { LspSemanticTokens } from "./service.ts";

export const DEFAULT_SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
] as const;

export interface SemanticTokenRange {
  readonly line: number;
  readonly startChar: number;
  readonly length: number;
  /** Legend name when known; otherwise `tokenType:${index}`. */
  readonly group: string;
}

/** Expand the delta-encoded LSP data array into absolute ranges. */
export const decodeSemanticTokens = (
  tokens: LspSemanticTokens,
  legend: readonly string[] = DEFAULT_SEMANTIC_TOKEN_TYPES,
): readonly SemanticTokenRange[] => {
  const out: SemanticTokenRange[] = [];
  let line = 0;
  let character = 0;
  const data = tokens.data;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i]!;
    const deltaStart = data[i + 1]!;
    const length = data[i + 2]!;
    const tokenType = data[i + 3]!;
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;
    out.push({
      line,
      startChar: character,
      length,
      group: legend[tokenType] ?? `tokenType:${tokenType}`,
    });
  }
  return out;
};

/** Map semantic-token groups onto the Catppuccin groups HighlightProvider uses. */
export const semanticGroupToHighlight = (group: string): string => {
  switch (group) {
    case "keyword":
    case "modifier":
      return "keyword";
    case "string":
    case "regexp":
      return "string";
    case "comment":
      return "comment";
    case "function":
    case "method":
    case "macro":
      return "function";
    case "type":
    case "class":
    case "interface":
    case "struct":
    case "enum":
    case "typeParameter":
    case "namespace":
      return "type";
    case "number":
      return "number";
    case "variable":
    case "parameter":
      return "variable";
    case "property":
    case "enumMember":
      return "property";
    case "operator":
      return "operator";
    default:
      return "variable";
  }
};

/** Count of highlightable tokens — a cheap richness signal for the eval. */
export const tokenCoverage = (tokens: readonly SemanticTokenRange[]): number =>
  tokens.reduce((sum, token) => sum + token.length, 0);
