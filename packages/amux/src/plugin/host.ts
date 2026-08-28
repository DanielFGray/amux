import { Effect, Deferred, Equal, Exit, Fiber, Queue, Scope, Stream } from "effect";
import type { PanelContext } from "../ui/panel.ts";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
import { createPluginKV } from "./kv.ts";
import { createPluginServices, SpawnProvidersTag, type PluginService, type PluginServices } from "./services.ts";
import { Option } from "effect";
import type { PluginContributions, PluginInstance } from "./contributions.ts";
import type {
  PluginDefinition,
  PluginErrorEvent,
  PluginHostContext,
  PluginKV,
  PluginStatus,
  SpawnProvider,
} from "./types.ts";
import { CurrentPlugin } from "./services.ts";

export type {
  PluginDefinition,
  PluginHostContext,
  PluginErrorEvent,
  PluginStatus,
} from "./types.ts";

export interface PluginHost {
  /**
   * Make `entries` the whole configuration, and report the entries it refused.
   *
   * Whether an injected key can ever have a provider is a property of the set,
   * not of any one entry: a provider may be the next entry in the list. So the
   * set is what the host takes, and `add` and `remove` are the set plus or
   * minus one. Order within it carries no meaning.
   *
   * The change that creates an unsatisfiable injection is the change refused.
   * An entry that arrives injecting a key nothing in the configuration provides
   * is dropped — the rest still load, so one broken plugin does not cost the
   * user every other one. Dropping an entry that a retained entry depends on is
   * refused whole, leaving the configuration untouched, because the entry that
   * would be stranded did nothing wrong. This is what makes a service that
   * something injects replaceable but not removable, with no flag saying so.
   */
  readonly reconcile: (
    entries: readonly PluginDefinition[],
  ) => Effect.Effect<readonly RefusedPlugin[], string>;
  /** Add a plugin to the configuration, replacing any entry under its id. */
  readonly add: (plugin: PluginDefinition) => Effect.Effect<void, string>;
  /** Drop a plugin from the configuration. Fails if something still injects it. */
  readonly remove: (id: string) => Effect.Effect<void, string>;
  readonly onError: Stream.Stream<PluginErrorEvent>;
  readonly onServiceChange: Stream.Stream<string>;
  readonly get: PluginServices["get"];
  readonly status: () => readonly PluginStatus[];
  readonly spawnProvider: (id: string) => SpawnProvider | undefined;
  readonly dispose: Effect.Effect<void>;
}

/** An entry the configuration could not satisfy, and the key that sank it. */
export interface RefusedPlugin {
  readonly id: string;
  readonly key: string;
}

const SUPPORTED_API_VERSION = "1";

/** Add, remove and re-gate call one another around the dependency graph, so
 *  each of them has to say its own type rather than infer it from the others. */
type Add = (plugin: PluginDefinition) => Effect.Effect<void, string>;
type ById = (id: string) => Effect.Effect<void>;

interface PluginState {
  /** Which run of this plugin id this is; what its registrations are filed under. */
  readonly instance: PluginInstance;
  readonly scope: Scope.Closeable;
  readonly fiber: Fiber.Fiber<void, never>;
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
  readonly contributions: PluginContributions;
  readonly frames: (session: string) => Stream.Stream<AttachFrame, never>;
  readonly sync: (session: string) => void;
}

