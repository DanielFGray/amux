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
 */
const xdgDataHome = Effect.runSync(
  EffectConfig.string("XDG_DATA_HOME").pipe(
    EffectConfig.orElse(() =>
      EffectConfig.string("HOME").pipe(EffectConfig.map((home) => join(home, ".local", "share"))),
    ),
    EffectConfig.withDefault(join(".", ".local", "share")),
  ),
);

const xdgConfigHome = Effect.runSync(
  EffectConfig.string("XDG_CONFIG_HOME").pipe(
    EffectConfig.orElse(() =>
      EffectConfig.string("HOME").pipe(EffectConfig.map((home) => join(home, ".config"))),
    ),
    EffectConfig.withDefault(join(".", ".config")),
  ),
);

const xdgStateHome = Effect.runSync(
  EffectConfig.string("XDG_STATE_HOME").pipe(
    EffectConfig.orElse(() =>
      EffectConfig.string("HOME").pipe(EffectConfig.map((home) => join(home, ".local", "state"))),
    ),
    EffectConfig.withDefault(join(".", ".local", "state")),
  ),
);

export const PROCESS_PLUGIN_DATA_DIR = join(xdgDataHome, "amux", "process-plugins");
export const PROCESS_PLUGIN_REGISTRY_PATH = join(PROCESS_PLUGIN_DATA_DIR, "registry.json");
export const PROCESS_PLUGIN_CONFIG_ROOT = join(xdgConfigHome, "amux", "process-plugins");
export const PROCESS_PLUGIN_STATE_ROOT = join(xdgStateHome, "amux", "process-plugins");

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

export function processPluginConfigDir(
  pluginId: string,
  root: string = PROCESS_PLUGIN_CONFIG_ROOT,
): string {
  return join(root, processPluginPathComponent(pluginId));
}

export function processPluginStateDir(
  pluginId: string,
  root: string = PROCESS_PLUGIN_STATE_ROOT,
): string {
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
    const configDir = processPluginConfigDir(pluginId, options.configRoot);
    const stateDir = processPluginStateDir(pluginId, options.stateRoot);
    yield* fs
      .makeDirectory(configDir, { recursive: true })
      .pipe(Effect.mapError((error) => `cannot create ${configDir}: ${String(error)}`));
    yield* fs
      .makeDirectory(stateDir, { recursive: true })
      .pipe(Effect.mapError((error) => `cannot create ${stateDir}: ${String(error)}`));
  });
