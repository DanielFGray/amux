import { Effect } from "effect";
import { readdirSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { PluginDefinition } from "./types.ts";
import type { PluginHost } from "./host.ts";
import { decodePlugin, hotImport } from "./hot.ts";

/**
 * The plugins amux ships, named twice on purpose.
 *
 * `load` is a literal specifier so `bun build --compile` still finds them and
 * puts them in the binary. `source` is the same module as a file on disk, which
 * is what a reload re-imports. A run from source uses `source` and is therefore
 * reloadable; a compiled binary falls back to `load`, because there is no source
 * there to reload and nothing to watch.
 */
const BUILTIN_PLUGINS: Readonly<Record<string, BuiltinEntry>> = {
  "builtin:amux.sidebar": {
    load: () => import("./builtin/sidebar.tsx"),
    source: new URL("./builtin/sidebar.tsx", import.meta.url),
  },
  "builtin:amux.agent-harness": {
    load: () => import("./builtin/agent-harness.tsx"),
    source: new URL("./builtin/agent-harness.tsx", import.meta.url),
  },
  "builtin:amux.notifications": {
    load: () => import("./builtin/notifications.ts"),
    source: new URL("./builtin/notifications.ts", import.meta.url),
  },
};

interface BuiltinEntry {
  readonly load: () => Promise<unknown>;
  readonly source: URL;
}

/** A plugin whose source amux can see, and can therefore load again. */
export interface HotPlugin {
  readonly id: string;
  readonly path?: string;
  readonly source: URL;
  readonly definition: PluginDefinition;
}

/** Discover user entry files without making discovery a second loading path. */
function discoveredPlugins(configDir: string): readonly string[] {
  const root = join(dirname(configDir), "opentui-herdr", "plugins");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:[cm]?js|[cm]?ts)x?$/.test(entry.name))
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export const loadPluginsFromConfig = Effect.fnUntraced(function* (
  config: Config,
  host: PluginHost,
  configDir: string,
) {
  const hot: HotPlugin[] = [];

  const configured = new Map(config.plugins.map((spec) => [spec.path, spec]));
  const specs = [
    ...config.plugins,
    ...discoveredPlugins(configDir)
      .filter((path) => !configured.has(path))
      .map((path) => ({ path, enabled: true })),
  ];

  for (const spec of specs) {
    const source = sourceOf(spec.path, configDir);
    if (!source) {
      yield* Effect.logWarning(`Ignoring plugin outside config directory: ${spec.path}`);
      continue;
    }

    // A builtin that cannot be read from disk is a compiled binary, not a
    // broken install: the module is in the bundle, and only reloading is lost.
    const builtin = BUILTIN_PLUGINS[spec.path];
    const loaded = yield* hotImport(source).pipe(
      Effect.map((definition) => ({ definition, reloadable: true })),
      Effect.catchAll((error) =>
        builtin
          ? Effect.tryPromise({ try: builtin.load, catch: String }).pipe(
              Effect.flatMap(decodePlugin),
              Effect.map((definition) => ({ definition, reloadable: false })),
            )
          : Effect.fail(error),
      ),
      Effect.tapError((error) =>
        Effect.logWarning(`Could not load plugin '${spec.path}': ${error}`),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (!loaded) continue;

    if (spec.enabled)
      yield* host.add(loaded.definition).pipe(Effect.catchAllCause(() => Effect.void));
    if (loaded.reloadable)
      hot.push({
        id: loaded.definition.id,
        path: spec.path,
        source,
        definition: loaded.definition,
      });
  }

  return hot as readonly HotPlugin[];
});

/**
 * Where a configured plugin's entry file is, or null if it is somewhere a
 * plugin is not allowed to be. A relative path must stay inside the config
 * directory, symlinks included — that check is why this resolves rather than
 * merely joins.
 */
function sourceOf(specPath: string, configDir: string): URL | null {
  const builtin = BUILTIN_PLUGINS[specPath];
  if (builtin) return builtin.source;
  if (specPath.startsWith("file://")) {
    try {
      return pathToFileURL(fileURLToPath(specPath));
    } catch {
      return null;
    }
  }
  if (isAbsolute(specPath)) return pathToFileURL(specPath);
  const resolved = resolve(configDir, specPath);
  let realConfigDir: string;
  let realPath: string;
  try {
    realConfigDir = realpathSync.native(configDir);
    realPath = realpathSync.native(resolved);
  } catch {
    return null;
  }
  if (!realPath.startsWith(realConfigDir + "/") && realPath !== realConfigDir) return null;
  return pathToFileURL(resolved);
}