export function createPluginHost(
  env: PluginEnvironment,
): Effect.Effect<PluginHost, never, Scope.Scope> {
  return Effect.gen(function* () {
    const rt = yield* Effect.context<Scope.Scope>();
    const errorQueue = yield* Queue.unbounded<PluginErrorEvent>();
    const serviceChangeQueue = yield* Queue.unbounded<string>();
    const activePlugins = new Map<string, PluginState>();
    const kvStores = new Map<string, PluginKV>();
    /** How many times each id has been started; the next run gets the next number. */
    const generations = new Map<string, number>();
    const services = createPluginServices((key) => {
      Queue.offerUnsafe(serviceChangeQueue, key);
    });
    const hostScope = yield* Scope.make();
    let disposed = false;

    yield* Effect.addFinalizer(() => disposeAll());

    function emitError(e: PluginErrorEvent): void {
      if (disposed) return;
      Effect.runSyncWith(rt)(Queue.offer(errorQueue, e));
    }

    function kvFor(pluginId: string): PluginKV {
      let kv = kvStores.get(pluginId);
      if (!kv) {
        kv = createPluginKV();
        kvStores.set(pluginId, kv);
      }
      return kv;
    }

    function makeContext(
      owner: PluginInstance,
      scope: Scope.Closeable,
      declared: readonly PluginService[],
    ): PluginHostContext {
      const scoped = (dispose: () => void): (() => void) => {
        Effect.runSyncWith(rt)(Scope.addFinalizer(scope, Effect.sync(dispose)));
        return dispose;
      };
      const pluginId = owner.id;
      const declaredKeys = new Set(declared.map((tag) => tag.key));
      return {
        id: pluginId,
        panel: env.panel,
        kv: kvFor(pluginId),
        provide: (tag, service) => {
          // The declaration is what the host reasons about before anything
          // runs, so a provision outside it would make that reasoning wrong.
          // Caught here, at the call site that broke the promise.
          if (!declaredKeys.has(tag.key))
            throw new Error(
              `plugin '${pluginId}' provided '${tag.key}', which it does not declare in 'provide'`,
            );
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
      const injected = plugin.inject ?? [];
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
        services.commit(instance);
      }
      services.declare(instance, injected);
      const pluginScope = yield* Scope.fork(hostScope, "sequential");
      const context = makeContext(instance, pluginScope, plugin.provide ?? []);
      const started = yield* Deferred.make<"started" | "failed", never>();

      // Waiting on the injected tags is the whole of "pending": the fiber
      // suspends on their Deferreds and resumes in the order they are provided,
      // so a provider configured last still activates its dependents.
      const pluginEffect = services.awaitAll(instance, injected).pipe(
        Effect.flatMap((provided) => plugin.activate(context, provided)),
        Effect.catchDefect((defect) =>
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
      );

      const fiber = yield* Effect.forkIn(pluginEffect, hostScope);
      if (!previous) {
        activePlugins.set(plugin.id, {
          instance,
          scope: pluginScope,
          fiber,
          reactivate: Effect.suspend(() => addPlugin(plugin)),
        });
        yield* Effect.yieldNow;
        return;
      }
      const result = yield* Deferred.await(started);
      yield* Fiber.await(fiber);
      if (result === "failed") {
        services.forget(instance);
        yield* Scope.close(pluginScope, Exit.void);
        return yield* Effect.fail(
          `plugin '${plugin.id}' failed to start; kept the version that was running`,
        );
      }

      const conflicts = env.contributions.commit(instance);
      if (conflicts.length > 0) {
        services.forget(instance);
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

      // L-Leave: stop contributing to target views before any teardown runs.
      // Committed views remain intact until each scope has finished closing.
      services.retire(state.instance);
      env.contributions.retire(state.instance);

      // Dependents unwind first, one level at a time, so each of them finishes
      // while the services it holds are still the ones it acquired. Then they
      // go back to waiting rather than staying stopped: a provider that leaves
      // is usually a provider being replaced, and a dependent that did not come
      // back would be a plugin silently lost to a reload.
      const regated: Effect.Effect<void>[] = [];
      for (const dependent of services.dependentsOf(state.instance)) {
        const dependentState = activePlugins.get(dependent);
        if (!dependentState) continue;
        regated.push(dependentState.reactivate.pipe(Effect.catch(() => Effect.void)));
        yield* removePlugin(dependent);
      }

      services.withdrawAll(state.instance);
      services.forget(state.instance);
      // A plugin that crashed is removed by its own fiber, which cannot wait
      // for itself to finish; its scope still closes below.
      const self = yield* Effect.fiberId;
      if (!Equal.equals(state.fiber.id, self)) {
        yield* Fiber.interrupt(state.fiber);
        yield* Fiber.await(state.fiber);
      }
      yield* Scope.close(state.scope, Exit.void);

      if (disposed) return;
      for (const reactivate of regated) yield* reactivate;
    });

    /**
     * The configuration the host has been told to hold.
     *
     * Not the same map as `activePlugins`, which is what is running: an entry
     * still waiting on a provider, or one whose activation threw, is configured
     * and not running. Satisfiability is a question about this map, because a
     * provider that has not started yet is still a provider.
     */
    const desired = new Map<string, PluginDefinition>();

    const reconcile = Effect.fnUntraced(function* (entries: readonly PluginDefinition[]) {
      const admitted = new Map(entries.map((entry) => [entry.id, entry] as const));
      const refused: RefusedPlugin[] = [];

      // Dropping one entry can strand the next, so this settles rather than
      // running a single pass.
      for (;;) {
        const provided = new Set<string>();
        for (const entry of admitted.values())
          for (const tag of entry.provide ?? []) provided.add(tag.key);

        const stranded = [...admitted.values()].flatMap((entry) => {
          const missing = (entry.inject ?? []).find((tag) => !provided.has(tag.key));
          return missing ? [{ entry, key: missing.key }] : [];
        });
        if (stranded.length === 0) break;

        // An entry the configuration already held, unchanged, cannot have
        // stranded itself: what changed is that its provider is leaving. So the
        // departure is what gets refused, and nothing has been applied yet.
        const casualty = stranded.find(({ entry }) => desired.get(entry.id) === entry);
        if (casualty)
          return yield* Effect.fail(
            `cannot drop the provider of '${casualty.key}': plugin '${casualty.entry.id}' injects it`,
          );

        for (const { entry, key } of stranded) {
          admitted.delete(entry.id);
          refused.push({ id: entry.id, key });
        }
      }

      for (const id of [...desired.keys()]) {
        if (admitted.has(id)) continue;
        desired.delete(id);
        yield* removePlugin(id);
      }
      // A plugin whose activation threw is reported and unloaded by `addPlugin`
      // itself; the failure it returns is the replacement case, where the
      // version that was already running was kept. Reported once the whole
      // configuration is applied, so one bad entry does not strand the rest.
      let startFailure: string | undefined;
      for (const entry of admitted.values()) {
        if (desired.get(entry.id) === entry) continue;
        desired.set(entry.id, entry);
        yield* addPlugin(entry).pipe(
          Effect.catch((error) => Effect.sync(() => void (startFailure ??= error))),
        );
      }

      for (const { id, key } of refused)
        emitError({
          pluginId: id,
          phase: "activate",
          source: "host",
          error: new Error(
            `plugin '${id}' injects '${key}', which nothing in the configuration provides`,
          ),
          timestamp: Date.now(),
        });
      if (startFailure) return yield* Effect.fail(startFailure);
      return refused as readonly RefusedPlugin[];
    });

    const disposeAll = Effect.fnUntraced(function* () {
      if (disposed) return;
      disposed = true;
      // Plugin by plugin rather than one scope close, so dependents still
      // unwind before their providers on the way down. Removing a plugin also
      // removes its dependents, and the live iterator simply skips those.
      for (const id of activePlugins.keys()) yield* removePlugin(id);
      yield* Scope.close(hostScope, Exit.void);
      desired.clear();
      activePlugins.clear();
      kvStores.clear();
      yield* Queue.shutdown(errorQueue);
      yield* Queue.shutdown(serviceChangeQueue);
    });

    return {
      reconcile,
      add: (plugin) =>
        reconcile([...[...desired.values()].filter((e) => e.id !== plugin.id), plugin]).pipe(
          Effect.flatMap((refused) => {
            const rejection = refused.find((r) => r.id === plugin.id);
            return rejection
              ? Effect.fail(
                  `plugin '${plugin.id}' injects '${rejection.key}', which nothing in the configuration provides`,
                )
              : Effect.void;
          }),
        ),
      remove: (id) =>
        reconcile([...desired.values()].filter((entry) => entry.id !== id)).pipe(Effect.asVoid),
      onError: Stream.fromQueue(errorQueue),
      onServiceChange: Stream.fromQueue(serviceChangeQueue),
      get: services.get,
      status() {
        if (disposed) return [];
        return [...activePlugins.entries()].map(([id, state]) => ({
          id,
          waitingFor: services.waitingOn(state.instance),
        }));
      },
      spawnProvider: (id) => Option.getOrUndefined(services.get(SpawnProvidersTag))?.get(id),
      dispose: Effect.suspend(disposeAll),
    };
  });
}
