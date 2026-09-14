/**
 * Host-side UI half announcement: resolve "." entries and digest the reload
 * boundary (entry file plus companions under a digest root).
 */
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Option, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** One published UI half clients may load. Keyed by pluginSpecKey, not definePlugin id. */
export const PluginUiHalfSchema = S.Struct({
  key: S.String,
  /** File URL of the "." entry; absent when the plugin has no UI half. */
  uiEntry: S.optionalKey(S.String),
  /** Hex digest of the UI entry plus every file under the digest root. */
  digest: S.String,
});
export type PluginUiHalf = typeof PluginUiHalfSchema.Type;

export const PluginPublicationAnnouncementSchema = S.Struct({
  revision: S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(0))),
  plugins: S.Array(PluginUiHalfSchema),
});
export type PluginPublicationAnnouncement = typeof PluginPublicationAnnouncementSchema.Type;

/**
 * Digest the UI reload boundary: entry bytes plus every file under `root`.
 * File specs pass pluginRoot; package / directory specs pass the package directory.
 */
export const digestUiClosure = (
  entry: URL,
  root: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hash = createHash("sha256");
    const entryPath = fileURLToPath(entry);
    const entryText = yield* fs.readFileString(entryPath).pipe(Effect.orElseSucceed(() => ""));
    hash.update(entryPath);
    hash.update("\0");
    hash.update(entryText);
    const walk = (dir: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): string[] => []));
        for (const name of names.toSorted()) {
          // Package digests must not follow install trees into the monorepo store.
          if (name === "node_modules") continue;
          const full = path.join(dir, name);
          if (full === entryPath) continue;
          const info = yield* fs.stat(full).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none()),
          );
          yield* Option.match(info, {
            onNone: () => Effect.void,
            onSome: (stat) =>
              stat.type === "Directory"
                ? walk(full)
                : stat.type === "File"
                  ? fs.readFileString(full).pipe(
                      Effect.map((text) => {
                        hash.update(full);
                        hash.update("\0");
                        hash.update(text);
                      }),
                      Effect.orElseSucceed(() => undefined),
                    )
                  : Effect.void,
          });
        }
      });
    const rootInfo = yield* fs.stat(root).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none()),
    );
    yield* Option.match(rootInfo, {
      onNone: () => Effect.void,
      onSome: (stat) => (stat.type === "Directory" ? walk(root) : Effect.void),
    });
    return hash.digest("hex");
  });

export const digestAndAnnounce = (
  key: string,
  uiEntry: URL | undefined,
  digestRoot: string,
): Effect.Effect<PluginUiHalf, never, FileSystem.FileSystem | Path.Path> =>
  uiEntry === undefined
    ? Effect.succeed({ key, digest: "" })
    : digestUiClosure(uiEntry, digestRoot).pipe(
        Effect.map((digest) => ({ key, uiEntry: uiEntry.href, digest })),
      );

export const uiEntryUrl = (href: string): URL =>
  href.startsWith("file:") ? new URL(href) : pathToFileURL(href);
