import {
  Effect,
  Equal,
  ExecutionStrategy,
  Exit,
  Fiber,
  Queue,
  Runtime,
  Scope,
  Stream,
} from "effect";
import type { PanelContext } from "../ui/panel.ts";
import type { Panel, Regions } from "../ui/regions.tsx";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
import type { SessionViews } from "./session-views.tsx";
import type { CommandSpec } from "../bindings.ts";
import { createPluginKV } from "./kv.ts";
import { createPluginServices } from "./services.ts";
import type { PluginContributions, PluginInstance } from "./contributions.ts";
import type {
  PluginDefinition,
  PluginErrorEvent,
  PluginHostContext,
  PluginKV,
  PluginStatus,
  PluginSettingsSection,
  SpawnProvider,
} from "./types.ts";

export type {
  PluginDefinition,
  PluginHostContext,
  PluginErrorEvent,
  PluginStatus,
} from "./types.ts";

export interface PluginHost {
  /** Start a plugin, replacing any plugin already running under its id. */
  readonly add: (plugin: PluginDefinition) => Effect.Effect<void>;
  readonly remove: (id: string) => Effect.Effect<void>;
  readonly onError: Stream.Stream<PluginErrorEvent>;
  readonly status: () => readonly PluginStatus[];
  readonly spawnProvider: (id: string) => SpawnProvider | undefined;
  readonly dispose: Effect.Effect<void>;
}

const SUPPORTED_API_VERSION = "1";

/** Add, remove and re-gate call one another around the dependency graph, so
 *  each of them has to say its own type rather than infer it from the others. */
type Add = (plugin: PluginDefinition) => Effect.Effect<void>;
type ById = (id: string) => Effect.Effect<void>;

interface PluginState {
  /** Which run of this plugin id this is; what its registrations are filed under. */
  readonly instance: PluginInstance;
  readonly scope: Scope.CloseableScope;
  readonly fiber: Fiber.RuntimeFiber<void, never>;
  /** Start this same definition again, for a plugin re-gated by a provider leaving. */
  readonly reactivate: Effect.Effect<void>;
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
  /** The tables every registry writes into, and the host's say over which
   *  instance of a plugin id the app is looking at. */
  readonly contributions: PluginContributions;
  readonly regions: Regions;
  readonly sessionViews: SessionViews;
  readonly registerBinding: (owner: PluginInstance, binding: CommandSpec) => () => void;
  readonly registerSettingsSection: (
    owner: PluginInstance,
    section: PluginSettingsSection,
  ) => () => void;
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
    const spawnProviders = env.contributions.table<() => SpawnProvider>();
    /** How many times each id has been started; the next run gets the next number. */
    const generations = new Map<string, number>();
    const services = createPluginServices();
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

    function makeContext(owner: PluginInstance, scope: Scope.CloseableScope): PluginHostContext {
      /** Every registration is undone when the plugin's scope closes, so a
       *  removed or crashed plugin leaves nothing of itself behind. */
      const scoped = (dispose: () => void): (() => void) => {
        Runtime.runSync(rt)(Scope.addFinalizer(scope, Effect.sync(dispose)));
        return dispose;
      };
      const pluginId = owner.id;
      return {
        id: pluginId,
        panel: env.panel,
        kv: kvFor(pluginId),
        registerPanel: (panel: Panel) => scoped(env.regions.register(owner, panel)),
        registerPaneType: (type, view) => scoped(env.sessionViews.register(owner, type, view)),
        registerBinding: (binding) => scoped(env.registerBinding(owner, binding)),
        registerSettingsSection: (section) => scoped(env.registerSettingsSection(owner, section)),
        provide: (tag, service) => {
          services.provide(pluginId, tag, service);
          return scoped(() => services.withdraw(pluginId, tag));
        },
        get: (tag) => services.get(tag),
        registerSpawnProvider: (id, provider) => scoped(spawnProviders.add(owner, id, provider)),
        frames: env.frames,
        sync: env.sync,
      };
    }

