import {
  Cause,
  Clock,
  Effect,
  Deferred,
  Exit,
  Fiber,
  Option,
  Queue,
  Scope,
  Stream,
  Types,
} from "effect";
import { createPluginKV } from "./kv.ts";
import {
  createPluginServices,
  dependencyService,
  SpawnProvidersTag,
  type InterceptablePluginService,
  type PluginService,
  type PluginServices,
} from "./services.ts";
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
import type { PluginActivateError } from "./activate-error.ts";
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
   * Stage `entries` as the next configuration without committing contributions.
   * A second Prepare discards the previous pending change first.
   *
   * Satisfiability matches the old whole-configuration rule: an entry that
   * injects a key nothing in the set provides is dropped and reported; dropping
   * a provider a retained entry still injects refuses the whole Prepare.
   * Candidates activate beside the running plugins; declarations stay on the
   * committed tables until {@link publish}.
   */
  readonly prepare: (entries: readonly PluginDefinition[]) => Effect.Effect<PrepareResult, string>;
  /**
   * Commit the pending Prepare in one step: contributions, desired, removals.
   * Fails when nothing is pending.
   */
  readonly publish: Effect.Effect<void, string>;
  /** Close pending candidates; running plugins stay. No-op when nothing pending. */
  readonly discard: Effect.Effect<void>;
  /** Add a plugin to the configuration, replacing any entry under its id. */
  readonly add: (plugin: PluginDefinition) => Effect.Effect<void, string>;
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
  /** Committed configuration definitions (excludes host-owned consumers). */
  readonly definitions: () => readonly PluginDefinition[];
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

/** A candidate Prepare started whose activate failed before Publish. */
export interface FailedPluginStart {
  readonly id: string;
  readonly error: Error;
}

/** Staging outcome: unsatisfiable drops plus activate failures in the batch. */
export interface PrepareResult {
  readonly refused: readonly RefusedPlugin[];
  readonly failed: readonly FailedPluginStart[];
}

/**
 * Plugins whose `inject` declarations name a key in `provider.provide`.
 * Used when the provider is still the live slot holder — `services.dependentsOf`
 * only lists injectors whose committed view is already stale after a replace.
 */
