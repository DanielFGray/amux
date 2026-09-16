// Path.Path-service adoption is a repo-wide policy decision tracked separately.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { Config as EffectConfig, Effect } from "effect";
import * as FileSystem from "effect/FileSystem";

/**
 * Where linked process plugins are registered and where each plugin's
 * config/state directories live. Separate from the Cordis npm plugin store
 * (`plugin/store.ts`): these are argv packages, not JS modules.
 *
 * Layout (herdr-shaped, amux-named):
 *   $XDG_DATA_HOME/amux/process-plugins/registry.json
 *   $XDG_CONFIG_HOME/amux/process-plugins/<id>/
 *   $XDG_STATE_HOME/amux/process-plugins/<id>/
 *
 * Paths are Effects, not module-level constants: reading XDG at import time
 * was an Effect.runSync side effect. Callers that need the default roots
 * yield them (see `defaultProcessPluginRoots` in registry.ts).
 */

const xdgDataHome = EffectConfig.String("XDG_DATA_HOME").pipe(
  EffectConfig.orElse(() =>
    EffectConfig.String("HOME").pipe(EffectConfig.map((home) => join(home, ".local", "share"))),
  ),
  EffectConfig.withDefault(join(".", ".local", "share")),
);

const xdgConfigHome = EffectConfig.String("XDG_CONFIG_HOME").pipe(
  EffectConfig.orElse(() =>
    EffectConfig.String("HOME").pipe(EffectConfig.map((home) => join(home, ".config"))),
  ),
  EffectConfig.withDefault(join(".", ".config")),
);

const xdgStateHome = EffectConfig.String("XDG_STATE_HOME").pipe(
  EffectConfig.orElse(() =>
    EffectConfig.String("HOME").pipe(EffectConfig.map((home) => join(home, ".local", "state"))),
  ),
  EffectConfig.withDefault(join(".", ".local", "state")),
);

export const processPluginDataDir: Effect.Effect<string> = Effect.map(xdgDataHome, (home) =>
  join(home, "amux", "process-plugins"),
).pipe(Effect.orDie);

export const processPluginRegistryPath: Effect.Effect<string> = Effect.map(
  processPluginDataDir,
  (dir) => join(dir, "registry.json"),
);

export const processPluginConfigRoot: Effect.Effect<string> = Effect.map(xdgConfigHome, (home) =>
  join(home, "amux", "process-plugins"),
).pipe(Effect.orDie);

export const processPluginStateRoot: Effect.Effect<string> = Effect.map(xdgStateHome, (home) =>
  join(home, "amux", "process-plugins"),
).pipe(Effect.orDie);

/** Filesystem-safe path component for a plugin id (percent-encode non-safe bytes). */
export function processPluginPathComponent(pluginId: string): string {
  let component = "";
  for (const byte of Buffer.from(pluginId, "utf8")) {
    if (
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x2d
    ) {
      component += String.fromCharCode(byte);
    } else {
      component += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  if (component.endsWith(".")) {
    component = `${component.slice(0, -1)}%2E`;
  }
  return component.length === 0 ? "%plugin" : component;
}

export function processPluginConfigDir(pluginId: string, root: string): string {
  return join(root, processPluginPathComponent(pluginId));
}

export function processPluginStateDir(pluginId: string, root: string): string {
  return join(root, processPluginPathComponent(pluginId));
}

export const ensureProcessPluginUserDirs = (
  pluginId: string,
  options: {
    readonly configRoot?: string;
    readonly stateRoot?: string;
  } = {},
): Effect.Effect<void, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configRoot = options.configRoot ?? (yield* processPluginConfigRoot);
    const stateRoot = options.stateRoot ?? (yield* processPluginStateRoot);
    const configDir = processPluginConfigDir(pluginId, configRoot);
    const stateDir = processPluginStateDir(pluginId, stateRoot);
    yield* fs
      .makeDirectory(configDir, { recursive: true })
      .pipe(Effect.mapError((error) => `cannot create ${configDir}: ${String(error)}`));
    yield* fs
      .makeDirectory(stateDir, { recursive: true })
      .pipe(Effect.mapError((error) => `cannot create ${stateDir}: ${String(error)}`));
  });
