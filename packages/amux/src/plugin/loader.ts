import { Effect } from "effect";
import { readdirSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { PluginDefinition } from "./types.ts";
import type { PluginHost } from "./host.ts";
import { decodePlugin, hotImport } from "./hot.ts";
import * as sidebarModule from "@danielfgray/amux-plugin-sidebar";
import * as agentHarnessModule from "@danielfgray/amux-plugin-agent-harness";
import * as notificationsModule from "@danielfgray/amux-plugin-notifications";
import * as agentAwarenessModule from "@danielfgray/amux-agent-awareness";

/**
 * The plugins amux ships, named twice on purpose.
 *
 * `load` is a static import bound above: a `bun build --compile` executable
 * resolves a dynamic `import()` of a bare workspace-package specifier against
 * the real filesystem at runtime, which does not exist inside the binary — it
 * embeds the module's code (reachable from the static import) but cannot then
 * find it by name. A static import sidesteps that resolution step entirely.
 * `resolveSource` is the same module resolved to a file on disk (via the
 * workspace symlink in node_modules), which is what a reload re-imports. It
 * is a function, not a value, because `import.meta.resolve` on a bare
 * specifier throws in a compiled binary for the same reason the dynamic
 * `import()` above would — deferring the call lets `builtinSource` turn that
 * failure into "no source" instead of crashing every run of the binary before
 * it reaches plugin loading. A run from source uses that source and is
 * therefore reloadable; a compiled binary falls back to `load`, because there
 * is no source there to reload and nothing to watch.
 */
const BUILTIN_PLUGINS = {
  "builtin:amux.agent-awareness": {
    load: () => Promise.resolve(agentAwarenessModule),
    resolveSource: () => import.meta.resolve("@danielfgray/amux-agent-awareness"),
  },
  "builtin:amux.sidebar": {
    load: () => Promise.resolve(sidebarModule),
    resolveSource: () => import.meta.resolve("@danielfgray/amux-plugin-sidebar"),
  },
  "builtin:amux.agent-harness": {
    load: () => Promise.resolve(agentHarnessModule),
    resolveSource: () => import.meta.resolve("@danielfgray/amux-plugin-agent-harness"),
  },
  "builtin:amux.notifications": {
    load: () => Promise.resolve(notificationsModule),
    resolveSource: () => import.meta.resolve("@danielfgray/amux-plugin-notifications"),
  },
} satisfies Readonly<Record<string, BuiltinEntry>>;

interface BuiltinEntry {
  readonly load: () => Promise<unknown>;
  readonly resolveSource: () => string;
}

function hasOwn<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.hasOwn(record, key);
}

function builtinAt(path: string): BuiltinEntry | undefined {
  if (!hasOwn(BUILTIN_PLUGINS, path)) return undefined;
  return BUILTIN_PLUGINS[path];
}

/** A builtin's source file, or null when running compiled and there is none
 *  on disk to resolve. */
function builtinSource(builtin: BuiltinEntry): URL | null {
  try {
    return new URL(builtin.resolveSource());
  } catch {
    return null;
  }
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
  const root = join(configDir, "plugins");
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
  coreEntries: readonly PluginDefinition[] = [],
) {
  const hot: HotPlugin[] = [];
  const enabled: PluginDefinition[] = [];

  const configured = new Map(config.plugins.map((spec) => [spec.path, spec]));
  const specs = [
    ...config.plugins,
    ...discoveredPlugins(configDir)
      .filter((path) => !configured.has(path))
      .map((path) => ({ path, enabled: true })),
  ];

  for (const spec of specs) {
    // A builtin that cannot be read from disk is a compiled binary, not a
    // broken install: the module is in the bundle, and only reloading is lost.
    const builtin = builtinAt(spec.path);
    const source = builtin ? builtinSource(builtin) : sourceOf(spec.path, configDir);
    if (!source && !builtin) {
      yield* Effect.logWarning(`Ignoring plugin outside config directory: ${spec.path}`);
      continue;
    }

    const fromBuiltin = Effect.tryPromise({
      try: () => builtin!.load(),
      catch: () => "builtin plugin load failed",
    }).pipe(
      Effect.flatMap(decodePlugin),
      Effect.map((definition) => ({ definition, reloadable: false })),
    );
    const loaded = yield* (
      source
        ? hotImport(source).pipe(
            Effect.map((definition) => ({ definition, reloadable: true })),
            Effect.catch((error) => (builtin ? fromBuiltin : Effect.fail(error))),
          )
        : fromBuiltin
    ).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`Could not load plugin '${spec.path}': ${error}`),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (!loaded) continue;

    if (spec.enabled) enabled.push(loaded.definition);
    // `reloadable` is only true when `hotImport(source)` itself succeeded, so
    // `source` is never null here — the guard just proves that to the type
    // checker without a non-null assertion.
    if (loaded.reloadable && source)
      hot.push({
        id: loaded.definition.id,
        path: spec.path,
        source,
        definition: loaded.definition,
      });
  }

  // One configuration, not a plugin at a time: whether an injected key has any
  // provider is only answerable once every entry has been read, and a provider
  // listed after its consumer is still a provider.
  yield* host.reconcile([...coreEntries, ...enabled]).pipe(Effect.catchCause(() => Effect.void));

  return hot as readonly HotPlugin[];
});

/**
 * Where a configured plugin's entry file is, or null if it is somewhere a
 * plugin is not allowed to be. A relative path must stay inside the config
 * directory, symlinks included — that check is why this resolves rather than
 * merely joins.
 */
function sourceOf(specPath: string, configDir: string): URL | null {
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