export function declarationDependentsOf(
  provider: PluginDefinition,
  plugins: readonly PluginDefinition[],
): readonly string[] {
  const provided = new Set((provider.provide ?? []).map((tag) => tag.key));
  if (provided.size === 0) return [];
  return plugins
    .filter((candidate) => candidate.id !== provider.id)
    .filter((candidate) =>
      (candidate.inject ?? []).map(dependencyService).some((tag) => provided.has(tag.key)),
    )
    .map((candidate) => candidate.id);
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
 * answer `prepare` already gives for every other unsatisfiable injection.
 */
export interface PluginEnvironment {
  readonly contributions: PluginContributions;
  readonly consumers?: readonly PluginConsumer[];
}

interface PendingPublication {
  /** Configuration to hold after publish, excluding host-owned consumers. */
  readonly desired: Map<string, PluginDefinition>;
  readonly removals: ReadonlySet<string>;
  readonly batch: ReplacementBatch;
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
    let pending: PendingPublication | undefined;
    const services = yield* createPluginServices(
      env.contributions,
      (owner, reader) => {
        if (env.contributions.isCommitted(owner)) return true;
        // Add-candidate: only injectors in the same pending batch may read it.
        // host.get / committed slot.provider pass no reader and stay blind.
        if (reader === undefined) return false;
        const candidate = candidates.get(owner.id);
        if (candidate?.instance !== owner || activePlugins.has(owner.id)) return false;
        const readerState = candidates.get(reader.id);
        return (
          readerState?.instance === reader &&
          readerState.batch !== undefined &&
          readerState.batch === candidate.batch
        );
      },
      (key) => {
        Queue.offerUnsafe(serviceChangeQueue, key);
      },
    );
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
      const pendingCandidate = candidates.get(plugin.id);
      if (pendingCandidate) {
        candidates.delete(plugin.id);
        yield* closeRun(pendingCandidate, "superseded");
      }
      failures.delete(plugin.id);
      const generation = (generations.get(plugin.id) ?? -1) + 1;
      generations.set(plugin.id, generation);
      const instance: PluginInstance = { id: plugin.id, generation };
      const previous = activePlugins.get(plugin.id);
      const injected = plugin.inject ?? [];
      // Immediate commit only for a live add outside Prepare: staged work commits at publish.
      if (!previous && !batch) env.contributions.commit(instance);
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
      if (previous || batch) candidates.set(plugin.id, state);
      else activePlugins.set(plugin.id, state);
      yield* Effect.yieldNow;
      // Only replacements must settle before Prepare returns: a first-load
      // activate may run forever (provide then await), same as reconcile's adds.
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
      exit: Exit.Exit<void, PluginActivateError>,
    ) {
      const candidate = candidates.get(instance.id);
      const state = candidate ?? activePlugins.get(instance.id);
      if (disposed || state?.instance !== instance) return;
      let error: Error | undefined = Exit.isFailure(exit)
        ? Option.match(Cause.findErrorOption(exit.cause), {
            onSome: (typed) => (typed instanceof Error ? typed : new Error(String(typed))),
            onNone: () => {
              const defect = Cause.squash(exit.cause);
              return defect instanceof Error ? defect : new Error(String(defect));
            },
          })
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
      // while the services it holds are still the ones it acquired.
      const declarationDependents = declarationDependentsOf(
        state.definition,
        [...activePlugins.values()].map((candidate) => candidate.definition),
      );

      const regated: Effect.Effect<void>[] = [];
      for (const dependent of declarationDependents) {
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

    const discardPending = Effect.fnUntraced(function* () {
      if (!pending) return;
      const ids = pending.batch.ids;
      pending = undefined;
      for (const id of ids) {
        const candidate = candidates.get(id);
        if (!candidate) continue;
        candidates.delete(id);
        yield* closeRun(candidate, "pending publication was discarded");
      }
    });

    const admitEntries = Effect.fnUntraced(function* (entries: readonly PluginDefinition[]) {
      if (disposed) return yield* Effect.fail("Plugin host is disposed");
      if (entries.some((entry) => consumerIds.has(entry.id)))
        return yield* Effect.fail("a plugin id collides with a host-owned consumer");
      const admitted = new Map(
        [...consumerEntries, ...entries].map((entry) => [entry.id, entry] as const),
      );
      const refused: RefusedPlugin[] = [];

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

      return { admitted, refused } as const;
    });

    const stagePrepare = Effect.fnUntraced(function* (
      entries: readonly PluginDefinition[],
      retry: (id: string) => boolean,
    ) {
      yield* discardPending();
      const { admitted, refused } = yield* admitEntries(entries);

      const removals = new Set<string>();
      for (const id of desired.keys()) {
        if (consumerIds.has(id)) continue;
        if (admitted.has(id)) continue;
        removals.add(id);
      }

      const toStart: PluginDefinition[] = [];
      for (const entry of admitted.values()) {
        if (desired.get(entry.id) === entry && !(failures.has(entry.id) && retry(entry.id)))
          continue;
        toStart.push(entry);
      }

      const batch: ReplacementBatch = { ids: new Set(toStart.map((entry) => entry.id)) };
      // Consumers stay in desired so a replaced provider can re-gate them; status
      // and definitions still filter them out of the public surface.
      const nextDesired = new Map(admitted);

      const results: Deferred.Deferred<void, string>[] = [];
      for (const entry of toStart) {
        const result = yield* addPlugin(entry, batch);
        if (result) results.push(result);
      }

      // Pending is recorded before activations finish so Discard/second Prepare
      // can find the batch; failed candidates are pruned after await below.
      pending = { desired: nextDesired, removals, batch };

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

      return { refused, results, batch };
    });

    const finalizePrepare = () => {
      if (!pending) return;
      const { desired: nextDesired, batch } = pending;
      for (const id of batch.ids) {
        if (candidates.has(id)) continue;
        const prior = desired.get(id);
        if (prior) nextDesired.set(id, prior);
        else nextDesired.delete(id);
      }
    };

    const runPrepare = (
      entries: readonly PluginDefinition[],
      retry: (id: string) => boolean,
    ): Effect.Effect<PrepareResult, string> =>
      submit(Effect.suspend(() => stagePrepare(entries, retry))).pipe(
        Effect.flatMap(({ refused, results, batch }) =>
          Effect.gen(function* () {
            // Flush finishActivation; then await every candidate the way replace did —
            // a parked activate must keep Prepare open so Publish cannot commit it.
            yield* submit(Effect.void);
            for (const result of results) yield* Deferred.await(result).pipe(Effect.ignore);
            yield* submit(Effect.sync(finalizePrepare));
            const failed: FailedPluginStart[] = [];
            for (const id of batch.ids) {
              const attempt = failures.get(id);
              if (attempt) failed.push({ id, error: attempt.error });
            }
            return { refused, failed };
          }),
        ),
      );

    const publishPending = Effect.fnUntraced(function* () {
      if (disposed) return yield* Effect.fail("Plugin host is disposed");
      if (!pending) return yield* Effect.fail("nothing pending to publish");
      const change = pending;
      const staged: PluginState[] = [];
      for (const id of change.batch.ids) {
        const candidate = candidates.get(id);
        if (!candidate) continue;
        // Replacements must finish activate before commit; first-load candidates
        // commit while waiting/starting the way reconcile committed adds.
        if (activePlugins.has(id) && candidate.phase !== "active")
          return yield* Effect.fail(`plugin '${id}' is not ready to publish`);
        staged.push(candidate);
      }

      if (staged.length > 0) {
        const conflicts = env.contributions.commitAll(staged.map((state) => state.instance));
        if (conflicts.length > 0)
          return yield* Effect.fail(`publication conflicts: ${conflicts.join(", ")}`);
      }

      const publishedIds = new Set(staged.map((state) => state.instance.id));
      const previousRuns: PluginState[] = [];
      for (const state of staged) {
        const previous = activePlugins.get(state.instance.id);
        candidates.delete(state.instance.id);
        activePlugins.set(state.instance.id, state);
        if (previous) previousRuns.push(previous);
      }

      // Leaf-first: dependents unwind while the provider they hold is still open.
      // Same declaration walk as removePlugin — dependentsOf only sees stale views.
      const regateIds = new Set<string>();
      for (const previous of previousRuns) {
        for (const dependent of declarationDependentsOf(
          previous.definition,
          [...activePlugins.values()].map((state) => state.definition),
        )) {
          if (publishedIds.has(dependent) || change.removals.has(dependent)) continue;
          regateIds.add(dependent);
        }
      }

      // Leaf-first: dependents unwind while the provider they hold is still open.
      for (const id of regateIds) {
        const dependentState = activePlugins.get(id);
        if (!dependentState) continue;
        activePlugins.delete(id);
        yield* closeRun(dependentState, "provider changed");
      }
      for (const previous of previousRuns) yield* closeRun(previous, "was replaced");

      // Removals close declaration-dependents before the removed plugin.
      // dependentsOf only sees stale-after-replace; this walk uses provide/inject
      // while the provider is still the live slot holder.
      const declarationDependents = (id: string): readonly string[] => {
        const state = activePlugins.get(id);
        if (!state) return [];
        return declarationDependentsOf(
          state.definition,
          [...activePlugins.values()].map((candidate) => candidate.definition),
        );
      };

      const removalOrder: string[] = [];
      const removalPending = new Set(change.removals);
      while (removalPending.size > 0) {
        let progressed = false;
        for (const id of [...removalPending]) {
          const state = activePlugins.get(id);
          if (!state) {
            removalPending.delete(id);
            progressed = true;
            continue;
          }
          const blocked = declarationDependents(id).some(
            (dependent) => removalPending.has(dependent) && activePlugins.has(dependent),
          );
          if (blocked) continue;
          removalOrder.push(id);
          removalPending.delete(id);
          progressed = true;
        }
        if (!progressed) {
          for (const id of removalPending) removalOrder.push(id);
          break;
        }
      }

      for (const id of removalOrder) {
        failures.delete(id);
        const candidate = candidates.get(id);
        if (candidate) {
          candidates.delete(id);
          yield* closeRun(candidate, "was removed");
        }
        const state = activePlugins.get(id);
        if (!state) continue;
        // Close declaration dependents that are staying (not in this removal set)
        // before the provider, then queue them for re-gate.
        for (const dependent of declarationDependents(id)) {
          if (publishedIds.has(dependent) || change.removals.has(dependent)) continue;
          regateIds.add(dependent);
          const dependentState = activePlugins.get(dependent);
          if (!dependentState) continue;
          activePlugins.delete(dependent);
          yield* closeRun(dependentState, "provider changed");
        }
        activePlugins.delete(id);
        yield* closeRun(state, "was removed");
      }

      desired.clear();
      for (const [id, entry] of change.desired) desired.set(id, entry);
      pending = undefined;

      for (const id of regateIds) {
        const definition = desired.get(id);
        if (!definition) continue;
        yield* addPlugin(definition).pipe(Effect.ignore);
      }
    });

    const disposeAll = Effect.fnUntraced(function* () {
      if (disposed) return;
      disposed = true;
      pending = undefined;
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
      runPrepare(entries(), retry).pipe(
        Effect.flatMap((prepared) =>
          submit(publishPending()).pipe(
            Effect.map(() => prepared),
            Effect.catch((error) =>
              submit(Effect.suspend(() => discardPending())).pipe(
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          ),
        ),
      );

    return {
      prepare: (entries) => runPrepare(entries, () => true),
      publish: submit(Effect.suspend(() => publishPending())).pipe(Effect.asVoid),
      discard: submit(Effect.suspend(() => discardPending())),
      add: (plugin) =>
        configure(
          () => [
            ...[...desired.values()].filter((e) => !consumerIds.has(e.id) && e.id !== plugin.id),
            plugin,
          ],
          (id) => id === plugin.id,
        ).pipe(
          Effect.flatMap((prepared) => {
            const rejection = prepared.refused.find((r) => r.id === plugin.id);
            if (rejection)
              return Effect.fail(
                `plugin '${plugin.id}' injects '${rejection.key}', which nothing in the configuration provides`,
              );
            const startFailure = prepared.failed.find((entry) => entry.id === plugin.id);
            if (startFailure) return Effect.fail(startFailure.error.message);
            return Effect.void;
          }),
        ),
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
      definitions: () =>
        disposed
          ? []
          : [...desired.entries()].filter(([id]) => !consumerIds.has(id)).map(([, entry]) => entry),
      generation: (id) => activePlugins.get(id)?.instance.generation,
      spawnProvider: (id) => Option.getOrUndefined(services.get(SpawnProvidersTag))?.get(id),
      dispose: Effect.suspend(() => submit(disposeAll())),
    };
  });
}
