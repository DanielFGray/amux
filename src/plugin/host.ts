import {
  Effect,
  Deferred,
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
import type { Panel } from "../ui/regions.tsx";
import type { Regions } from "../ui/regions.tsx";
import type { SessionViews } from "./session-views.tsx";
import type { PaneView } from "../component-pane.tsx";
import type { CommandSpec } from "../bindings.ts";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
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
import {
  CurrentPlugin,
  type PluginRegistries,
  RegionsTag,
  SessionViewsTag,
  BindingsTag,
  SettingsTag,
  SpawnProvidersTag,
} from "./services.ts";

const registryService = <A>(register: (owner: PluginInstance, value: A) => () => void) => ({
  register: (value: A) =>
    Effect.gen(function* () {
      const owner = yield* CurrentPlugin;
      return register(owner, value);
    }),
});

export type {
  PluginDefinition,
  PluginHostContext,
  PluginErrorEvent,
  PluginStatus,
} from "./types.ts";

export interface PluginHost {
  /** Start a plugin, replacing any plugin already running under its id. */
  readonly add: (plugin: PluginDefinition) => Effect.Effect<void, string>;
  readonly remove: (id: string) => Effect.Effect<void>;
  readonly onError: Stream.Stream<PluginErrorEvent>;
  readonly status: () => readonly PluginStatus[];
  readonly spawnProvider: (id: string) => SpawnProvider | undefined;
  readonly dispose: Effect.Effect<void>;
}

const SUPPORTED_API_VERSION = "1";

/** Add, remove and re-gate call one another around the dependency graph, so
 *  each of them has to say its own type rather than infer it from the others. */
type Add = (plugin: PluginDefinition) => Effect.Effect<void, string>;
type ById = (id: string) => Effect.Effect<void>;

interface PluginState {
  /** Which run of this plugin id this is; what its registrations are filed under. */
  readonly instance: PluginInstance;
  readonly scope: Scope.CloseableScope;
  readonly fiber: Fiber.RuntimeFiber<void, never>;
  /** Start this same definition again, for a plugin re-gated by a provider leaving. */
  readonly reactivate: Effect.Effect<void, string>;
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
  readonly registries: PluginRegistries;
  /** Legacy host wiring; kept as derived adapters while bundled plugins migrate. */
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
    /** How many times each id has been started; the next run gets the next number. */
    const generations = new Map<string, number>();
    const services = createPluginServices();
    const registryOwner: PluginInstance = { id: "amux.registries", generation: 0 };
    services.provide(
      registryOwner,
      RegionsTag,
      registryService<Panel>((owner, panel) => env.registries.regions.register(owner, panel)),
    );
    services.provide(
      registryOwner,
      SessionViewsTag,
      registryService<readonly [string, PaneView]>((owner, [type, view]) =>
        env.registries.sessionViews.register(owner, type, view),
      ),
    );
    services.provide(
      registryOwner,
      BindingsTag,
      registryService<CommandSpec>((owner, binding) => env.registerBinding(owner, binding)),
    );
    services.provide(
      registryOwner,
      SettingsTag,
      registryService<PluginSettingsSection>((owner, section) =>
        env.registerSettingsSection(owner, section),
      ),
    );
    services.provide(
      registryOwner,
      SpawnProvidersTag,
      registryService<readonly [string, () => SpawnProvider]>((owner, [id, provider]) =>
        env.registries.spawnProviders(owner, id, provider),
      ),
    );
    services.commit(registryOwner);
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
        registerPanel: (panel: Panel) => scoped(env.registries.regions.register(owner, panel)),
        registerPaneType: (type: string, view: PaneView) =>
          scoped(env.registries.sessionViews.register(owner, type, view)),
        registerBinding: (binding: CommandSpec) => scoped(env.registerBinding(owner, binding)),
        registerSettingsSection: (section: PluginSettingsSection) =>
          scoped(env.registerSettingsSection(owner, section)),
        registerSpawnProvider: (id: string, provider: () => SpawnProvider) =>
          scoped(env.registries.spawnProviders(owner, id, provider)),
        provide: (tag, service) => {
          services.provide(owner, tag, service);
          return scoped(() => services.withdraw(owner, tag));
        },
        get: (tag) => services.get(tag),
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

      const generation = (generations.get(plugin.id) ?? -1) + 1;
      generations.set(plugin.id, generation);
      const instance: PluginInstance = { id: plugin.id, generation };
      const previous = activePlugins.get(plugin.id);
      if (!previous) {
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
        services.declare(instance, plugin.inject ?? []);
        services.commit(instance);
      }
      const pluginScope = yield* Scope.fork(hostScope, ExecutionStrategy.sequential);
      const context = makeContext(instance, pluginScope);
      const injected = plugin.inject ?? [];
      const started = yield* Deferred.make<"started" | "failed", never>();

      // Waiting on the injected tags is the whole of "pending": the fiber
      // suspends on their Deferreds and resumes in the order they are provided,
      // so a provider configured last still activates its dependents.
      const pluginEffect = services.awaitAll<never>(injected).pipe(
        Effect.flatMap((provided) => Effect.provide(plugin.effect(context), provided)),
        Effect.catchAllDefect((defect) =>
          Effect.gen(function* () {
            const error = defect instanceof Error ? defect : new Error(String(defect));
            emitError({
              pluginId: plugin.id,
              phase: "activate",
              source: "plugin",
              error,
              timestamp: Date.now(),
            });
            yield* Deferred.succeed(started, "failed");
            if (previous) yield* Scope.close(pluginScope, Exit.void);
            else yield* removePlugin(plugin.id);
          }),
        ),
        Effect.tap(() => Deferred.succeed(started, "started")),
        Effect.provideService(Scope.Scope, pluginScope),
        Effect.provideService(CurrentPlugin, instance),
        Effect.provideService(
          RegionsTag,
          registryService<Panel>((owner, panel) => env.registries.regions.register(owner, panel)),
        ),
        Effect.provideService(
          SessionViewsTag,
          registryService<readonly [string, PaneView]>((owner, [type, view]) =>
            env.registries.sessionViews.register(owner, type, view),
          ),
        ),
        Effect.provideService(
          BindingsTag,
          registryService<CommandSpec>((owner, binding) => env.registries.bindings(owner, binding)),
        ),
        Effect.provideService(
          SettingsTag,
          registryService<PluginSettingsSection>((owner, section) =>
            env.registries.settings(owner, section),
          ),
        ),
        Effect.provideService(
          SpawnProvidersTag,
          registryService<readonly [string, () => SpawnProvider]>((owner, [id, provider]) =>
            env.registries.spawnProviders(owner, id, provider),
          ),
        ),
      );

      const fiber = yield* Effect.forkIn(pluginEffect, hostScope);
      if (!previous) {
        activePlugins.set(plugin.id, {
          instance,
          scope: pluginScope,
          fiber,
          reactivate: Effect.suspend(() => addPlugin(plugin)),
        });
        yield* Effect.yieldNow();
        return;
      }
      const result = yield* Deferred.await(started);
      yield* Fiber.await(fiber);
      if (result === "failed") {
        yield* Scope.close(pluginScope, Exit.void);
        return yield* Effect.fail(
          `plugin '${plugin.id}' failed to start; kept the version that was running`,
        );
      }

      const conflicts = env.contributions.commit(instance);
      if (conflicts.length > 0) {
        yield* Scope.close(pluginScope, Exit.void);
        emitError({
          pluginId: plugin.id,
          phase: "activate",
          source: "host",
          error: new Error(
            `Plugin '${plugin.id}' claims names another plugin already holds: ${conflicts.join(", ")}`,
          ),
          timestamp: Date.now(),
        });
        return yield* Effect.fail(
          `plugin '${plugin.id}' claims names another plugin already holds: ${conflicts.join(", ")}`,
        );
      }

      services.declare(instance, injected);
      services.commit(instance);
      // The old provider is still active until after the new generation has
      // committed. Removing it now re-gates its dependents onto the new service.
      yield* removePlugin(plugin.id);
      activePlugins.set(plugin.id, {
        instance,
        scope: pluginScope,
        fiber,
        reactivate: Effect.suspend(() => addPlugin(plugin)),
      });
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
      for (const dependent of services.dependentsOf(state.instance)) {
        const dependentState = activePlugins.get(dependent);
        if (!dependentState) continue;
        regated.push(dependentState.reactivate.pipe(Effect.catchAll(() => Effect.void)));
        yield* removePlugin(dependent);
      }

      services.withdrawAll(state.instance);
      services.forget(state.instance);
      services.retire(state.instance);
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
        return [...activePlugins.entries()].map(([id, state]) => ({
          id,
          waitingFor: services.waitingOn(state.instance),
        }));
      },
      spawnProvider: env.registries.spawnProvider,
      dispose: Effect.suspend(disposeAll),
    };
  });
}
