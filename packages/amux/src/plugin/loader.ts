import { BunServices } from "@effect/platform-bun";
import { Effect, Option, Path, Result, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pluginSpecKey, type PluginSpec } from "../config.ts";
import type { PluginLoadFailure } from "../plugin-behaviour.ts";
import type { PluginDefinition } from "./types.ts";
import type { PluginHost, RefusedPlugin } from "./host.ts";
import { hotImport, hotModuleClosure, pluginRoot, resolveExportsSubpath } from "./hot.ts";
import { checkPluginCompat } from "./compat.ts";
import { pluginDirFor, pluginStoreDir, resolveInstalledEntry } from "./store.ts";
import {
  lastGoodStoreLayer,
  LastGoodStoreTag,
  restoreLastGood,
  type LastGoodGeneration,
  type LastGoodModule,
} from "./last-good.ts";
import { digestAndAnnounce, type PluginUiHalf } from "./ui-announcement.ts";

/**
 * A loader-owned plugin: Cordis entry with `url` (Def. 81). The host activates
 * `definition`; clients re-import `source` from the published UI announcement.
 */
export interface PluginEntry {
  readonly id: string;
  readonly path?: string;
  readonly source: URL;
  readonly definition: PluginDefinition;
}

/**
 * An entry the loader actually imported. `modules` are the texts that import
 * ran from — checkpoint writes them and never re-reads disk.
 */
export interface LoadedPluginEntry extends PluginEntry {
  readonly modules: readonly LastGoodModule[];
}

/** Host `prepare`/`publish` rejected the configuration; the previous one is unchanged. */
export class PluginReconcileError extends S.TaggedError<PluginReconcileError>()(
  "PluginReconcileError",
  { message: S.String },
) {}

