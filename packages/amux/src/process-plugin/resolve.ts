import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { errorMessage } from "../error-message.ts";
import { processPluginLaunchEnv, type ProcessPluginInvocationContext } from "./env.ts";
import { getProcessPlugin, type LinkedProcessPlugin, type ProcessPluginRoots } from "./registry.ts";
import type { ProcessPluginPlacement } from "./manifest.ts";

type Fs = FileSystem.FileSystem | Path.Path;

export interface ProcessPluginHostLaunch {
  readonly binPath?: string;
  readonly controlSocket?: string;
  readonly processStateSocket?: string;
  readonly daemonSession?: string;
  readonly roots?: ProcessPluginRoots;
  readonly context?: ProcessPluginInvocationContext;
}

export interface ResolvedProcessPluginAction {
  readonly linked: LinkedProcessPlugin;
  readonly actionId: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface ResolvedProcessPluginPane {
  readonly linked: LinkedProcessPlugin;
  readonly entrypointId: string;
  readonly title: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly placement: ProcessPluginPlacement;
  readonly transient: boolean;
}

/** Resolve a linked manifest action into argv + launch env. */
export const resolveProcessPluginAction = (
  pluginId: string,
  actionId: string,
  host: ProcessPluginHostLaunch = {},
): Effect.Effect<ResolvedProcessPluginAction, string, Fs> =>
  Effect.gen(function* () {
    const linked = yield* getProcessPlugin(pluginId, { roots: host.roots }).pipe(
      Effect.mapError(errorMessage),
    );
    const action = linked.manifest.actions.find((entry) => entry.id === actionId);
    if (action === undefined) {
      return yield* Effect.fail(`process plugin '${pluginId}' has no action '${actionId}'`);
    }
    const [program, ...args] = action.command;
    if (program === undefined) {
      return yield* Effect.fail(`action '${actionId}' has an empty command`);
    }
    return {
      linked,
      actionId,
      argv: [program, ...args],
      cwd: linked.pluginRoot,
      env: yield* processPluginLaunchEnv({
        plugin: linked.manifest,
        pluginRoot: linked.pluginRoot,
        binPath: host.binPath,
        controlSocket: host.controlSocket,
        processStateSocket: host.processStateSocket,
        daemonSession: host.daemonSession,
        actionId,
        context: host.context ?? {
          invocationSource: "resolve",
          correlationId: "process-plugin-action",
        },
        configRoot: host.roots?.configRoot,
        stateRoot: host.roots?.stateRoot,
      }),
    };
  });

/** Resolve a linked manifest pane into argv + launch env for a PTY session. */
export const resolveProcessPluginPane = (
  pluginId: string,
  entrypointId: string,
  host: ProcessPluginHostLaunch = {},
): Effect.Effect<ResolvedProcessPluginPane, string, Fs> =>
  Effect.gen(function* () {
    const linked = yield* getProcessPlugin(pluginId, { roots: host.roots }).pipe(
      Effect.mapError(errorMessage),
    );
    const pane = linked.manifest.panes.find((entry) => entry.id === entrypointId);
    if (pane === undefined) {
      return yield* Effect.fail(`process plugin '${pluginId}' has no pane '${entrypointId}'`);
    }
    const [program, ...args] = pane.command;
    if (program === undefined) {
      return yield* Effect.fail(`pane '${entrypointId}' has an empty command`);
    }
    return {
      linked,
      entrypointId,
      title: pane.title,
      argv: [program, ...args],
      cwd: linked.pluginRoot,
      placement: pane.placement,
      transient: pane.transient,
      env: yield* processPluginLaunchEnv({
        plugin: linked.manifest,
        pluginRoot: linked.pluginRoot,
        binPath: host.binPath,
        controlSocket: host.controlSocket,
        processStateSocket: host.processStateSocket,
        daemonSession: host.daemonSession,
        entrypointId,
        context: host.context ?? {
          invocationSource: "resolve",
          correlationId: "process-plugin-pane",
        },
        configRoot: host.roots?.configRoot,
        stateRoot: host.roots?.stateRoot,
      }),
    };
  });

/**
 * Fire-and-forget spawn for daemon/keybind paths. Stdio is ignored; failures
 * to start surface as Effect errors, but exit status is not awaited.
 */
export const spawnProcessPluginActionDetached = (
  resolved: ResolvedProcessPluginAction,
): Effect.Effect<{ readonly pid: number }, string> =>
  Effect.try({
    try: () => {
      const child = Bun.spawn([...resolved.argv], {
        cwd: resolved.cwd,
        env: { ...process.env, ...resolved.env },
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      return { pid: child.pid };
    },
    catch: (error) => `cannot spawn action '${resolved.actionId}': ${String(error)}`,
  });

/**
 * Rebuild AMUX_PLUGIN_CONTEXT_JSON (and optional sockets) on an already-built
 * pane-open env map — used when the CLI filled a sparse context and the daemon
 * can see the live workspace.
 */
export function enrichProcessPluginPaneEnv(
  env: Readonly<Record<string, string>> | undefined,
  options: {
    readonly context: ProcessPluginInvocationContext;
    readonly controlSocket?: string;
    readonly processStateSocket?: string;
    readonly binPath?: string;
  },
) {
  const next = { ...(env ?? {}) };
  next.AMUX_PLUGIN_CONTEXT_JSON = JSON.stringify(options.context);
  if (options.controlSocket !== undefined) next.AMUX_CONTROL_SOCKET = options.controlSocket;
  if (options.processStateSocket !== undefined) {
    next.AMUX_PROCESS_STATE_SOCKET = options.processStateSocket;
  }
  if (options.binPath !== undefined && next.AMUX_BIN_PATH === undefined) {
    next.AMUX_BIN_PATH = options.binPath;
  }
  return next satisfies Record<string, string>;
}
