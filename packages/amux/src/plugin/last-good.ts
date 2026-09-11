import { Context, Effect, Layer, Option, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Exact source text for one reloadable module in a committed generation. */
export interface LastGoodModule {
  readonly url: string;
  readonly text: string;
}

/** A recoverable plugin cohort. Definitions cannot be persisted: activations are closures. */
export interface LastGoodGeneration {
  readonly version: 1;
  readonly entries: readonly string[];
  readonly modules: readonly LastGoodModule[];
  readonly quarantined: boolean;
}

export class LastGoodStoreError extends S.TaggedError<LastGoodStoreError>()("LastGoodStoreError", {
  message: S.String,
}) {}

const GenerationSchema = S.Struct({
  version: S.Literal(1),
  entries: S.Array(S.String),
  modules: S.Array(S.Struct({ url: S.String, text: S.String })),
  quarantined: S.Boolean,
});

export interface LastGoodStore {
  readonly read: Effect.Effect<Option.Option<LastGoodGeneration>, LastGoodStoreError>;
  readonly write: (generation: LastGoodGeneration) => Effect.Effect<void, LastGoodStoreError>;
}

export class LastGoodStoreTag extends Context.Service<LastGoodStoreTag, LastGoodStore>()(
  "amux/LastGoodStore",
) {}

/**
 * Persist one cohort with write-temp-then-rename. The caller chooses a stable
 * path from its configured entries, so separate client configurations never
 * contend for one mutable recovery file.
 */
export const makeLastGoodStore = (
  file: string,
): Effect.Effect<LastGoodStore, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const read = fs.readFileString(file).pipe(
      Effect.flatMap((text) => S.decodeEffect(S.fromJsonString(GenerationSchema))(text)),
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none())
          : Effect.fail(new LastGoodStoreError({ message: error.message })),
      ),
      Effect.mapError((error) =>
        S.is(LastGoodStoreError)(error)
          ? error
          : new LastGoodStoreError({ message: String(error) }),
      ),
    );
    const write = (generation: LastGoodGeneration) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        const text = yield* S.encodeEffect(S.fromJsonString(GenerationSchema))(generation).pipe(
          Effect.mapError((error) => new LastGoodStoreError({ message: String(error) })),
        );
        const temp = `${file}.${process.pid}.tmp`;
        yield* fs.writeFileString(temp, `${text}\n`, { mode: 0o600 });
        const staged = yield* fs.open(temp, { flag: "r+" });
        yield* staged.sync;
        yield* fs.rename(temp, file);
        const directory = yield* fs.open(path.dirname(file), { flag: "r" });
        yield* directory.sync;
      }).pipe(
        Effect.mapError((error) =>
          S.is(LastGoodStoreError)(error)
            ? error
            : new LastGoodStoreError({ message: String(error) }),
        ),
        Effect.scoped,
      );
    return { read, write };
  });

export const lastGoodStoreLayer = (file: string) =>
  Layer.effect(LastGoodStoreTag, makeLastGoodStore(file));

/** Materialize an archived graph under state storage while preserving relative imports. */
export const restoreLastGood = (
  generation: LastGoodGeneration,
  directory: string,
): Effect.Effect<ReadonlyMap<string, URL>, LastGoodStoreError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const restored = new Map<string, URL>();
    for (const module of generation.modules) {
      if (!module.url.startsWith("file:"))
        return yield* new LastGoodStoreError({
          message: `unsupported saved module '${module.url}'`,
        });
      const target = path.join(directory, fileURLToPath(module.url).replace(/^\/+/, ""));
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, module.text, { mode: 0o600 });
      restored.set(module.url, pathToFileURL(target));
    }
    return restored;
  }).pipe(
    Effect.mapError((error) =>
      S.is(LastGoodStoreError)(error) ? error : new LastGoodStoreError({ message: String(error) }),
    ),
  );
