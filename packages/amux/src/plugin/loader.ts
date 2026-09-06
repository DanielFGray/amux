import { BunServices } from "@effect/platform-bun";
import { Effect, Path, Schema as S } from "effect";
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
  entrypoint: string = ".",
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
        ? yield* resolveInstalledEntry(spec.package, storeDir, entrypoint).pipe(
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

    const loaded = yield* hotImport(source.url).pipe(
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
    hot.push({ id: loaded.id, path: key, source: source.url, definition: loaded });
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

/** Load only the privileged package export used by a daemon host. */
export const loadDaemonPluginsFromConfig = (
  config: Config,
  host: PluginHost,
  configDir: string,
  coreEntries: readonly PluginDefinition[] = [],
  storeDir: string = PLUGIN_STORE_DIR,
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
  storeDir: string = PLUGIN_STORE_DIR,
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
      let filePath: string;
      try {
        filePath = fileURLToPath(specPath);
      } catch {
        return { _tag: "missing" as const };
      }
      const entry = yield* resolvePathEntry(filePath, entrypoint);
      return entry ? found(entry) : { _tag: "missing" as const };
    });
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (path.isAbsolute(specPath)) {
      const entry = yield* resolvePathEntry(specPath, entrypoint);
      return entry ? found(entry) : { _tag: "missing" as const };
    }
    const resolved = path.resolve(configDir, specPath);
    const entry = yield* resolvePathEntry(resolved, entrypoint);
    if (!entry) return { _tag: "missing" as const };
    const realConfigDir = yield* fs.realPath(configDir).pipe(Effect.orElseSucceed(() => null));
    const realPath = yield* fs.realPath(entry).pipe(Effect.orElseSucceed(() => null));
    if (!realConfigDir || !realPath) return { _tag: "outside-config" as const };
    if (!realPath.startsWith(realConfigDir + path.sep) && realPath !== realConfigDir)
      return { _tag: "outside-config" as const };
    return found(entry);
  });
}

/** Conditional exports (`{import, require, ...}`) are out of scope: every
 *  plugin here is loaded as ESM by one entrypoint string, never re-resolved
 *  under a condition. A manifest using them fails this narrower shape and
 *  falls back to the file-only resolution below. */
const ManifestExports = S.Struct({
  exports: S.optional(S.Record(S.String, S.String)),
});

/** `exports[entrypoint]`, with a single `"./*"`-style wildcard substitution
 *  when no literal key matches — every shape this repo's own plugin
 *  packages declare (see plugin-niri/package.json). */
function resolveExportsSubpath(
  exportsMap: Readonly<Record<string, string>>,
  entrypoint: string,
): string | undefined {
  const direct = exportsMap[entrypoint];
  if (direct !== undefined) return direct;
  for (const [pattern, value] of Object.entries(exportsMap)) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (entrypoint.startsWith(prefix) && entrypoint.endsWith(suffix)) {
      return value.replace("*", entrypoint.slice(prefix.length, entrypoint.length - suffix.length));
    }
  }
  return undefined;
}

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
): Effect.Effect<string | null, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (stat?.type === "Directory") {
      const dir = filePath.replace(/\/$/, "");
      const text = yield* fs
        .readFileString(`${dir}/package.json`)
        .pipe(Effect.orElseSucceed(() => null));
      const parsed: unknown =
        text === null
          ? null
          : yield* S.decodeEffect(S.fromJsonString(S.Unknown))(text).pipe(
              Effect.orElseSucceed(() => null),
            );
      const manifest =
        parsed === null
          ? null
          : yield* S.decodeUnknownEffect(ManifestExports)(parsed).pipe(
              Effect.orElseSucceed(() => null),
            );
      const target =
        manifest?.exports === undefined
          ? undefined
          : resolveExportsSubpath(manifest.exports, entrypoint);
      if (target !== undefined) return `${dir}/${target.replace(/^\.\//, "")}`;
      return entrypoint === "." ? filePath : null;
    }
    if (entrypoint === ".") return filePath;
    try {
      return Bun.resolveSync(entrypoint, filePath.slice(0, filePath.lastIndexOf("/")));
    } catch {
      return null;
    }
  });
}
