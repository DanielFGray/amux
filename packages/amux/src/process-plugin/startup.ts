import { Effect, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { processPluginLaunchEnv, type ProcessPluginInvocationContext } from "./env.ts";
import { getProcessPlugin, listProcessPlugins } from "./registry.ts";
import type { ProcessPluginHostLaunch } from "./resolve.ts";

type Fs = FileSystem.FileSystem | Path.Path;

export interface ProcessPluginStartupHost extends ProcessPluginHostLaunch {
  readonly daemonSession: string;
  readonly controlSocket: string;
  readonly binPath: string;
  readonly onLog?: (message: string) => void;
}

/**
 * Run every enabled linked plugin's `[[startup]]` commands.
 * Each child is scoped: interrupt (daemon shutdown) kills the process.
 * Borrow: herdr `run_plugin_startup_hooks` — once after restore, event=startup.
 */
export const runProcessPluginStartups = (
  host: ProcessPluginStartupHost,
): Effect.Effect<void, never, Fs | Scope.Scope> =>
  Effect.gen(function* () {
    const listed = yield* listProcessPlugins({ roots: host.roots }).pipe(
      Effect.orElseSucceed(() => []),
    );
    const log = host.onLog ?? (() => undefined);
    for (const entry of listed) {
      if (!entry.enabled) continue;
      const linked = yield* getProcessPlugin(entry.pluginId, { roots: host.roots }).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (linked === null || linked.manifest.startup.length === 0) continue;
      for (const [index, startup] of linked.manifest.startup.entries()) {
        const [program, ...args] = startup.command;
        if (program === undefined) {
          log(`process-plugin ${linked.pluginId} startup[${index}]: empty command`);
          continue;
        }
        const context: ProcessPluginInvocationContext = {
          ...(host.context ?? {}),
          invocationSource: "startup",
          correlationId: "process-plugin-startup",
        };
        const env = yield* processPluginLaunchEnv({
          plugin: linked.manifest,
          pluginRoot: linked.pluginRoot,
          binPath: host.binPath,
          controlSocket: host.controlSocket,
          processStateSocket: host.processStateSocket,
          daemonSession: host.daemonSession,
          event: "startup",
          context,
          configRoot: host.roots?.configRoot,
          stateRoot: host.roots?.stateRoot,
        });
        const label = `process-plugin ${linked.pluginId} startup[${index}]`;
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            const child = yield* Effect.try({
              try: () =>
                Bun.spawn([program, ...args], {
                  cwd: linked.pluginRoot,
                  env: { ...process.env, ...env },
                  stdout: "ignore",
                  stderr: "ignore",
                  stdin: "ignore",
                }),
              catch: (error) => `${label}: ${String(error)}`,
            });
            log(`${label}: pid=${child.pid}`);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                try {
                  process.kill(child.pid);
                } catch {
                  /* already exited */
                }
              }),
            );
            yield* Effect.promise(() => child.exited);
            log(`${label}: exited`);
          }).pipe(
            Effect.catch((message) =>
              Effect.sync(() => {
                log(String(message));
              }),
            ),
          ),
        );
      }
    }
  }).pipe(Effect.asVoid);
