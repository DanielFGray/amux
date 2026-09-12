import { Cause, Clock, Effect, Deferred, Exit, Fiber, Queue, Scope, Stream, Types } from "effect";
import { createPluginKV } from "./kv.ts";
import {
  createPluginServices,
  dependencyService,
  SpawnProvidersTag,
  type InterceptablePluginService,
  type PluginService,
  type PluginServices,
} from "./services.ts";
import { Option } from "effect";
import type { PluginContributions, PluginInstance } from "./contributions.ts";
import type {
  PluginDefinition,
  PluginConsumer,
  PluginErrorEvent,
  PluginHostContext,
  PluginKV,
  PluginStatus,
  SpawnProvider,
} from "./types.ts";
import { CurrentPlugin } from "./services.ts";

export type {
  PluginConsumer,
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
  /** Replace active entries as one commit-or-rollback generation. */
  readonly replace: (plugins: readonly PluginDefinition[]) => Effect.Effect<void, string>;
  /** Drop a plugin from the configuration. Fails if something still injects it. */
  readonly remove: (id: string) => Effect.Effect<void, string>;
  readonly onError: Stream.Stream<PluginErrorEvent>;
  /** Receive a renderer failure while preserving the instance that registered it. */
  readonly reportError: (event: Omit<PluginErrorEvent, "source" | "timestamp">) => void;
  readonly onServiceChange: Stream.Stream<string>;
  readonly get: PluginServices["get"];
  /** Wait for a committed provider without consuming the shared change stream. */
  readonly await: PluginServices["await"];
  readonly intercept: <Id, Service, Metadata>(
    pluginId: string,
    tag: InterceptablePluginService<Id, Service, Metadata>,
    metadata: Metadata,
  ) => void;
  readonly clearInterception: (pluginId: string, tag: PluginService) => void;
  /** The derived context for one realm — see {@link PluginServices.realmContext}. */
  readonly realmContext: PluginServices["realmContext"];
  readonly status: () => readonly PluginStatus[];
  /** The committed instance number, used to reject stale renderer errors. */
  readonly generation: (id: string) => number | undefined;
  readonly spawnProvider: (id: string) => SpawnProvider | undefined;
  readonly dispose: Effect.Effect<void>;
}

/** An entry the configuration could not satisfy, and the key that sank it. */
export interface RefusedPlugin {
  readonly id: string;
  readonly key: string;
}

/** Add, remove and re-gate call one another around the dependency graph, so
 *  each of them has to say its own type rather than infer it from the others. */
type Add = (
  plugin: PluginDefinition,
  batch?: ReplacementBatch,
) => Effect.Effect<Deferred.Deferred<void, string> | undefined, string>;
type ById = (id: string) => Effect.Effect<void>;

interface PluginState {
  /** Which run of this plugin id this is; what its registrations are filed under. */
  readonly instance: PluginInstance;
  readonly scope: Scope.Closeable;
  readonly fiber: Fiber.Fiber<void, never>;
  /** Start this same definition again, for a plugin re-gated by a provider leaving. */
  readonly reactivate: Effect.Effect<void, string>;
  readonly definition: PluginDefinition;
  phase: "waiting" | "starting" | "active" | "stopping";
  readonly result: Deferred.Deferred<void, string>;
  readonly batch?: ReplacementBatch;
}

interface ReplacementBatch {
  readonly ids: ReadonlySet<string>;
}

interface FailedAttempt {
  readonly definition: PluginDefinition;
  readonly error: Error;
}

/**
 * What the host itself needs, which is only the tables it files registrations
 * in.
 *
 * A panel context, an attach frame stream and a sync callback used to sit here
 * too, and that is what kept the host inside the UI: a process with no client —
 * a CLI-time host loading plugins to collect their subcommands — had nothing
 * honest to pass. Capabilities are services now, so a host publishes the ones
 * its process actually has and a plugin injects what it needs. One that injects
 * a capability nobody provides is left inactive and reported, which is the same
 * answer `reconcile` already gives for every other unsatisfiable injection.
 */
