/**
 * Per-file codemap extraction schema (Graft GraphV1 vocabulary, narrowed).
 * Later slices store and query this; this package only produces it.
 */
import { Schema as S } from "effect";

export const SymbolKind = S.Literals(["function", "class", "method", "const"]);
export type SymbolKind = typeof SymbolKind.Type;

export const Span = S.Struct({
  startLine: S.Int,
  startCol: S.Int,
  endLine: S.Int,
  endCol: S.Int,
});
export type Span = typeof Span.Type;

/** One definition. `id` is path-scoped (`path#name` or `path#Owner.name`). */
export const CodemapSymbol = S.Struct({
  id: S.String,
  name: S.String,
  kind: SymbolKind,
  span: Span,
  exported: S.Boolean,
  /** Immediate owner (class or outer function) for methods / nested consts. */
  owner: S.optionalKey(S.String),
  /** Declared inside another body — resolution stays file-local. */
  local: S.optionalKey(S.Boolean),
});
export type CodemapSymbol = typeof CodemapSymbol.Type;

export const ImportSpecifier = S.Struct({
  local: S.String,
  imported: S.optionalKey(S.String),
});
export type ImportSpecifier = typeof ImportSpecifier.Type;

export const CodemapImport = S.Struct({
  source: S.String,
  specifiers: S.Array(ImportSpecifier),
  span: Span,
});
export type CodemapImport = typeof CodemapImport.Type;

export const EdgeRelation = S.Literals(["calls", "imports", "contains"]);
export type EdgeRelation = typeof EdgeRelation.Type;

export const EdgeConfidence = S.Literals(["extracted", "inferred"]);
export type EdgeConfidence = typeof EdgeConfidence.Type;

/**
 * `calls` target is a bare or qualified name until a later resolve pass.
 * DI edges still use `calls` with `di: true` and target `Service.method`.
 */
export const CodemapEdge = S.Struct({
  source: S.String,
  target: S.String,
  relation: EdgeRelation,
  confidence: EdgeConfidence,
  span: S.optionalKey(Span),
  /** yield* Service / Context.get then .method */
  di: S.optionalKey(S.Boolean),
});
export type CodemapEdge = typeof CodemapEdge.Type;

export const FileExtraction = S.Struct({
  path: S.String,
  symbols: S.Array(CodemapSymbol),
  imports: S.Array(CodemapImport),
  edges: S.Array(CodemapEdge),
});
export type FileExtraction = typeof FileExtraction.Type;

export class ExtractParseError extends S.TaggedError<ExtractParseError>()("ExtractParseError", {
  path: S.String,
  message: S.String,
}) {}

export class ExtractUnsupportedFiletype extends S.TaggedError<ExtractUnsupportedFiletype>()(
  "ExtractUnsupportedFiletype",
  {
    path: S.String,
    filetype: S.String,
  },
) {}
