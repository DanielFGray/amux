import { Effect, ExecutionStrategy, Exit, Fiber, Queue, Runtime, Scope, Stream } from "effect";
import type { PanelContext } from "../ui/panel.ts";
import type { Panel, Regions } from "../ui/regions.tsx";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
import type { SessionViews } from "./session-views.tsx";
import type { CommandSpec } from "../bindings.ts";
import { createPluginKV } from "./kv.ts";
import type {
  PluginDefinition,
  PluginErrorEvent,
  PluginHostContext,
  PluginKV,
  PluginStatus,
  PluginSettingsSection,
} from "./types.ts";

export type {
  PluginDefinition,
  PluginHostContext,
  PluginErrorEvent,
  PluginStatus,
} from "./types.ts";

export interface PluginHost {
  readonly add: (plugin: PluginDefinition) => Effect.Effect<void>;
  readonly remove: (id: string) => Effect.Effect<void>;
  readonly onError: Stream.Stream<PluginErrorEvent>;
  readonly status: () => readonly PluginStatus[];
  readonly dispose: Effect.Effect<void>;
}

const SUPPORTED_API_VERSION = "1";

interface PluginState {
  readonly scope: Scope.CloseableScope;
  fiber: Fiber.RuntimeFiber<void, never>;
  readonly definition: PluginDefinition;
  error: string | null;
}

/**
 * Everything a plugin can reach, in one place.
 *
 * Every field is required. An optional collaborator here would mean a host that
 * accepts a registration and silently drops it — a plugin cannot tell that from
 * a registration that worked, and the caller who left the field out cannot tell
 * either.
 */
export interface PluginEnvironment {
  readonly panel: PanelContext;
  readonly regions: Regions;
  readonly sessionViews: SessionViews;
  readonly registerBinding: (binding: CommandSpec) => () => void;
  readonly registerSettingsSection: (section: PluginSettingsSection) => () => void;
  readonly frames: (session: string) => Stream.Stream<AttachFrame, unknown>;
  readonly sync: (session: string) => void;
}

export function createPluginHost(
  env: PluginEnvironment,
): Effect.Effect<PluginHost, never, Scope.Scope> {
  return Effect.gen(function* () {
    const rt = yield* Effect.runtime<Scope.Scope>();
    const errorQueue = yield* Queue.unbounded<PluginErrorEvent>();
    const activePlugins = new Map<string, PluginState>();
    const kvStores = new Map<string, PluginKV>();
    const hostScope = yield* Scope.make();
    let disposed = false;

    yield* Effect.addFinalizer(() => disposeAll());

    function emitError(e: PluginErrorEvent): void {
      if (disposed) return;
      Runtime.runSync(rt)(Queue.offer(errorQueue, e));
    }

    function kvFor(pluginId: string): PluginKV {
      let kv = kvStores.get(pluginId);
      if (!kv) {
        kv = createPluginKV();
        kvStores.set(pluginId, kv);
      }
      return kv;
    }

    function makeContext(pluginId: string, scope: Scope.CloseableScope): PluginHostContext {
      /** Every registration is undone when the plugin's scope closes, so a
       *  disabled or crashed plugin leaves nothing of itself behind. */
      const scoped = (dispose: () => void): (() => void) => {
        Runtime.runSync(rt)(Scope.addFinalizer(scope, Effect.sync(dispose)));
        return dispose;
      };
      return {
        id: pluginId,
        panel: env.panel,
        kv: kvFor(pluginId),
        registerPanel: (panel: Panel) => scoped(env.regions.register(panel)),
        registerPaneType: (type, view) => scoped(env.sessionViews.register(type, view)),
        registerBinding: (binding) => scoped(env.registerBinding(binding)),
        registerSettingsSection: (section) => scoped(env.registerSettingsSection(section)),
        frames: env.frames,
        sync: env.sync,
      };
    }

    const addPlugin = Effect.fnUntraced(function* (plugin: PluginDefinition) {
      if (disposed) {
        emitError({
          pluginId: plugin.id,
          phase: "activate",
          source: "host",
          error: new Error("Plugin host is disposed"),
          timestamp: Date.now(),
        });
        return;
      }

      if (plugin.apiVersion !== SUPPORTED_API_VERSION) {
        emitError({
          pluginId: plugin.id,
          phase: "activate",
          source: "host",
          error: new Error(
            `Plugin '${plugin.id}' declares apiVersion '${plugin.apiVersion}' but this host supports '${SUPPORTED_API_VERSION}'`,
          ),
          timestamp: Date.now(),
        });
        return;
      }

      // Adding an id that is already running replaces it. There is no separate
      // reload: a plugin is its id, and the newest definition of it is the one
      // that runs. The old scope closes first, so a registration the new
      // instance makes under the same name finds the name free.
      yield* removePlugin(plugin.id);

      const pluginScope = yield* Scope.fork(hostScope, ExecutionStrategy.sequential);
      const context = makeContext(plugin.id, pluginScope);
      const pluginEffect = plugin.effect(context).pipe(
        Effect.catchAllDefect((defect) => {
          const error = defect instanceof Error ? defect : new Error(String(defect));
          emitError({
            pluginId: plugin.id,
            phase: "activate",
            source: "plugin",
            error,
            timestamp: Date.now(),
          });
          activePlugins.delete(plugin.id);
          return Scope.close(pluginScope, Exit.die(error));
        }),
        Effect.provideService(Scope.Scope, pluginScope),
      );

      const fiber = yield* Effect.forkIn(pluginEffect, hostScope);
      activePlugins.set(plugin.id, {
        scope: pluginScope,
        fiber,
        definition: plugin,
        error: null,
      });
      yield* Effect.yieldNow();
    });

    const removePlugin = Effect.fnUntraced(function* (id: string) {
      const state = activePlugins.get(id);
      if (!state) return;
      activePlugins.delete(id);
      yield* Fiber.interrupt(state.fiber);
      yield* Fiber.await(state.fiber);
      yield* Scope.close(state.scope, Exit.void);
    });

    const disposeAll = Effect.fnUntraced(function* () {
      if (disposed) return;
      disposed = true;
      yield* Scope.close(hostScope, Exit.void);
      activePlugins.clear();
      kvStores.clear();
      yield* Queue.shutdown(errorQueue);
    });

    return {
      add: addPlugin,
      remove: removePlugin,
      onError: Stream.fromQueue(errorQueue),
      status() {
        if (disposed) return [];
        const result: PluginStatus[] = [];
        for (const [id, state] of activePlugins) {
          result.push({ id, active: true, error: state.error });
        }
        return result;
      },
      dispose: Effect.suspend(disposeAll),
    };
  });
}
