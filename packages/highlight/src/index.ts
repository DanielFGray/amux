/**
 * Shared tree-sitter highlighting for the editor and the agent harness.
 * Highlighting still goes through OpenTUI's worker; structural parse
 * (`TreeSitter`) is an in-process second path for tag surround and
 * textobjects that need the AST on the main thread.
 */
export {
  codeSyntaxStyle,
  filetypeForInfo,
  filetypeForPath,
  HighlightProvider,
  makeHighlightProvider,
  type HighlightClient,
  type HighlightListener,
  type HighlightProviderService,
  type HighlightSnapshot,
  type LineChunks,
} from "./highlight.ts";
export { discoverCachedParsers, parsersFromFileNames } from "./parsers.ts";
export {
  byteColToUtf16Col,
  grammarForFiletype,
  GrammarDownloadFailed,
  GrammarSourceMissing,
  GrammarWasmLoadFailed,
  layer as treeSitterLayer,
  RuntimeWasmMissing,
  TreeSitter,
  utf16ColToByteCol,
  type GrammarUnavailable,
  type TreeSitterService,
} from "./structure.ts";
export type { FiletypeParserOptions, TextChunk } from "@opentui/core";
