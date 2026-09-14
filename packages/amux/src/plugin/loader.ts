import { BunServices } from "@effect/platform-bun";
import { Effect, Option, Path, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pluginSpecKey, type Config, type PluginSpec } from "../config.ts";
import type { PluginDefinition } from "./types.ts";
import type { PluginHost, RefusedPlugin } from "./host.ts";
import { hotImport, resolveExportsSubpath } from "./hot.ts";
import { checkPluginCompat } from "./compat.ts";
import { pluginStoreDir, resolveInstalledEntry } from "./store.ts";
import { lastGoodStoreLayer, LastGoodStoreTag, restoreLastGood } from "./last-good.ts";

/**
 * A loader-owned plugin: Cordis entry with `url` (Def. 81). The host activates
 * `definition`; the reloader re-imports `source`. There is no separate "hot"
 * plugin kind — reloadability is having an entry.
 */
export interface PluginEntry {
  readonly id: string;
  readonly path?: string;
  readonly source: URL;
  readonly definition: PluginDefinition;
}

export interface LoadedPlugins {
  readonly entries: readonly PluginEntry[];
  /** Startup imported archived source instead of the current disk files. */
  readonly recovered: boolean;
  /** Entries the host's configuration could not satisfy — see `RefusedPlugin`. */
  readonly refused: readonly RefusedPlugin[];
}

/** Discover user entry files without making discovery a second loading path. */
function discoveredPlugins(configDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(configDir, "plugins");
    const entries = yield* fs.readDirectory(root);
    return yield* Effect.forEach(entries, (name) =>
      fs.stat(path.join(root, name)).pipe(
        Effect.map((info) =>
          info.type === "File" && /\.(?:[cm]?js|[cm]?ts)x?$/.test(name)
            ? path.join(root, name)
            : null,
        ),
        Effect.orElseSucceed(() => null),
      ),
    ).pipe(Effect.map((paths) => paths.filter((value): value is string => value !== null)));
  }).pipe(Effect.orElseSucceed(() => [] as readonly string[]));
}

const loadPluginsFromConfigEffect = Effect.fnUntraced(function* (
  config: Config,
  host: PluginHost,
  configDir: string,
  coreEntries: readonly PluginDefinition[] = [],
  storeDir?: string,
  entrypoint: string = ".",
) {
  const resolvedStore = storeDir ?? (yield* pluginStoreDir);
  const entries: PluginEntry[] = [];
  const enabled: PluginDefinition[] = [];
  const path = yield* Path.Path;
  const recovery = yield* LastGoodStoreTag.pipe(
    Effect.provide(lastGoodStoreLayer(path.join(configDir, ".amux", "plugin-last-good.json"))),
  );
  const saved = yield* recovery.read.pipe(Effect.orElseSucceed(() => Option.none()));
  const restored = yield* Option.match(saved, {
    onNone: () => Effect.succeed(new Map<string, URL>()),
    onSome: (archive) =>
      archive.quarantined
        ? restoreLastGood(archive, path.join(configDir, ".amux", "plugin-last-good")).pipe(
            Effect.orElseSucceed(() => new Map<string, URL>()),
          )
        : Effect.succeed(new Map<string, URL>()),
  });
  if (restored.size > 0)
    yield* Effect.logWarning(
      "plugins are running the last-known-good archived source; run 'amux plugin.reload --disk' to retry files on disk",
    );

  const configured = new Map(config.plugins.map((spec) => [pluginSpecKey(spec), spec]));
  const specs: readonly PluginSpec[] = [
    ...config.plugins,
    ...(yield* discoveredPlugins(configDir))
      .filter((path) => !configured.has(path))
      .map((path) => ({ path, enabled: true })),
  ];

  for (const spec of specs) {
    const key = pluginSpecKey(spec);
    const source =
      "package" in spec
        ? yield* resolveInstalledEntry(spec.package, resolvedStore, entrypoint).pipe(
            Effect.map((entry): SourceResolution => ({ _tag: "found", url: pathToFileURL(entry) })),
            Effect.tapError((error) =>
              Effect.logWarning(`Could not load plugin '${key}': ${error}`),
            ),
            Effect.orElseSucceed((): SourceResolution => ({ _tag: "missing" })),
          )
        : yield* sourceOf(spec.path, configDir, entrypoint);
    // A plugin simply not implementing the requested host variant ("./daemon",
    // "./cli", ...) is the ordinary case — most plugins only implement ".".
    // Only a relative path that resolved outside the config directory is an
    // actual refusal worth telling the user about.
    if (source._tag === "outside-config" && !("package" in spec))
      yield* Effect.logWarning(`Ignoring plugin outside config directory: ${spec.path}`);
    if (source._tag !== "found") continue;

    const imported = restored.get(source.url.href) ?? source.url;
    const loaded = yield* hotImport(imported).pipe(
      Effect.tapError((error) => Effect.logWarning(`Could not load plugin '${key}': ${error}`)),
      Effect.orElseSucceed(() => null),
    );
    if (!loaded) continue;

    const compatible = yield* checkPluginCompat(source.url, loaded.id).pipe(
      Effect.tapError((error) => Effect.logWarning(error)),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!compatible) continue;

    if (spec.enabled) enabled.push(loaded);
    entries.push({ id: loaded.id, path: key, source: source.url, definition: loaded });
  }

  // One configuration, not a plugin at a time: whether an injected key has any
  // provider is only answerable once every entry has been read, and a provider
  // listed after its consumer is still a provider.
  const refused = yield* host
    .reconcile([...coreEntries, ...enabled])
    .pipe(Effect.catchCause(() => Effect.succeed([] as readonly RefusedPlugin[])));

  return { entries, recovered: restored.size > 0, refused } as LoadedPlugins;
});

