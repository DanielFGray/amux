import { Effect, Schema as S } from "effect";
import type { ProcessPluginManifest } from "./manifest.ts";
import {
  processPluginConfigDir,
  processPluginConfigRoot,
  processPluginStateDir,
  processPluginStateRoot,
} from "./paths.ts";

/**
 * Environment injected into out-of-process plugin commands.
 *
 * Shape borrows herdr's plugin env contract (id/root/config/state/context/
 * entrypoint) and cmux's "socket + marker" minimalism. Names are AMUX_*, not
 * HERDR_* — this is an inspired API, not a compatibility layer.
 */
export const PROCESS_PLUGIN_PROTECTED_ENV_KEYS = [
  "AMUX_ENV",
  "AMUX_BIN_PATH",
  "AMUX_CONTROL_SOCKET",
  "AMUX_PROCESS_STATE_SOCKET",
  "AMUX_DAEMON_SESSION",
  "AMUX_PLUGIN_ID",
  "AMUX_PLUGIN_ROOT",
  "AMUX_PLUGIN_CONFIG_DIR",
  "AMUX_PLUGIN_STATE_DIR",
  "AMUX_PLUGIN_CONTEXT_JSON",
  "AMUX_PLUGIN_ACTION_ID",
  "AMUX_PLUGIN_ENTRYPOINT_ID",
  "AMUX_PLUGIN_EVENT",
  "AMUX_PLUGIN_EVENT_JSON",
] as const;

export type ProcessPluginProtectedEnvKey = (typeof PROCESS_PLUGIN_PROTECTED_ENV_KEYS)[number];

export function isProcessPluginProtectedEnvKey(key: string): boolean {
  return (PROCESS_PLUGIN_PROTECTED_ENV_KEYS as readonly string[]).includes(key);
}

export interface ProcessPluginInvocationContext {
  readonly spaceId?: string;
  readonly spaceLabel?: string;
  readonly spaceCwd?: string;
  readonly windowNumber?: number;
  readonly windowLabel?: string;
  readonly focusedPaneId?: string;
  readonly focusedPaneCwd?: string;
  readonly invocationSource?: string;
  readonly correlationId?: string;
}

export interface ProcessPluginLaunchOptions {
  readonly plugin: ProcessPluginManifest;
  readonly pluginRoot: string;
  /** Absolute path to the amux CLI entry plugins should re-invoke. */
  readonly binPath?: string;
  /** Control socket, when known at launch (panes usually get it from the daemon). */
  readonly controlSocket?: string;
  readonly processStateSocket?: string;
  /** Daemon session id — required for CLI callbacks from startup/actions. */
  readonly daemonSession?: string;
  readonly context?: ProcessPluginInvocationContext;
  readonly actionId?: string;
  readonly entrypointId?: string;
  readonly event?: string;
  readonly eventJson?: string;
  /** Caller-supplied env; protected keys are stripped before host injection. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly configRoot?: string;
  readonly stateRoot?: string;
}

const encodeContextJson = S.encodeSync(S.fromJsonString(S.Unknown));

/** Build the env map for a process-plugin action or pane. */
export const processPluginLaunchEnv = Effect.fnUntraced(function* (
  options: ProcessPluginLaunchOptions,
) {
  const env: Record<string, string> = {};
  if (options.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      if (!isProcessPluginProtectedEnvKey(key)) env[key] = value;
    }
  }

  const configRoot = options.configRoot ?? (yield* processPluginConfigRoot);
  const stateRoot = options.stateRoot ?? (yield* processPluginStateRoot);

  env.AMUX_ENV = "1";
  env.AMUX_PLUGIN_ID = options.plugin.id;
  env.AMUX_PLUGIN_ROOT = options.pluginRoot;
  env.AMUX_PLUGIN_CONFIG_DIR = processPluginConfigDir(options.plugin.id, configRoot);
  env.AMUX_PLUGIN_STATE_DIR = processPluginStateDir(options.plugin.id, stateRoot);

  if (options.binPath !== undefined) env.AMUX_BIN_PATH = options.binPath;
  if (options.controlSocket !== undefined) env.AMUX_CONTROL_SOCKET = options.controlSocket;
  if (options.processStateSocket !== undefined) {
    env.AMUX_PROCESS_STATE_SOCKET = options.processStateSocket;
  }
  if (options.daemonSession !== undefined) env.AMUX_DAEMON_SESSION = options.daemonSession;
  if (options.actionId !== undefined) env.AMUX_PLUGIN_ACTION_ID = options.actionId;
  if (options.entrypointId !== undefined) env.AMUX_PLUGIN_ENTRYPOINT_ID = options.entrypointId;
  if (options.event !== undefined) env.AMUX_PLUGIN_EVENT = options.event;
  if (options.eventJson !== undefined) env.AMUX_PLUGIN_EVENT_JSON = options.eventJson;

  env.AMUX_PLUGIN_CONTEXT_JSON = encodeContextJson(options.context ?? {});

  return env;
});
