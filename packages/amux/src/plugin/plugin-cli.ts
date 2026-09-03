import { Effect } from "effect";
import { BunServices } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  CONFIG_PATH,
  loadConfig,
  pluginSpecKey,
  saveConfig,
  type Config,
  type PluginSpec,
} from "../config.ts";
import {
  installPackage,
  listInstalled,
  parsePackageSpec,
  pluginDirFor,
  readInstalledManifest,
  uninstallPackage,
  PLUGIN_STORE_DIR,
} from "./store.ts";

export const PLUGIN_CLI_HELP = [
  "usage: amux plugin <command> [args]",
  "",
  "  add <spec>    install a plugin and enable it (npm `name[@version]` or a local path)",
  "  rm <name>     disable a plugin and uninstall its package",
  "  ls            list configured plugins and installed packages",
  "  upgrade <name> install the latest version of a configured package",
].join("\n");

/**
 * `amux plugin ...`, carved into core's CLI rather than plugin-registered:
 * these verbs manage the store and the config file, so they must work with
 * zero plugins installed — a process that loaded no plugin registry.
 */
export function runPluginCli(
  argv: readonly string[],
  configPath: string = CONFIG_PATH,
  storeDir: string = PLUGIN_STORE_DIR,
): Promise<number> {
  const writeOut = (text: string) => process.stdout.write(text + "\n");
  const writeErr = (text: string) => process.stderr.write(text + "\n");
  const program = Effect.gen(function* () {
    const [verb, arg] = argv;
    switch (verb) {
      case "add":
        if (arg === undefined || argv.length > 2) {
          writeErr("usage: amux plugin add <spec>");
          return 2;
        }
        return yield* addPlugin(arg, configPath, storeDir).pipe(
          Effect.tap((message) => Effect.sync(() => writeOut(message))),
          Effect.as(0),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${error}`);
              return 1;
            }),
          ),
        );
      case "rm":
        if (arg === undefined || argv.length > 2) {
          writeErr("usage: amux plugin rm <name>");
          return 2;
        }
        return yield* removePlugin(arg, configPath, storeDir).pipe(
          Effect.tap((message) => Effect.sync(() => writeOut(message))),
          Effect.as(0),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${error}`);
              return 1;
            }),
          ),
        );
      case "ls":
        if (argv.length > 1) {
          writeErr("usage: amux plugin ls");
          return 2;
        }
        return yield* listPlugins(configPath, storeDir).pipe(
          Effect.tap((message) => Effect.sync(() => writeOut(message))),
          Effect.as(0),
        );
      case "upgrade":
        if (arg === undefined || argv.length > 2) {
          writeErr("usage: amux plugin upgrade <name>");
          return 2;
        }
        return yield* upgradePlugin(arg, configPath, storeDir).pipe(
          Effect.tap((message) => Effect.sync(() => writeOut(message))),
          Effect.as(0),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${error}`);
              return 1;
            }),
          ),
        );
      case undefined:
        writeOut(PLUGIN_CLI_HELP);
        return 0;
      default:
        writeErr(`unknown plugin command: '${verb}'\n\n${PLUGIN_CLI_HELP}`);
        return 2;
    }
  });
  return Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)));
}

type Fs = FileSystem.FileSystem | Path.Path;

const persist = (
  configPath: string,
  config: Config,
): Effect.Effect<void, string, FileSystem.FileSystem> =>
  saveConfig(config, configPath).pipe(
    Effect.mapError((error) => `cannot save ${configPath}: ${String(error)}`),
  );

const upsertSpec = (config: { plugins: PluginSpec[] }, spec: PluginSpec): PluginSpec[] => {
  const key = pluginSpecKey(spec);
  const index = config.plugins.findIndex((entry) => pluginSpecKey(entry) === key);
  if (index < 0) return [...config.plugins, spec];
  return config.plugins.map((entry, at) =>
    at === index ? { ...entry, ...spec, enabled: true } : entry,
  ) as PluginSpec[];
};

const addPlugin = (
  spec: string,
  configPath: string,
  storeDir: string,
): Effect.Effect<string, string, Fs> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A path the filesystem knows is a path spec; anything else must parse
    // as an npm spec, so a scoped package is never mistaken for a directory.
    const resolved = path.resolve(process.cwd(), spec);
    const known = yield* fs
      .exists(resolved)
      .pipe(Effect.mapError((error) => `cannot stat '${spec}': ${String(error)}`));
    if (known) {
      const config = yield* loadConfig(configPath);
      yield* persist(configPath, {
        ...config,
        plugins: upsertSpec(config, { path: resolved, enabled: true }),
      });
      return `added ${resolved}`;
    }
    const ref = parsePackageSpec(spec);
    if (!ref) return yield* Effect.fail(`not a plugin path or package spec: '${spec}'`);
    const installed = yield* installPackage(ref, storeDir);
    const config = yield* loadConfig(configPath);
    const entry: PluginSpec =
      ref.version === undefined
        ? { package: ref.name, enabled: true }
        : { package: ref.name, version: ref.version, enabled: true };
    yield* persist(configPath, { ...config, plugins: upsertSpec(config, entry) });
    return `added ${ref.name}@${installed.version}`;
  });

const removePlugin = (
  name: string,
  configPath: string,
  storeDir: string,
): Effect.Effect<string, string, Fs> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* loadConfig(configPath);
    const kept = config.plugins.filter((entry) => pluginSpecKey(entry) !== name);
    const configured = kept.length !== config.plugins.length;
    // A store directory counts even when its install never completed: `rm`
    // also cleans up after a failed `add`.
    const stored = yield* fs
      .exists(pluginDirFor(name, storeDir))
      .pipe(Effect.mapError((error) => `cannot stat the plugin store: ${String(error)}`));
    if (!configured && !stored)
      return yield* Effect.fail(`no configured plugin or installed package named '${name}'`);
    if (stored) yield* uninstallPackage(name, storeDir);
    if (configured) yield* persist(configPath, { ...config, plugins: kept });
    return configured ? `removed ${name}` : `uninstalled ${name}`;
  });

const listPlugins = Effect.fnUntraced(function* (configPath: string, storeDir: string) {
  const config = yield* loadConfig(configPath);
  const installed = yield* listInstalled(storeDir);
  const byName = new Map(installed.map((entry) => [entry.name, entry.version]));
  const lines: string[] = [];
  for (const spec of config.plugins) {
    const state = spec.enabled ? "enabled" : "disabled";
    if ("package" in spec) {
      const version = byName.get(spec.package);
      byName.delete(spec.package);
      const pin = spec.version === undefined ? "" : ` (pinned to ${spec.version})`;
      lines.push(
        version === undefined
          ? `${spec.package} — ${state}, not installed${pin}`
          : `${spec.package}@${version} — ${state}${pin}`,
      );
    } else {
      lines.push(`${spec.path} — ${state}`);
    }
  }
  for (const [name, version] of [...byName].sort(([a], [b]) => (a < b ? -1 : 1)))
    lines.push(`${name}@${version} — installed, not configured`);
  return lines.length > 0 ? lines.join("\n") : "no plugins configured or installed";
});

const upgradePlugin = (
  name: string,
  configPath: string,
  storeDir: string,
): Effect.Effect<string, string, Fs> =>
  Effect.gen(function* () {
    const ref = parsePackageSpec(name);
    if (!ref || ref.version !== undefined)
      return yield* Effect.fail(`upgrade takes a package name, not a version: '${name}'`);
    const config = yield* loadConfig(configPath);
    const entry = config.plugins.find((spec) => "package" in spec && spec.package === name);
    const installedBefore = yield* readInstalledManifest(name, storeDir).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!entry && !installedBefore)
      return yield* Effect.fail(`no configured plugin or installed package named '${name}'`);
    const installed = yield* installPackage({ name }, storeDir);
    // A pin stays a pin, refreshed to what was just installed; an unpinned
    // entry keeps tracking whatever the store holds.
    const next =
      entry && "package" in entry && entry.version !== undefined
        ? { package: entry.package, version: installed.version, enabled: true }
        : entry;
    if (next) yield* persist(configPath, { ...config, plugins: upsertSpec(config, next) });
    return `upgraded ${name}@${installed.version}`;
  });