export interface LoadedPlugins {
  readonly entries: readonly LoadedPluginEntry[];
  /** Startup imported archived source for at least one plugin that failed on disk. */
  readonly recovered: boolean;
  /** Entries the host's configuration could not satisfy — see `RefusedPlugin`. */
  readonly refused: readonly RefusedPlugin[];
  /** Enabled specs that failed to import or pass compat; may still be in `entries`. */
  readonly failures: readonly PluginLoadFailure[];
  /** Specs considered for this load (config + discovery + host-supplied scratch). */
  readonly specs: readonly PluginSpec[];
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

const loadPluginsEffect = Effect.fnUntraced(function* (
  plugins: readonly PluginSpec[],
  host: PluginHost,
  configDir: string,
  coreEntries: readonly PluginDefinition[] = [],
  previous: readonly LoadedPluginEntry[] = [],
  storeDir?: string,
  entrypoint: string = ".",
) {
  const resolvedStore = storeDir ?? (yield* pluginStoreDir);
  const entries: LoadedPluginEntry[] = [];
  const enabled: PluginDefinition[] = [];
  const failures: PluginLoadFailure[] = [];
  let recovered = false;
  const previousByKey = new Map<string, LoadedPluginEntry>();
  for (const entry of previous) {
    if (entry.path !== undefined) previousByKey.set(entry.path, entry);
  }
  const path = yield* Path.Path;
  const recovery = yield* LastGoodStoreTag.pipe(
    Effect.provide(lastGoodStoreLayer(path.join(configDir, ".amux", "plugin-last-good.json"))),
  );
  const saved = yield* recovery.read.pipe(Effect.orElseSucceed(() => Option.none()));
  const archiveDir = path.join(configDir, ".amux", "plugin-last-good");

  const configured = new Map(plugins.map((spec) => [pluginSpecKey(spec), spec]));
  const specs: readonly PluginSpec[] = [
    ...plugins,
    ...(yield* discoveredPlugins(configDir))
      .filter((discovered) => !configured.has(discovered))
      .map((discovered) => ({ path: discovered, enabled: true })),
  ];

  const keepPrevious = (key: string, reason: string): boolean => {
    const prior = previousByKey.get(key);
    if (prior === undefined) return false;
    failures.push({ spec: key, reason });
    enabled.push(prior.definition);
    entries.push(prior);
    return true;
  };

  type ArchivedCandidate = {
    readonly url: URL;
    readonly restored: ReadonlyMap<string, URL>;
    readonly archive: LastGoodGeneration;
  };

  const tryArchived = (
    diskUrl: URL,
  ): Effect.Effect<Option.Option<ArchivedCandidate>, never, FileSystem.FileSystem | Path.Path> =>
    Option.match(saved, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (archive) =>
        archive.modules.some((module) => module.url === diskUrl.href)
          ? restoreLastGood(archive, archiveDir).pipe(
              Effect.map((restored) => {
                const url = restored.get(diskUrl.href);
                return url === undefined ? Option.none() : Option.some({ url, restored, archive });
              }),
              Effect.orElseSucceed(() => Option.none()),
            )
          : Effect.succeed(Option.none()),
    });

  /** Import a candidate URL and check compat against the on-disk source URL. */
  const importAndCompat = (importUrl: URL, diskUrl: URL) =>
    Effect.gen(function* () {
      const imported = yield* hotImport(importUrl).pipe(Effect.result);
      if (Result.isFailure(imported)) {
        return { _tag: "fail" as const, reason: imported.failure };
      }
      const compat = yield* checkPluginCompat(diskUrl, imported.success.id).pipe(Effect.result);
      if (Result.isFailure(compat)) {
        return { _tag: "fail" as const, reason: compat.failure };
      }
      return { _tag: "ok" as const, definition: imported.success };
    });

  /**
   * Read the reloadable closure after a successful import. Window: Bun has
   * already evaluated the files; an edit between that import and this read is
   * still possible (.tsx/.js bypass the onLoad hook).
   */
  const recordDiskModules = (
    source: URL,
  ): Effect.Effect<readonly LastGoodModule[], string, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* Effect.forEach(hotModuleClosure([source]), (url) =>
        fs.readFileString(fileURLToPath(url)).pipe(
          Effect.map((text): LastGoodModule => ({ url: url.href, text })),
          Effect.mapError((error) => `could not record '${url}': ${error.message}`),
        ),
      );
    });

  /** Map the archived import closure back to the disk URLs and archived texts. */
  const recordArchivedModules = (
    importUrl: URL,
    restored: ReadonlyMap<string, URL>,
    archive: LastGoodGeneration,
  ): readonly LastGoodModule[] => {
    const restoredToDisk = new Map(
      [...restored.entries()].map(([disk, url]) => [url.href, disk] as const),
    );
    const textByDisk = new Map(archive.modules.map((module) => [module.url, module.text] as const));
    const modules: LastGoodModule[] = [];
    for (const url of hotModuleClosure([importUrl])) {
      const diskHref = restoredToDisk.get(url.href);
      if (diskHref === undefined) continue;
      const text = textByDisk.get(diskHref);
      if (text === undefined) continue;
      modules.push({ url: diskHref, text });
    }
    return modules;
  };

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

    const disk = yield* importAndCompat(source.url, source.url);
    if (disk._tag === "ok") {
      const recorded = yield* recordDiskModules(source.url).pipe(Effect.result);
      if (Result.isSuccess(recorded)) {
        if (spec.enabled) enabled.push(disk.definition);
        entries.push({
          id: disk.definition.id,
          path: key,
          source: source.url,
          definition: disk.definition,
          modules: recorded.success,
        });
        continue;
      }
      yield* Effect.logWarning(`Could not load plugin '${key}': ${recorded.failure}`);
      if (!spec.enabled) continue;
      if (keepPrevious(key, recorded.failure)) continue;
      failures.push({ spec: key, reason: recorded.failure });
      continue;
    }

    yield* Effect.logWarning(`Could not load plugin '${key}': ${disk.reason}`);
    if (!spec.enabled) continue;
    if (keepPrevious(key, disk.reason)) continue;
    const archived = yield* tryArchived(source.url);
    if (Option.isNone(archived)) {
      failures.push({ spec: key, reason: disk.reason });
      continue;
    }
    const restored = yield* importAndCompat(archived.value.url, source.url);
    if (restored._tag === "fail") {
      failures.push({ spec: key, reason: disk.reason });
      continue;
    }
    recovered = true;
    yield* Effect.logWarning(`plugin '${key}' failed on disk; running archived last-good source`);
    enabled.push(restored.definition);
    entries.push({
      id: restored.definition.id,
      path: key,
      source: source.url,
      definition: restored.definition,
      modules: recordArchivedModules(
        archived.value.url,
        archived.value.restored,
        archived.value.archive,
      ),
    });
  }

  // One configuration, not a plugin at a time: whether an injected key has any
  // provider is only answerable once every entry has been read, and a provider
  // listed after its consumer is still a provider. Staging only — callers that
  // need the tables visible must `publish` (or use loadPlugins / loadCliPlugins).
  const { refused } = yield* host
    .prepare([...coreEntries, ...enabled])
    .pipe(Effect.mapError((message) => new PluginReconcileError({ message })));

  return { entries, recovered, refused, failures, specs } satisfies LoadedPlugins;
});

const publishLoaded = (host: PluginHost) =>
  host.publish.pipe(Effect.mapError((message) => new PluginReconcileError({ message })));

export const loadPlugins = (
  plugins: readonly PluginSpec[],
  host: PluginHost,
  configDir: string,
  coreEntries: readonly PluginDefinition[] = [],
  previous: readonly LoadedPluginEntry[] = [],
  storeDir?: string,
) =>
  loadPluginsEffect(plugins, host, configDir, coreEntries, previous, storeDir, ".").pipe(
    Effect.tap(() => publishLoaded(host)),
    Effect.provide(BunServices.layer),
  );

