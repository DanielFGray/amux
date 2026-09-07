import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Context, Effect, Layer, Schema as S } from "effect";
import { FileFinder, type GrepResult, type Result, type SearchResult } from "@ff-labs/fff-bun";
import { stateRoot } from "@danielfgray/amux/session.ts";

export class FileSearchError extends S.TaggedError<FileSearchError>()("FileSearchError", {
  message: S.String,
}) {}

export interface FileSearch {
  readonly reindex: (root: string) => Effect.Effect<void, FileSearchError>;
  readonly searchFiles: (
    query: string,
    options?: Parameters<FileFinder["fileSearch"]>[1],
  ) => Effect.Effect<SearchResult, FileSearchError>;
  readonly glob: (
    pattern: string,
    options?: Parameters<FileFinder["glob"]>[1],
  ) => Effect.Effect<SearchResult, FileSearchError>;
  readonly grep: (
    query: string,
    options?: Parameters<FileFinder["grep"]>[1],
  ) => Effect.Effect<GrepResult, FileSearchError>;
}

/** The optional capability consumers inject from the amux.search plugin. */
export class SearchService extends Context.Service<SearchService, FileSearch>()(
  "amux/SearchService",
) {}

export interface FileSearchOptions {
  readonly root: string;
  readonly aiMode?: boolean;
  readonly consumer?: string;
}

const result = <A>(value: Result<A>): Effect.Effect<A, FileSearchError> =>
  value.ok
    ? Effect.succeed(value.value)
    : Effect.fail(new FileSearchError({ message: value.error }));

export const projectSlug = (root: string) => {
  const name = root.split("/").filter(Boolean).at(-1) || "project";
  let hash = 0x811c9dc5;
  for (let index = 0; index < root.length; index++) {
    hash ^= root.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${name.replaceAll(/[^a-zA-Z0-9._-]/g, "-")}-${(hash >>> 0).toString(36)}`;
};

const frecencyDirectory = Effect.fnUntraced(function* (root: string, consumer: string) {
  const path = yield* Path.Path;
  return path.join(yield* stateRoot(), "amux", "projects", projectSlug(root), consumer);
});

/**
 * Own one native index for a project. The scoped release is the only place a
 * finder is destroyed, which makes plugin unload and a worker exit safe.
 */
export const make = Effect.fnUntraced(function* (options: FileSearchOptions) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* frecencyDirectory(options.root, options.consumer ?? "interactive");
  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError((error) => new FileSearchError({ message: String(error) })));
  const finder = yield* Effect.acquireRelease(
    Effect.sync(() =>
      result(
        FileFinder.create({
          basePath: options.root,
          frecencyDbPath: `${directory}/frecency`,
          historyDbPath: `${directory}/history`,
          aiMode: options.aiMode ?? true,
        }),
      ),
    ).pipe(Effect.flatten),
    (value) => Effect.sync(() => value.destroy()),
  );
  yield* Effect.promise(() => finder.waitForIndexReady()).pipe(Effect.flatMap(result));
  const search: FileSearch = {
    reindex: (root) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => result(finder.reindex(root))).pipe(Effect.flatten);
        yield* Effect.promise(() => finder.waitForIndexReady()).pipe(Effect.flatMap(result));
      }),
    searchFiles: (query, searchOptions) =>
      Effect.sync(() => result(finder.fileSearch(query, searchOptions))).pipe(Effect.flatten),
    glob: (pattern, globOptions) =>
      Effect.sync(() => result(finder.glob(pattern, globOptions))).pipe(Effect.flatten),
    grep: (query, grepOptions) =>
      Effect.sync(() => result(finder.grep(query, grepOptions))).pipe(Effect.flatten),
  };
  return search;
});

export const layer = (options: FileSearchOptions) => Layer.effect(SearchService, make(options));
