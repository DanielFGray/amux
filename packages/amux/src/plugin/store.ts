// Path.Path-service adoption is a repo-wide policy decision tracked separately,
// not something to half-apply in one file.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { Config as EffectConfig, Effect, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";

/**
 * Where installed plugins live: one isolated install tree per plugin under
 * the XDG data dir, so a plugin's own dependencies resolve normally without
 * polluting or being polluted by anything else on the machine.
 *
 * Every function below takes the store dir as an optional trailing
 * parameter defaulting here, so tests can point at a scratch directory
 * instead of the real store.
 */
export const PLUGIN_STORE_DIR = join(
  Effect.runSync(
    EffectConfig.string("XDG_DATA_HOME").pipe(
      EffectConfig.orElse(() =>
        EffectConfig.string("HOME").pipe(EffectConfig.map((home) => join(home, ".local", "share"))),
      ),
      EffectConfig.withDefault(join(".", ".local", "share")),
    ),
    // Resolved once at module load (before any Effect runtime exists), the
    // same way config.ts resolves the config dir.
  ),
  "amux",
  "plugins",
);

/** The store subdirectory for a package: `@scope/name` flattens to `scope__name`. */
export function pluginDirFor(packageName: string, storeDir: string = PLUGIN_STORE_DIR): string {
  return join(storeDir, packageName.replace(/^@/, "").replace("/", "__"));
}

export interface PackageRef {
  readonly name: string;
  readonly version?: string;
}

/**
 * Split `name` or `name@version` (scoped names included) into its parts.
 * Null when the text is not shaped like an npm package spec — a filesystem
 * path is never one of these, so `plugin add` tries the filesystem first.
 */
export function parsePackageSpec(spec: string): PackageRef | null {
  const text = spec.trim();
  if (!text || /\s/.test(text)) return null;
  let name = text;
  let version: string | undefined;
  const at = text.startsWith("@") ? text.indexOf("@", 1) : text.indexOf("@");
  if (at > 0) {
    name = text.slice(0, at);
    version = text.slice(at + 1) || undefined;
    if (!version) return null;
  }
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) return null;
  return version === undefined ? { name } : { name, version };
}

const InstalledManifest = S.Struct({
  name: S.String,
  version: S.String,
  engines: S.optional(
    S.Struct({
      amux: S.optional(S.String),
    }),
  ),
});

const readJsonFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError((error) => `cannot read ${path}: ${String(error)}`));
  return yield* S.decodeEffect(S.fromJsonString(S.Unknown))(text).pipe(
    Effect.mapError(() => `cannot parse ${path}: not JSON`),
  );
});

const decodeManifest = (path: string, value: unknown) =>
  S.decodeUnknownEffect(InstalledManifest)(value).pipe(
    Effect.mapError(() => `cannot parse ${path}: not a package manifest`),
  );

/** The installed package's own manifest: version plus its `engines.amux` range, if any. */
export const readInstalledManifest = (
  packageName: string,
  storeDir: string = PLUGIN_STORE_DIR,
): Effect.Effect<{ version: string; enginesAmux?: string }, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = join(
      pluginDirFor(packageName, storeDir),
      "node_modules",
      packageName,
      "package.json",
    );
    return yield* readJsonFile(path).pipe(
      Effect.flatMap((value) => decodeManifest(path, value)),
      Effect.map((manifest) => {
        const enginesAmux = manifest.engines?.amux;
        return enginesAmux === undefined
          ? { version: manifest.version }
          : { version: manifest.version, enginesAmux };
      }),
    );
  });

/** The entry file of an installed package, resolved the way an import would. */
export const resolveInstalledEntry = (
  packageName: string,
  storeDir: string = PLUGIN_STORE_DIR,
): Effect.Effect<string, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = pluginDirFor(packageName, storeDir);
    yield* fs
      .stat(dir)
      .pipe(Effect.mapError(() => `plugin '${packageName}' is not installed (no store directory)`));
    return yield* Effect.try({
      try: () => Bun.resolveSync(packageName, dir),
      catch: () => `plugin '${packageName}' is installed but has no resolvable entry point`,
    });
  });

/**
 * Install a package into its own store directory by self-invoking this
 * binary as a plain Bun CLI (`BUN_BE_BUN`), per
 * docs/adr/0001-plugin-install-via-bun-self-invocation.md. No bundled
 * package-manager library: `bun add` reifies the isolated tree.
 */
export const installPackage = (
  ref: PackageRef,
  storeDir: string = PLUGIN_STORE_DIR,
): Effect.Effect<{ version: string }, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = pluginDirFor(ref.name, storeDir);
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.mapError((error) => `cannot create ${dir}: ${String(error)}`));
    const descriptor = join(dir, "package.json");
    const described = yield* fs
      .exists(descriptor)
      .pipe(Effect.mapError((error) => `cannot stat ${descriptor}: ${String(error)}`));
    if (!described) {
      yield* fs
        .writeFileString(
          descriptor,
          `{\n  "name": "amux-installed-plugin",\n  "private": true\n}\n`,
        )
        .pipe(Effect.mapError((error) => `cannot write ${descriptor}: ${String(error)}`));
    }
    const target = ref.version === undefined ? ref.name : `${ref.name}@${ref.version}`;
    const exitCode = yield* Effect.tryPromise({
      try: () => {
        const child = Bun.spawn([process.execPath, "add", target], {
          cwd: dir,
          env: { ...process.env, BUN_BE_BUN: "1" },
          stdout: "inherit",
          stderr: "inherit",
        });
        return child.exited;
      },
      catch: (error) => `cannot install '${target}': ${String(error)}`,
    });
    if (exitCode !== 0)
      return yield* Effect.fail(`cannot install '${target}': bun exited ${exitCode}`);
    const manifest = yield* readInstalledManifest(ref.name, storeDir);
    return { version: manifest.version };
  });

/** Drop a plugin's whole store directory. A missing one is already gone. */
export const uninstallPackage = (
  packageName: string,
  storeDir: string = PLUGIN_STORE_DIR,
): Effect.Effect<void, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .remove(pluginDirFor(packageName, storeDir), { recursive: true, force: true })
      .pipe(Effect.mapError((error) => `cannot remove '${packageName}': ${String(error)}`));
  });

export interface InstalledPlugin {
  readonly name: string;
  readonly version: string;
}

/** Every store directory whose install completed (manifest present and readable). */
export const listInstalled = Effect.fnUntraced(function* (storeDir: string = PLUGIN_STORE_DIR) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(storeDir).pipe(Effect.orElseSucceed(() => []));
  const found: InstalledPlugin[] = [];
  for (const entry of [...entries].sort()) {
    const path = join(storeDir, entry, "package.json");
    const dependencies = yield* readJsonFile(path).pipe(
      Effect.map(
        (value) => (value as { dependencies?: Record<string, string> }).dependencies ?? {},
      ),
      Effect.orElseSucceed(() => ({})),
    );
    for (const name of Object.keys(dependencies).sort()) {
      const manifest = yield* readInstalledManifest(name, storeDir).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (manifest) found.push({ name, version: manifest.version });
    }
  }
  return found;
});