export const loadPluginsFromConfig = (...args: Parameters<typeof loadPluginsFromConfigEffect>) =>
  loadPluginsFromConfigEffect(...args).pipe(Effect.provide(BunServices.layer));

/** Load only the privileged package export used by a daemon host. */
export const loadDaemonPluginsFromConfig = (
  config: Config,
  host: PluginHost,
  configDir: string,
  coreEntries: readonly PluginDefinition[] = [],
  storeDir?: string,
) =>
  loadPluginsFromConfigEffect(config, host, configDir, coreEntries, storeDir, "./daemon").pipe(
    Effect.provide(BunServices.layer),
  );

/** Load only the CLI-command export used by the headless dispatch host — a
 *  setup verb like an agent-hook installer, which injects `CliCommandsTag`
 *  and so can never activate under any other host. */
export const loadCliPluginsFromConfig = (
  config: Config,
  host: PluginHost,
  configDir: string,
  coreEntries: readonly PluginDefinition[] = [],
  storeDir?: string,
) =>
  loadPluginsFromConfigEffect(config, host, configDir, coreEntries, storeDir, "./cli").pipe(
    Effect.provide(BunServices.layer),
  );

/**
 * Where a configured plugin's entry file is for the requested host variant
 * ("." for the interactive UI, "./daemon", "./cli", ...). Most plugins only
 * implement "."; a plugin missing the requested variant is the ordinary case
 * (`"missing"`), not a refusal. `"outside-config"` is the real refusal: a
 * relative path must stay inside the config directory, symlinks included —
 * that check is why this resolves rather than merely joins.
 */
type SourceResolution =
  | { readonly _tag: "found"; readonly url: URL }
  | { readonly _tag: "missing" }
  | { readonly _tag: "outside-config" };

