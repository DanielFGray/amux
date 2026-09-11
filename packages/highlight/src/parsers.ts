/**
 * Parsers beyond OpenTUI's five bundled grammars.
 *
 * `@opentui/core` 0.5.1 only bundles typescript, javascript, markdown,
 * markdown_inline and zig — every other filetype resolves but the worker
 * answers "No parser available" and the pane renders plain. The worker's
 * data dir (`globalDataPath/tree-sitter`, see `getDataPaths`), however,
 * caches one `tree-sitter-<grammar>.wasm` plus its `<name>-<hash>.scm`
 * highlight query per language, downloaded by other tooling. This module
 * turns that cache into `FiletypeParserOptions` the provider registers
 * with `client.addFiletypeParser` at init. A machine with no cache gets no
 * extra parsers and renders plain — the same graceful fallback as before.
 */
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { getDataPaths, type FiletypeParserOptions } from "@opentui/core";

/** The five grammars shipped in the npm package — never overridden. */
const BUNDLED = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "markdown",
  "markdown_inline",
  "zig",
]);

/** Grammar (wasm filename) to client filetype where they differ. Everything
 *  else is identity: the cache's `go` is the client's `go`. */
/** Grammar name to client filetype where the two differ. */
type GrammarFiletypeMap = Record<string, string>;
const FILETYPE_BY_GRAMMAR: GrammarFiletypeMap = { c_sharp: "csharp" };

const normalize = (name: string): string => name.toLowerCase().replace(/[_-]/g, "");

/** Pure mapping from cache directory listings to parser registrations.
 *  Query files are `<name>-<hash>.scm`; the name matches the filetype once
 *  separators are ignored (`csharp-…` pairs with grammar `c_sharp`). */
export const parsersFromFileNames = (
  languagesDir: string,
  queriesDir: string,
  languages: readonly string[],
  queries: readonly string[],
): FiletypeParserOptions[] => {
  const out: FiletypeParserOptions[] = [];
  for (const wasm of languages) {
    const match = /^tree-sitter-(.+)\.wasm$/.exec(wasm);
    if (match === null) continue;
    const filetype = FILETYPE_BY_GRAMMAR[match[1]!] ?? match[1]!;
    if (BUNDLED.has(filetype)) continue;
    const query = queries.find(
      (name) =>
        name.endsWith(".scm") &&
        normalize(name.slice(0, name.lastIndexOf("-"))) === normalize(filetype),
    );
    if (query === undefined) continue;
    out.push({
      filetype,
      wasm: `${languagesDir}/${wasm}`,
      queries: { highlights: [`${queriesDir}/${query}`] },
    });
  }
  return out;
};

/** Scan the worker's data dir for cached grammars. Missing directories (a
 *  machine that never fetched parsers) yield no parsers, never an error. */
export const discoverCachedParsers: Effect.Effect<
  readonly FiletypeParserOptions[],
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = path.join(getDataPaths().globalDataPath, "tree-sitter");
  const languages = yield* fs
    .readDirectory(path.join(root, "languages"))
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  const queries = yield* fs
    .readDirectory(path.join(root, "queries"))
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  return parsersFromFileNames(
    path.join(root, "languages"),
    path.join(root, "queries"),
    languages,
    queries,
  );
});
