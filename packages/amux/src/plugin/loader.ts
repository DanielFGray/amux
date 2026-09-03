import { BunServices } from "@effect/platform-bun";
import { Effect, Path } from "effect";
import * as FileSystem from "effect/FileSystem";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pluginSpecKey, type Config, type PluginSpec } from "../config.ts";
import type { PluginDefinition } from "./types.ts";
import type { PluginHost, RefusedPlugin } from "./host.ts";
import { hotImport } from "./hot.ts";
import { checkPluginCompat } from "./compat.ts";
import { PLUGIN_STORE_DIR, resolveInstalledEntry } from "./store.ts";

/** A plugin whose source amux can see, and can therefore load again. */
export interface HotPlugin {
  readonly id: string;
  readonly path?: string;
  readonly source: URL;
  readonly definition: PluginDefinition;
}

export interface LoadedPlugins {
  readonly hot: readonly HotPlugin[];
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
  storeDir: string = PLUGIN_STORE_DIR,
) {
  const hot: HotPlugin[] = [];
  const enabled: PluginDefinition[] = [];

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
        ? yield* resolveInstalledEntry(spec.package, storeDir).pipe(
            Effect.map((entry) => pathToFileURL(entry)),
            Effect.tapError((error) =>
              Effect.logWarning(`Could not load plugin '${key}': ${error}`),
            ),
            Effect.orElseSucceed(() => null),
          )
        : yield* sourceOf(spec.path, configDir);
    if (!source) {
      if (!("package" in spec))
        yield* Effect.logWarning(`Ignoring plugin outside config directory: ${spec.path}`);
      continue;
    }

    const loaded = yield* hotImport(source).pipe(
      Effect.tapError((error) => Effect.logWarning(`Could not load plugin '${key}': ${error}`)),
      Effect.orElseSucceed(() => null),
    );
    if (!loaded) continue;

    const compatible = yield* checkPluginCompat(source, loaded.id).pipe(
      Effect.tapError((error) => Effect.logWarning(error)),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!compatible) continue;

    if (spec.enabled) enabled.push(loaded);
    hot.push({ id: loaded.id, path: key, source, definition: loaded });
  }

  // One configuration, not a plugin at a time: whether an injected key has any
  // provider is only answerable once every entry has been read, and a provider
  // listed after its consumer is still a provider.
  const refused = yield* host
    .reconcile([...coreEntries, ...enabled])
    .pipe(Effect.catchCause(() => Effect.succeed([] as readonly RefusedPlugin[])));

  return { hot, refused } as LoadedPlugins;
});

export const loadPluginsFromConfig = (...args: Parameters<typeof loadPluginsFromConfigEffect>) =>
  loadPluginsFromConfigEffect(...args).pipe(Effect.provide(BunServices.layer));

/**
 * Where a configured plugin's entry file is, or null if it is somewhere a
 * plugin is not allowed to be. A relative path must stay inside the config
 * directory, symlinks included — that check is why this resolves rather than
 * merely joins.
 */
function sourceOf(specPath: string, configDir: string) {
  if (specPath.startsWith("file://")) {
    try {
      return Effect.succeed(pathToFileURL(fileURLToPath(specPath)));
    } catch {
      return Effect.succeed(null);
    }
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (path.isAbsolute(specPath)) return pathToFileURL(specPath);
    const resolved = path.resolve(configDir, specPath);
    const realConfigDir = yield* fs.realPath(configDir).pipe(Effect.orElseSucceed(() => null));
    const realPath = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => null));
    if (!realConfigDir || !realPath) return null;
    if (!realPath.startsWith(realConfigDir + path.sep) && realPath !== realConfigDir) return null;
    return pathToFileURL(resolved);
  });
}