function sourceOf(
  specPath: string,
  configDir: string,
  entrypoint: string = ".",
): Effect.Effect<SourceResolution, never, FileSystem.FileSystem | Path.Path> {
  const found = (entry: string): SourceResolution => ({ _tag: "found", url: pathToFileURL(entry) });
  if (specPath.startsWith("file://")) {
    return Effect.gen(function* () {
      const filePath = yield* Effect.try(() => fileURLToPath(specPath)).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      return yield* Option.match(filePath, {
        onNone: () => Effect.succeed({ _tag: "missing" as const }),
        onSome: (resolvedPath) =>
          resolvePathEntry(resolvedPath, entrypoint).pipe(
            Effect.map((entry) =>
              Option.match(entry, {
                onNone: () => ({ _tag: "missing" as const }),
                onSome: found,
              }),
            ),
          ),
      });
    });
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (path.isAbsolute(specPath)) {
      const entry = yield* resolvePathEntry(specPath, entrypoint);
      return Option.match(entry, {
        onNone: () => ({ _tag: "missing" as const }),
        onSome: found,
      });
    }
    const resolved = path.resolve(configDir, specPath);
    const entry = yield* resolvePathEntry(resolved, entrypoint);
    return yield* Option.match(entry, {
      onNone: () => Effect.succeed({ _tag: "missing" as const }),
      onSome: (entryPath) =>
        Effect.gen(function* () {
          const realConfigDir = yield* fs.realPath(configDir).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none<string>()),
          );
          const realPath = yield* fs.realPath(entryPath).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none<string>()),
          );
          return Option.match(realConfigDir, {
            onNone: () => ({ _tag: "outside-config" as const }),
            onSome: (configPath) =>
              Option.match(realPath, {
                onNone: () => ({ _tag: "outside-config" as const }),
                onSome: (resolvedPath) =>
                  !resolvedPath.startsWith(configPath + path.sep) && resolvedPath !== configPath
                    ? { _tag: "outside-config" as const }
                    : found(entryPath),
              }),
          });
        }),
    });
  });
}

/** Conditional exports (`{import, require, ...}`) are out of scope: every
 *  plugin here is loaded as ESM by one entrypoint string, never re-resolved
 *  under a condition. A manifest using them fails this narrower shape and
 *  falls back to the file-only resolution below. */
const ManifestExports = S.Struct({
  exports: S.optional(S.Record(S.String, S.String)),
});

/**
 * Where a plugin's entrypoint file actually is. A directory names the
 * package itself, so its own package.json's `exports` map — the same
 * resolution an installed package gets from `resolveInstalledEntry` —
 * decides every variant, "." included. A file names the entry directly:
 * only "." can mean the file itself, and any other variant falls back to
 * the sibling-relative convention every in-repo plugin package already
 * follows (`./daemon` sits beside `index.ts` in the same `src/`
 * directory). Deliberately not resolved by walking up to some *enclosing*
 * package.json: a bare dev-file plugin dropped inside another package's own
 * source tree (as amux's own plugin loader tests do, and as a real
 * `$configDir/plugins/*.ts` file might) must not inherit that package's
 * unrelated exports map.
 */
function resolvePathEntry(
  filePath: string,
  entrypoint: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolveFile = () =>
      entrypoint === "."
        ? Effect.succeed(Option.some(filePath))
        : Effect.try(() =>
            Bun.resolveSync(entrypoint, filePath.slice(0, filePath.lastIndexOf("/"))),
          ).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none<string>()),
          );
    const resolveDirectory = Effect.fnUntraced(function* () {
      const dir = filePath.replace(/\/$/, "");
      const text = yield* fs.readFileString(path.join(dir, "package.json")).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      const manifest = yield* Option.match(text, {
        onNone: () => Effect.succeed(Option.none<S.Schema.Type<typeof ManifestExports>>()),
        onSome: (contents) =>
          S.decodeEffect(S.fromJsonString(ManifestExports))(contents).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none<S.Schema.Type<typeof ManifestExports>>()),
          ),
      });
      const target = yield* Option.match(manifest, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (value) =>
          Option.match(Option.fromUndefinedOr(value.exports), {
            onNone: () => Effect.succeed(Option.none<string>()),
            onSome: (exports) =>
              Effect.succeed(Option.fromUndefinedOr(resolveExportsSubpath(exports, entrypoint))),
          }),
      });
      return Option.match(target, {
        onNone: () => (entrypoint === "." ? Option.some(filePath) : Option.none()),
        onSome: (targetPath) => Option.some(path.join(dir, targetPath.replace(/^\.\//, ""))),
      });
    });
    const stat = yield* fs.stat(filePath).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none()),
    );
    return yield* Option.match(stat, {
      onNone: resolveFile,
      onSome: (info) => (info.type === "Directory" ? resolveDirectory() : resolveFile()),
    });
  });
}
