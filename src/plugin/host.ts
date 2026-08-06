import { Effect, ExecutionStrategy, Exit, Fiber, Queue, Runtime, Scope, Stream } from "effect";
import type { PanelContext } from "../ui/panel.ts";
import type { Panel, Regions } from "../ui/regions.tsx";
import { createPluginKV } from "./kv.ts";
import type {
  PluginDefinition,
  PluginErrorEvent,
  PluginHostContext,
  PluginKV,
  PluginStatus,
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

export function createPluginHost(
  panelCtx: PanelContext,
  regions: Regions,
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
      return {
        id: pluginId,
        panel: panelCtx,
        kv: kvFor(pluginId),
        registerPanel(panel: Panel) {
          const dispose = regions.register(panel);
          Runtime.runSync(rt)(Scope.addFinalizer(scope, Effect.sync(dispose)));
          return dispose;
        },
      };
    }

    function addPlugin(plugin: PluginDefinition): Effect.Effect<void> {
      return Effect.gen(function* () {
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

        if (activePlugins.has(plugin.id)) {
          emitError({
            pluginId: plugin.id,
            phase: "activate",
            source: "host",
            error: new Error(`Plugin '${plugin.id}' is already active`),
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
    }

    function removePlugin(id: string): Effect.Effect<void> {
      return Effect.gen(function* () {
        const state = activePlugins.get(id);
        if (!state) return;
        activePlugins.delete(id);
        yield* Fiber.interrupt(state.fiber);
        yield* Fiber.await(state.fiber);
        yield* Scope.close(state.scope, Exit.void);
      });
    }

    function disposeAll(): Effect.Effect<void> {
      return Effect.gen(function* () {
        if (disposed) return;
        disposed = true;
        yield* Scope.close(hostScope, Exit.void);
        activePlugins.clear();
        kvStores.clear();
        yield* Queue.shutdown(errorQueue);
      });
    }

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
