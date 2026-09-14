import { Clock, Effect, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  loadProcessPluginManifest,
  ProcessPluginManifestError,
  type ProcessPluginManifest,
} from "./manifest.ts";
import {
  ensureProcessPluginUserDirs,
  processPluginConfigRoot,
  processPluginRegistryPath,
  processPluginStateRoot,
} from "./paths.ts";

export const LinkedProcessPluginSchema = S.Struct({
  pluginId: S.String.pipe(S.check(S.isMinLength(1))),
  name: S.String.pipe(S.check(S.isMinLength(1))),
  version: S.String.pipe(S.check(S.isMinLength(1))),
  description: S.optional(S.String),
  pluginRoot: S.String.pipe(S.check(S.isMinLength(1))),
  enabled: S.Boolean,
  linkedAtUnixMs: S.Finite.pipe(S.check(S.isGreaterThanOrEqualTo(0))),
});

export type LinkedProcessPlugin = typeof LinkedProcessPluginSchema.Type;

export const ProcessPluginRegistrySchema = S.Struct({
  plugins: S.Array(LinkedProcessPluginSchema),
});

export type ProcessPluginRegistry = typeof ProcessPluginRegistrySchema.Type;

export class ProcessPluginRegistryError extends S.TaggedError<ProcessPluginRegistryError>()(
  "ProcessPluginRegistryError",
  { message: S.String },
) {}

export type ProcessPluginError = ProcessPluginRegistryError | ProcessPluginManifestError;

export interface ProcessPluginRoots {
  readonly registryPath: string;
  readonly configRoot: string;
  readonly stateRoot: string;
}

export const defaultProcessPluginRoots: Effect.Effect<ProcessPluginRoots> = Effect.gen(
  function* () {
    return {
      registryPath: yield* processPluginRegistryPath,
      configRoot: yield* processPluginConfigRoot,
      stateRoot: yield* processPluginStateRoot,
    };
  },
);

const emptyRegistry = (): ProcessPluginRegistry => ({ plugins: [] });

const readRegistry = (
  registryPath: string,
): Effect.Effect<ProcessPluginRegistry, ProcessPluginRegistryError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(registryPath)
      .pipe(Effect.mapError((error) => new ProcessPluginRegistryError({ message: String(error) })));
    if (!exists) return emptyRegistry();
    const text = yield* fs.readFileString(registryPath).pipe(
      Effect.mapError(
        (error) =>
          new ProcessPluginRegistryError({
            message: `cannot read ${registryPath}: ${String(error)}`,
          }),
      ),
    );
    return yield* S.decodeEffect(S.fromJsonString(ProcessPluginRegistrySchema))(text).pipe(
      Effect.mapError(
        (error) =>
          new ProcessPluginRegistryError({
            message: `invalid registry ${registryPath}: ${String(error)}`,
          }),
      ),
    );
  });

const writeRegistry = (
  registryPath: string,
  registry: ProcessPluginRegistry,
): Effect.Effect<void, ProcessPluginRegistryError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.dirname(registryPath);
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new ProcessPluginRegistryError({
            message: `cannot create ${dir}: ${String(error)}`,
          }),
      ),
    );
    const encoded = yield* S.encodeEffect(
      S.fromJsonString(ProcessPluginRegistrySchema, { space: 2 }),
    )(registry).pipe(
      Effect.mapError(
        (error) =>
          new ProcessPluginRegistryError({
            message: `cannot encode registry: ${String(error)}`,
          }),
      ),
    );
    const tmp = `${registryPath}.tmp`;
    yield* fs.writeFileString(tmp, `${encoded}\n`).pipe(
      Effect.mapError(
        (error) =>
          new ProcessPluginRegistryError({
            message: `cannot write ${tmp}: ${String(error)}`,
          }),
      ),
    );
    yield* fs.rename(tmp, registryPath).pipe(
      Effect.mapError(
        (error) =>
          new ProcessPluginRegistryError({
            message: `cannot rename ${tmp}: ${String(error)}`,
          }),
      ),
    );
  });

export interface LinkedProcessPluginInfo extends LinkedProcessPlugin {
  readonly manifest: ProcessPluginManifest;
}

const resolveRoot = (
  pluginRoot: string,
): Effect.Effect<string, ProcessPluginRegistryError, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.isAbsolute(pluginRoot) ? pluginRoot : path.resolve(pluginRoot);
  });

/** Link (or re-link) a process-plugin directory into the registry. */
export const linkProcessPlugin = (
  pluginRoot: string,
  options: {
    readonly enabled?: boolean;
    readonly roots?: ProcessPluginRoots;
  } = {},
): Effect.Effect<LinkedProcessPluginInfo, ProcessPluginError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const roots = options.roots ?? (yield* defaultProcessPluginRoots);
    const absolute = yield* resolveRoot(pluginRoot);
    const manifest = yield* loadProcessPluginManifest(absolute);
    yield* ensureProcessPluginUserDirs(manifest.id, {
      configRoot: roots.configRoot,
      stateRoot: roots.stateRoot,
    }).pipe(Effect.mapError((message) => new ProcessPluginRegistryError({ message })));
    const linkedAtUnixMs = yield* Clock.currentTimeMillis;
    const entry: LinkedProcessPlugin = {
      pluginId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      pluginRoot: absolute,
      enabled: options.enabled ?? true,
      linkedAtUnixMs,
      description: manifest.description,
    };
    const registry = yield* readRegistry(roots.registryPath);
    const plugins = [
      ...registry.plugins.filter((plugin) => plugin.pluginId !== manifest.id),
      entry,
    ].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    yield* writeRegistry(roots.registryPath, { plugins });
    return { ...entry, manifest };
  });

/** Unregister a process plugin; leaves the plugin directory alone. */
export const unlinkProcessPlugin = (
  pluginId: string,
  options: { readonly roots?: ProcessPluginRoots } = {},
): Effect.Effect<boolean, ProcessPluginRegistryError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const roots = options.roots ?? (yield* defaultProcessPluginRoots);
    const registry = yield* readRegistry(roots.registryPath);
    const kept = registry.plugins.filter((plugin) => plugin.pluginId !== pluginId);
    if (kept.length === registry.plugins.length) return false;
    yield* writeRegistry(roots.registryPath, { plugins: kept });
    return true;
  });

/** List linked process plugins (registry rows only; manifests are not re-read). */
export const listProcessPlugins = (
  options: { readonly roots?: ProcessPluginRoots } = {},
): Effect.Effect<
  readonly LinkedProcessPlugin[],
  ProcessPluginRegistryError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const roots = options.roots ?? (yield* defaultProcessPluginRoots);
    const registry = yield* readRegistry(roots.registryPath);
    return registry.plugins;
  });

/** Resolve one linked plugin and re-load its manifest from disk. */
export const getProcessPlugin = (
  pluginId: string,
  options: { readonly roots?: ProcessPluginRoots } = {},
): Effect.Effect<LinkedProcessPluginInfo, ProcessPluginError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const roots = options.roots ?? (yield* defaultProcessPluginRoots);
    const registry = yield* readRegistry(roots.registryPath);
    const entry = registry.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (entry === undefined) {
      return yield* new ProcessPluginRegistryError({
        message: `process plugin '${pluginId}' is not linked`,
      });
    }
    if (!entry.enabled) {
      return yield* new ProcessPluginRegistryError({
        message: `process plugin '${pluginId}' is disabled`,
      });
    }
    const manifest = yield* loadProcessPluginManifest(entry.pluginRoot);
    return { ...entry, manifest };
  });
