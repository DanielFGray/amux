import { Effect } from "effect";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { PluginDefinition } from "./types.ts";
import type { PluginHost } from "./host.ts";
import { sidebarPlugin } from "./builtin/sidebar.tsx";

const BUILTIN_PLUGINS: Readonly<Record<string, PluginDefinition>> = {
  "builtin:amux.sidebar": sidebarPlugin,
};

function resolvePluginPath(specPath: string, configDir: string): string | null {
  if (specPath.startsWith("file://")) {
    try {
      return fileURLToPath(specPath);
    } catch {
      return null;
    }
  }
  if (isAbsolute(specPath)) return specPath;
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
  return resolved;
}

function validatePluginShape(mod: unknown): PluginDefinition | null {
  if (mod === null || typeof mod !== "object") return null;
  const m = mod as Record<string, unknown>;
  if (!m.default || typeof m.default !== "object" || m.default === null) return null;
  const d = m.default as Record<string, unknown>;
  if (typeof d.id !== "string" || d.id.length === 0) return null;
  if (typeof d.apiVersion !== "string") return null;
  if (typeof d.effect !== "function") return null;
  return {
    id: d.id,
    apiVersion: d.apiVersion,
    effect: d.effect as PluginDefinition["effect"],
  };
}

export const loadPluginsFromConfig = Effect.fnUntraced(function* (
  config: Config,
  host: PluginHost,
  configDir: string,
) {
  for (const spec of config.plugins) {
    if (!spec.enabled) continue;

    const builtin = BUILTIN_PLUGINS[spec.path];
    if (builtin) {
      yield* host.add(builtin).pipe(Effect.catchAllCause(() => Effect.void));
      continue;
    }

    const resolved = resolvePluginPath(spec.path, configDir);
    if (!resolved) {
      yield* Effect.logWarning(`Ignoring plugin outside config directory: ${spec.path}`);
      continue;
    }

    const mod = yield* Effect.tryPromise({
      try: () => import(resolved),
      catch: (cause) => ({ _tag: "PluginLoadError" as const, cause }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`Could not import plugin '${spec.path}': ${String(error.cause)}`),
      ),
      Effect.orElseSucceed(() => null),
    );

    if (mod === null) continue;

    const plugin = validatePluginShape(mod);
    if (!plugin) {
      yield* Effect.logWarning(`Ignoring plugin with invalid default export: ${spec.path}`);
      continue;
    }

    yield* host.add(plugin).pipe(Effect.catchAllCause(() => Effect.void));
  }
});