    const addPlugin: Add = Effect.fnUntraced(function* (plugin: PluginDefinition) {
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

      const generation = (generations.get(plugin.id) ?? -1) + 1;
      generations.set(plugin.id, generation);
      const instance: PluginInstance = { id: plugin.id, generation };
      // Committed before the effect runs, so registrations are visible as they
      // are made. The instance is what the registries file them under either
      // way, which is what a reload will need to defer this line.
      const conflicts = env.contributions.commit(instance);
      if (conflicts.length > 0) {
        emitError({
          pluginId: plugin.id,
          phase: "activate",
          source: "host",
          error: new Error(
            `Plugin '${plugin.id}' claims names another plugin already holds: ${conflicts.join(", ")}`,
          ),
          timestamp: Date.now(),
        });
        return;
      }

      const pluginScope = yield* Scope.fork(hostScope, ExecutionStrategy.sequential);
      const context = makeContext(instance, pluginScope);
      const injected = plugin.inject ?? [];
      services.declare(plugin.id, injected);

      // Waiting on the injected tags is the whole of "pending": the fiber
      // suspends on their Deferreds and resumes in the order they are provided,
      // so a provider configured last still activates its dependents.
      const pluginEffect = services.awaitAll<never>(injected).pipe(
        Effect.flatMap((provided) => Effect.provide(plugin.effect(context), provided)),
        Effect.catchAllDefect((defect) => {
          const error = defect instanceof Error ? defect : new Error(String(defect));
          emitError({
            pluginId: plugin.id,
            phase: "activate",
            source: "plugin",
            error,
            timestamp: Date.now(),
          });
          // A crash is a provider leaving, so it goes out the same door as a
          // deliberate removal: dependents unwind, then this plugin's scope closes.
          return removePlugin(plugin.id);
        }),
        Effect.provideService(Scope.Scope, pluginScope),
      );

      const fiber = yield* Effect.forkIn(pluginEffect, hostScope);
      activePlugins.set(plugin.id, {
        instance,
        scope: pluginScope,
        fiber,
        reactivate: Effect.suspend(() => addPlugin(plugin)),
      });
      yield* Effect.yieldNow();
    });

    /**
     * A plugin stops, and everything that injected a service of its stops first.
     *
     * The order is the point: a dependent unwinds while the services it holds
     * are still readable — handing connections back to the pool that provided
     * them — and only then is any of the provider released. Effect's own scope
     * ordering cannot express this, because a dependent may have several
     * providers and a scope has one parent.
     */
    const removePlugin: ById = Effect.fnUntraced(function* (id: string) {
      const state = activePlugins.get(id);
      if (!state) return;
      activePlugins.delete(id);

      // Dependents unwind first, one level at a time, so each of them finishes
      // while the services it holds are still the ones it acquired. Then they
      // go back to waiting rather than staying stopped: a provider that leaves
      // is usually a provider being replaced, and a dependent that did not come
      // back would be a plugin silently lost to a reload.
      const regated: Effect.Effect<void>[] = [];
      for (const dependent of services.dependentsOf(id)) {
        const dependentState = activePlugins.get(dependent);
        if (!dependentState) continue;
        regated.push(dependentState.reactivate);
        yield* removePlugin(dependent);
      }

      services.withdrawAll(id);
      services.forget(id);
      // Retired before the scope closes, so the registrations coming off are
      // already invisible and the layout repaints once rather than per panel.
      env.contributions.retire(state.instance);
      // A plugin that crashed is removed by its own fiber, which cannot wait
      // for itself to finish; its scope still closes below.
      const self = yield* Effect.fiberId;
      if (!Equal.equals(state.fiber.id(), self)) {
        yield* Fiber.interrupt(state.fiber);
        yield* Fiber.await(state.fiber);
      }
      yield* Scope.close(state.scope, Exit.void);

      if (disposed) return;
      for (const reactivate of regated) yield* reactivate;
    });

    const disposeAll = Effect.fnUntraced(function* () {
      if (disposed) return;
      disposed = true;
      // Plugin by plugin rather than one scope close, so dependents still
      // unwind before their providers on the way down. Removing a plugin also
      // removes its dependents, and the live iterator simply skips those.
      for (const id of activePlugins.keys()) yield* removePlugin(id);
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
        return [...activePlugins.keys()].map((id) => ({ id, waitingFor: services.waitingOn(id) }));
      },
      spawnProvider: (id) => spawnProviders.get(id)?.(),
      dispose: Effect.suspend(disposeAll),
    };
  });
}