/** Stage daemon plugins without publishing — host Prepare RPC. */
export const prepareDaemonPlugins = (
  plugins: readonly PluginSpec[],
  host: PluginHost,
  configDir: string,
  coreEntries: readonly PluginDefinition[] = [],
  previous: readonly LoadedPluginEntry[] = [],
  storeDir?: string,
) =>
  loadPluginsEffect(plugins, host, configDir, coreEntries, previous, storeDir, "./daemon").pipe(
    Effect.provide(BunServices.layer),
  );

/** Load only the CLI-command export used by the headless dispatch host — a
 *  setup verb like an agent-hook installer, which injects `CliCommandsTag`
 *  and so can never activate under any other host. */
export const loadCliPlugins = (
  plugins: readonly PluginSpec[],
  host: PluginHost,
  configDir: string,
  coreEntries: readonly PluginDefinition[] = [],
  previous: readonly LoadedPluginEntry[] = [],
  storeDir?: string,
) =>
  loadPluginsEffect(plugins, host, configDir, coreEntries, previous, storeDir, "./cli").pipe(
    Effect.tap(() => publishLoaded(host)),
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
export type SourceResolution =
  | { readonly _tag: "found"; readonly url: URL }
  | { readonly _tag: "missing" }
  | { readonly _tag: "outside-config" };

export function sourceOf(
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
 * Resolve a filesystem path to the file that implements `entrypoint`.
 *
 * A directory is a package: its `package.json` exports map decides every
 * variant, "." included — the same resolution an installed package gets from
 * `resolveInstalledEntry`. A file names the entry directly: "." is the file
 * itself; any other variant resolves under `pluginRoot` (`<stem>/daemon.ts`).
 * Package layouts that need sibling `src/daemon.ts` must be directory specs.
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
        : Effect.try(() => Bun.resolveSync(entrypoint, pluginRoot(pathToFileURL(filePath)))).pipe(
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

/**
 * Resolve UI halves for the load set without importing them.
 * Announced by pluginSpecKey; the client learns definePlugin id on import.
 */
export const collectUiHalves = (
  specs: readonly PluginSpec[],
  configDir: string,
  storeDir?: string,
): Effect.Effect<readonly PluginUiHalf[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const resolvedStore = storeDir ?? (yield* pluginStoreDir);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const halves: PluginUiHalf[] = [];
    const seen = new Set<string>();
    for (const spec of specs) {
      if (!spec.enabled) continue;
      const key = pluginSpecKey(spec);
      if (seen.has(key)) continue;
      const ui =
        "package" in spec
          ? yield* resolveInstalledEntry(spec.package, resolvedStore, ".").pipe(
              Effect.map((entry): SourceResolution => ({
                _tag: "found",
                url: pathToFileURL(entry),
              })),
              Effect.orElseSucceed((): SourceResolution => ({ _tag: "missing" })),
            )
          : yield* sourceOf(spec.path, configDir, ".");
      if (ui._tag !== "found") continue;
      seen.add(key);
      const digestRoot =
        "package" in spec
          ? pluginDirFor(spec.package, resolvedStore)
          : yield* Effect.gen(function* () {
              const resolved = path.resolve(configDir, spec.path);
              const info = yield* fs.stat(resolved).pipe(
                Effect.map(Option.some),
                Effect.orElseSucceed(() => Option.none()),
              );
              return Option.match(info, {
                onNone: () => pluginRoot(ui.url),
                onSome: (stat) =>
                  stat.type === "Directory" ? resolved.replace(/\/$/, "") : pluginRoot(ui.url),
              });
            });
      halves.push(yield* digestAndAnnounce(key, ui.url, digestRoot));
    }
    return halves;
  });

/** Checkpoint committed plugin sources after a successful Publish. */
export const checkpointLastGood = (
  configDir: string,
  entries: readonly LoadedPluginEntry[],
): Effect.Effect<void, string, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (entries.length === 0) return;
    const path = yield* Path.Path;
    const store = yield* LastGoodStoreTag.pipe(
      Effect.provide(lastGoodStoreLayer(path.join(configDir, ".amux", "plugin-last-good.json"))),
    );
    const seen = new Set<string>();
    const modules: LastGoodModule[] = [];
    for (const entry of entries) {
      for (const module of entry.modules) {
        if (seen.has(module.url)) continue;
        seen.add(module.url);
        modules.push(module);
      }
    }
    const generation: LastGoodGeneration = {
      version: 1,
      entries: entries.map((entry) => entry.source.href),
      modules,
    };
    yield* store.write(generation).pipe(Effect.mapError((error) => error.message));
  });
