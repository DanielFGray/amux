import { Effect, Option, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export class CatalogError extends S.TaggedError<CatalogError>()("CatalogError", {
  message: S.String,
}) {}

export const ServerCommandSchema = S.Struct({
  command: S.String.pipe(S.check(S.isMinLength(1))),
  args: S.Array(S.String),
});
export type ServerCommand = typeof ServerCommandSchema.Type;

export const LanguageDefinitionSchema = S.Struct({
  extensions: S.Array(S.String.pipe(S.check(S.isMinLength(1)))),
  servers: S.Array(ServerCommandSchema),
});
export type LanguageDefinition = typeof LanguageDefinitionSchema.Type;

export const CatalogOverridesSchema = S.Struct({
  languages: S.Record(S.String, LanguageDefinitionSchema),
});
export type CatalogOverrides = typeof CatalogOverridesSchema.Type;

export interface LanguageCatalog {
  readonly languages: ReadonlyMap<string, LanguageDefinition>;
}

const TYPESCRIPT: LanguageDefinition = {
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  servers: [{ command: "typescript-language-server", args: ["--stdio"] }],
};

export const builtInCatalog: LanguageCatalog = {
  languages: new Map([["typescript", TYPESCRIPT]]),
};

const emptyOverrides: CatalogOverrides = { languages: {} };

/** User entries replace a language definition whole, including its candidate order. */
export const catalogWithOverrides = (overrides: CatalogOverrides): LanguageCatalog => ({
  languages: new Map([...builtInCatalog.languages, ...Object.entries(overrides.languages)]),
});

export const languageForPath = (catalog: LanguageCatalog, file: string): Option.Option<string> => {
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  return Option.fromIterable(
    catalog.languages
      .entries()
      .filter(([, definition]) =>
        definition.extensions.some((candidate) => candidate.toLowerCase() === extension),
      ),
  ).pipe(Option.map(([language]) => language));
};

export const serverCommandsFor = (
  catalog: LanguageCatalog,
  language: string,
): Option.Option<readonly ServerCommand[]> =>
  Option.map(
    Option.fromUndefinedOr(catalog.languages.get(language)),
    (definition) => definition.servers,
  );

/** A pane or space CWD is the LSP workspace root. Do not infer a VCS root. */
export const workspaceRoot = Effect.fnUntraced(function* (cwd: string) {
  const path = yield* Path.Path;
  return path.resolve(cwd);
});

/** Load the host-owned per-user catalog extension at `<configDirectory>/lsp.json`. */
export const loadCatalogOverrides = Effect.fnUntraced(function* (configDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(configDirectory, "lsp.json");
  const exists = yield* fs
    .exists(file)
    .pipe(
      Effect.mapError(
        (error) => new CatalogError({ message: `cannot read ${file}: ${error.message}` }),
      ),
    );
  if (!exists) return emptyOverrides;
  const text = yield* fs
    .readFileString(file)
    .pipe(
      Effect.mapError(
        (error) => new CatalogError({ message: `cannot read ${file}: ${error.message}` }),
      ),
    );
  return yield* S.decodeEffect(S.fromJsonString(CatalogOverridesSchema))(text).pipe(
    Effect.mapError(
      (error) => new CatalogError({ message: `invalid LSP catalog in ${file}: ${error}` }),
    ),
  );
});
