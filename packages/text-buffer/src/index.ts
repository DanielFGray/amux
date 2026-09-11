export {
  applyEdit,
  applyEdits,
  byteLength,
  charCount,
  empty,
  fromLines,
  fromText,
  lineAt,
  lineCount,
  Position,
  Range,
  replaceLines,
  sliceLines,
  TextBufferError,
  TextEdit,
  toText,
  type TextBuffer,
} from "./buffer.ts";
export {
  CHUNK_BASE,
  MAX_CHUNK_BYTES,
  MAX_NODE,
  TREE_BASE,
  chunkString,
  clampCharBoundary,
  isBalanced,
  normalize,
  summaryOf,
  type SumTree,
} from "./sumtree.ts";
export { TextSummary, lineCountOf } from "./text-summary.ts";
export {
  DocumentStoreError,
  OpenDocumentStore,
  type DocumentMeta,
  type DocumentSnapshot,
} from "./store.ts";