export interface PluginEnvironment {
  readonly contributions: PluginContributions;
  readonly consumers?: readonly PluginConsumer[];
}

export function createPluginHost(
  env: PluginEnvironment,
): Effect.Effect<PluginHost, never, Scope.Scope> {
  return Effect.gen(function* () {
    const rt = yield* Effect.context<Scope.Scope>();
    const errorQueue = yield* Queue.unbounded<PluginErrorEvent>();
    const serviceChangeQueue = yield* Queue.unbounded<string>();
    const activePlugins = new Map<string, PluginState>();
    const candidates = new Map<string, PluginState>();
    const failures = new Map<string, FailedAttempt>();
    const operations = yield* Queue.unbounded<Effect.Effect<void>>();
    const kvStores = new Map<string, PluginKV>();
    /** How many times each id has been started; the next run gets the next number. */
    const generations = new Map<string, number>();
    const consumers = env.consumers ?? [];
    const consumerIds = new Set(consumers.map((_, index) => `amux.consumer.${index}`));
    const consumerEntries: readonly PluginDefinition[] = consumers.map((consumer, index) => ({
      id: `amux.consumer.${index}`,
      inject: consumer.inject,
      activate: (_context, provided) => consumer.activate(provided),
    }));
    const services = yield* createPluginServices(env.contributions, (key) => {
      Queue.offerUnsafe(serviceChangeQueue, key);
    });
    const hostScope = yield* Scope.make();
    let disposed = false;

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
        kv: kvFor(pluginId),
        provide: (tag, service, realm) => {
          // The declaration is what the host reasons about before anything
          // runs, so a provision outside it would make that reasoning wrong.
          // Caught here, at the call site that broke the promise.
          if (!declaredKeys.has(tag.key))
            throw new Error(
              `plugin '${pluginId}' provided '${tag.key}', which it does not declare in 'provide'`,
            );
          services.provide(owner, tag, service, realm);
          return scoped(() => services.withdraw(owner, tag, realm));
        },
        get: (tag) => services.get(tag),
      };
    }

    const addPlugin: Add = Effect.fnUntraced(function* (
      plugin: PluginDefinition,
      batch?: ReplacementBatch,
    ) {
      if (disposed) return yield* Effect.fail("Plugin host is disposed");
      const pending = candidates.get(plugin.id);
      if (pending) {
        candidates.delete(plugin.id);
        yield* closeRun(pending, "superseded");
      }
      failures.delete(plugin.id);
      const generation = (generations.get(plugin.id) ?? -1) + 1;
      generations.set(plugin.id, generation);
      const instance: PluginInstance = { id: plugin.id, generation };
      const previous = activePlugins.get(plugin.id);
      const injected = plugin.inject ?? [];
      if (!previous) env.contributions.commit(instance);
      services.declare(instance, injected);
      const pluginScope = yield* Scope.fork(hostScope, "sequential");
      const context = makeContext(instance, pluginScope, plugin.provide ?? []);
      const result = yield* Deferred.make<void, string>();

      const pluginEffect = services.awaitAll(instance, injected).pipe(
        Effect.flatMap((provided) =>
          Effect.gen(function* () {
            yield* Queue.offer(
              operations,
              Effect.sync(() => {
                const current = candidates.get(plugin.id) ?? activePlugins.get(plugin.id);
                if (current?.instance === instance) current.phase = "starting";
              }),
            );
            yield* plugin.activate(context, provided);
          }),
        ),
        Effect.exit,
        Effect.flatMap((exit) => Queue.offer(operations, finishActivation(instance, exit))),
        Effect.asVoid,
        Effect.provideService(Scope.Scope, pluginScope),
        Effect.provideService(CurrentPlugin, instance),
      );
      const fiber = yield* Effect.forkIn(pluginEffect, hostScope);
      const state: PluginState = {
        instance,
        scope: pluginScope,
        fiber,
        definition: plugin,
        result,
        phase: "waiting",
        batch,
        reactivate: Effect.suspend(() => addPlugin(plugin)).pipe(Effect.asVoid),
      };
      if (previous) candidates.set(plugin.id, state);
      else activePlugins.set(plugin.id, state);
      yield* Effect.yieldNow;
      return previous ? result : undefined;
    });

    const closeRun = Effect.fnUntraced(function* (state: PluginState, reason: string) {
      state.phase = "stopping";
      env.contributions.retire(state.instance);
      yield* Fiber.interrupt(state.fiber);
      services.withdrawAll(state.instance);
      services.forget(state.instance);
      yield* Scope.close(state.scope, Exit.void);
      yield* Deferred.fail(state.result, `plugin '${state.instance.id}' ${reason}`);
    });

    const finishActivation = Effect.fnUntraced(function* (
      instance: PluginInstance,
      exit: Exit.Exit<void, never>,
    ) {
      const candidate = candidates.get(instance.id);
      const state = candidate ?? activePlugins.get(instance.id);
      if (disposed || state?.instance !== instance) return;
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      let error = Exit.isFailure(exit)
        ? defect instanceof Error
          ? defect
          : new Error(String(defect))
        : undefined;
      if (!error && candidate) {
        if (candidate.batch) {
          candidate.phase = "active";
          yield* Deferred.succeed(candidate.result, undefined);
          return;
        }
        const conflicts = env.contributions.commit(instance);
        if (conflicts.length > 0)
          error = new Error(
            `plugin '${instance.id}' claims names another plugin already holds: ${conflicts.join(", ")}`,
          );
      }
      if (error) {
        emitError({
          pluginId: instance.id,
          generation: instance.generation,
          phase: "activate",
          source: "plugin",
          error,
          timestamp: yield* Clock.currentTimeMillis,
        });
        if (candidate) {
          candidates.delete(instance.id);
          yield* closeRun(candidate, "failed to start; kept the version that was running");
        } else {
          yield* removePlugin(instance.id);
        }
        failures.set(instance.id, { definition: state.definition, error });
        return;
      }
      if (candidate) {
        candidates.delete(instance.id);
        yield* removePlugin(instance.id);
        activePlugins.set(instance.id, candidate);
      }
      state.phase = "active";
      failures.delete(instance.id);
      yield* Deferred.succeed(state.result, undefined);
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
        regated.push(dependentState.reactivate.pipe(Effect.ignore));
        yield* removePlugin(dependent);
      }

      yield* closeRun(state, "was removed");

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

    const reconcile = Effect.fnUntraced(function* (
      entries: readonly PluginDefinition[],
      retry: (id: string) => boolean,
    ) {
      if (disposed) return yield* Effect.fail("Plugin host is disposed");
      if (entries.some((entry) => consumerIds.has(entry.id)))
        return yield* Effect.fail("a plugin id collides with a host-owned consumer");
      const admitted = new Map(
        [...consumerEntries, ...entries].map((entry) => [entry.id, entry] as const),
      );
      const refused: RefusedPlugin[] = [];

      // Dropping one entry can strand the next, so this settles rather than
      // running a single pass.
      for (;;) {
        const provided = new Set<string>();
        for (const entry of admitted.values())
          for (const tag of entry.provide ?? []) provided.add(tag.key);

        const stranded = [...admitted.values()].flatMap((entry) => {
          const missing = (entry.inject ?? [])
            .map(dependencyService)
            .find((tag) => !provided.has(tag.key));
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

        const coreConsumer = stranded.find(({ entry }) => consumerIds.has(entry.id));
        if (coreConsumer)
          return yield* Effect.fail(
            `cannot start ${consumers[Number(coreConsumer.entry.id.slice("amux.consumer.".length))]!.name}: no provider for '${coreConsumer.key}'`,
          );

        for (const { entry, key } of stranded) {
          admitted.delete(entry.id);
          refused.push({ id: entry.id, key });
        }
      }

      for (const id of [...desired.keys()]) {
        if (consumerIds.has(id)) continue;
        if (admitted.has(id)) continue;
        desired.delete(id);
        failures.delete(id);
        const candidate = candidates.get(id);
        if (candidate) {
          candidates.delete(id);
          yield* closeRun(candidate, "was removed");
        }
        yield* removePlugin(id);
      }
      // A plugin whose activation threw is reported and unloaded by `addPlugin`
      // itself; the failure it returns is the replacement case, where the
      // version that was already running was kept. Reported once the whole
      // configuration is applied, so one bad entry does not strand the rest.
      let startFailure: string | undefined;
      const replacements: Deferred.Deferred<void, string>[] = [];
      for (const entry of admitted.values()) {
        if (desired.get(entry.id) === entry && !(failures.has(entry.id) && retry(entry.id)))
          continue;
        yield* addPlugin(entry).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              desired.set(entry.id, entry);
              if (result) replacements.push(result);
            }),
          ),
          Effect.catch((error) => Effect.sync(() => void (startFailure ??= error))),
        );
      }

      for (const { id, key } of refused)
        emitError({
          pluginId: id,
          generation: generations.get(id) ?? 0,
          phase: "activate",
          source: "host",
          error: new Error(
            `plugin '${id}' injects '${key}', which nothing in the configuration provides`,
          ),
          timestamp: yield* Clock.currentTimeMillis,
        });
      if (startFailure) return yield* Effect.fail(startFailure);
      return { refused: refused as readonly RefusedPlugin[], replacements };
    });

    const disposeAll = Effect.fnUntraced(function* () {
      if (disposed) return;
      disposed = true;
      for (const candidate of candidates.values()) yield* closeRun(candidate, "host was disposed");
      candidates.clear();
      // Plugin by plugin rather than one scope close, so dependents still
      // unwind before their providers on the way down. Removing a plugin also
      // removes its dependents, and the live iterator simply skips those.
      for (const id of activePlugins.keys()) yield* removePlugin(id);
      yield* Scope.close(hostScope, Exit.void);
      desired.clear();
      activePlugins.clear();
      failures.clear();
      kvStores.clear();
      yield* Queue.shutdown(errorQueue);
      yield* Queue.shutdown(serviceChangeQueue);
    });

    // Disposal stops the fiber draining `operations`, so anything submitted
    // after that point must run inline or it would wait on a queue nobody
    // reads from again.
    function submit<A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> {
      return Effect.suspend(() => {
        if (disposed) return operation;
        return Effect.gen(function* () {
          const result = yield* Deferred.make<A, E>();
          yield* Queue.offer(
            operations,
            operation.pipe(
              Effect.exit,
              Effect.flatMap((exit) => Deferred.done(result, exit)),
              Effect.asVoid,
            ),
          );
          return yield* Deferred.await(result);
        });
      });
    }

    yield* Effect.forkScoped(Effect.forever(Queue.take(operations).pipe(Effect.flatten)));
    yield* Effect.addFinalizer(() => submit(disposeAll()));

    const configure = (
      entries: () => readonly PluginDefinition[],
      retry: (id: string) => boolean,
    ) =>
      submit(Effect.suspend(() => reconcile(entries(), retry))).pipe(
        Effect.flatMap(({ refused, replacements }) =>
          Effect.gen(function* () {
            // Flush completion events from immediate activations before returning.
            yield* submit(Effect.void);
            for (const result of replacements) yield* Deferred.await(result);
            return refused;
          }),
        ),
      );

    const replace = (plugins: readonly PluginDefinition[]) =>
      Effect.gen(function* () {
        const ids = new Set(plugins.map((plugin) => plugin.id));
        if (ids.size !== plugins.length)
          return yield* Effect.fail("replacement contains duplicate plugin ids");
        if ([...ids].some((id) => !activePlugins.has(id)))
          return yield* Effect.fail("replacement names a plugin that is not active");
        const batch: ReplacementBatch = { ids };
        const results = yield* submit(
          Effect.forEach(plugins, (plugin) => addPlugin(plugin, batch)).pipe(
            Effect.map((values) =>
              values.filter((value): value is Deferred.Deferred<void, string> => !!value),
            ),
          ),
        );
        yield* submit(Effect.void);
        const settled = yield* Effect.exit(Effect.all(results.map(Deferred.await)));
        if (Exit.isFailure(settled)) {
          yield* submit(
            Effect.forEach(ids, (id) => {
              const candidate = candidates.get(id);
              if (!candidate) return Effect.void;
              candidates.delete(id);
              return closeRun(
                candidate,
                "batch replacement failed; kept the version that was running",
              );
            }),
          );
          return yield* Effect.fail(String(Cause.squash(settled.cause)));
        }
        yield* submit(
          Effect.gen(function* () {
            const next = [...ids].map((id) => candidates.get(id)!);
            const conflicts = env.contributions.commitAll(next.map((state) => state.instance));
            if (conflicts.length > 0)
              return yield* Effect.fail(`replacement conflicts: ${conflicts.join(", ")}`);
            for (const state of next) {
              const previous = activePlugins.get(state.instance.id)!;
              candidates.delete(state.instance.id);
              activePlugins.set(state.instance.id, state);
              desired.set(state.instance.id, state.definition);
              yield* closeRun(previous, "was replaced");
            }
          }),
        );
      });

    return {
      reconcile: (entries) =>
        configure(
          () => entries,
          () => true,
        ),
      add: (plugin) =>
        configure(
          () => [
            ...[...desired.values()].filter((e) => !consumerIds.has(e.id) && e.id !== plugin.id),
            plugin,
          ],
          (id) => id === plugin.id,
        ).pipe(
          Effect.flatMap((refused) => {
            const rejection = refused.find((r) => r.id === plugin.id);
            return rejection
              ? Effect.fail(
                  `plugin '${plugin.id}' injects '${rejection.key}', which nothing in the configuration provides`,
                )
              : Effect.void;
          }),
        ),
      replace,
      remove: (id) =>
        configure(
          () =>
            [...desired.values()].filter((entry) => consumerIds.has(entry.id) || entry.id !== id),
          () => false,
        ).pipe(Effect.asVoid),
      onError: Stream.fromQueue(errorQueue),
      reportError: (event) =>
        Effect.runForkWith(rt)(
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((timestamp) =>
              Queue.offer(errorQueue, { ...event, source: "plugin" as const, timestamp }),
            ),
          ),
        ),
      onServiceChange: Stream.fromQueue(serviceChangeQueue),
      get: services.get,
      await: services.await,
      intercept: services.intercept,
      clearInterception: services.clearInterception,
      realmContext: services.realmContext,
      status() {
        if (disposed) return [];
        return [...desired.keys()]
          .filter((id) => !consumerIds.has(id))
          .map((id): PluginStatus => {
            const state = activePlugins.get(id);
            const candidate = candidates.get(id);
            const failed = failures.get(id);
            const status: Types.Mutable<PluginStatus> = {
              id,
              phase: state?.phase ?? "failed",
              waitingFor: state ? services.waitingOn(state.instance) : [],
            };
            if (failed && !state) status.error = failed.error;
            if (candidate) status.replacement = { phase: candidate.phase };
            else if (failed && state) status.replacement = { phase: "failed", error: failed.error };
            return status;
          });
      },
      generation: (id) => activePlugins.get(id)?.instance.generation,
      spawnProvider: (id) => Option.getOrUndefined(services.get(SpawnProvidersTag))?.get(id),
      dispose: Effect.suspend(() => submit(disposeAll())),
    };
  });
}
