/**
 * Shared tree-sitter highlighting for the editor and the agent harness.
 * Neither consumer parses: OpenTUI owns the worker, the queries and the
 * style engine, and this package owns the scoped wrapper both plugins use.
 */
export {
  filetypeForInfo,
  HighlightProvider,
  makeHighlightProvider,
  type HighlightClient,
  type HighlightListener,
  type HighlightProviderService,
  type HighlightSnapshot,
  type LineChunks,
} from "./highlight.ts";
export { discoverCachedParsers, parsersFromFileNames } from "./parsers.ts";
export type { FiletypeParserOptions, TextChunk } from "@opentui/core";
