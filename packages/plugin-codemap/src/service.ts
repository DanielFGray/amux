/**
 * CodemapExtractor — per-file extraction over the shared TreeSitter service.
 */
import { Context, Effect, Layer, Option } from "effect";
import * as FileSystem from "effect/FileSystem";
import { TreeSitter, type GrammarUnavailable } from "@danielfgray/amux-highlight";
import { extractFromTree, filetypeForExtractPath } from "./extract.ts";
import { ExtractParseError, ExtractUnsupportedFiletype, type FileExtraction } from "./schema.ts";

export type ExtractError = ExtractParseError | ExtractUnsupportedFiletype | GrammarUnavailable;

export interface CodemapExtractorService {
  readonly extractFile: (
    path: string,
    content: string,
  ) => Effect.Effect<FileExtraction, ExtractError>;
  readonly extractPath: (path: string) => Effect.Effect<FileExtraction, ExtractError>;
}

export class CodemapExtractor extends Context.Service<CodemapExtractor, CodemapExtractorService>()(
  "amux.codemap/Extractor",
) {}

const make: Effect.Effect<CodemapExtractorService, never, TreeSitter | FileSystem.FileSystem> =
  Effect.gen(function* () {
    const treeSitter = yield* TreeSitter;
    const fs = yield* FileSystem.FileSystem;

    const extractFile = Effect.fnUntraced(function* (path: string, content: string) {
      const filetype = yield* Option.match(filetypeForExtractPath(path), {
        onNone: () =>
          Effect.fail(
            new ExtractUnsupportedFiletype({
              path,
              filetype: path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "",
            }),
          ),
        onSome: (ft) => Effect.succeed(ft),
      });
      const grammar = yield* treeSitter.grammar(filetype);
      const tree = grammar.parse(content);
      if (tree === null) {
        return yield* new ExtractParseError({ path, message: "tree-sitter returned null tree" });
      }
      const extraction = extractFromTree(path, tree);
      tree.delete();
      return extraction;
    });

    const extractPath = Effect.fnUntraced(function* (path: string) {
      const content = yield* fs.readFileString(path).pipe(
        Effect.mapError(
          (error) =>
            new ExtractParseError({
              path,
              message: String(error),
            }),
        ),
      );
      return yield* extractFile(path, content);
    });

    return { extractFile, extractPath } satisfies CodemapExtractorService;
  });

export const layer: Layer.Layer<CodemapExtractor, never, TreeSitter | FileSystem.FileSystem> =
  Layer.effect(CodemapExtractor, make);
