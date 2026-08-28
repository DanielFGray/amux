import { afterEach, expect } from "bun:test";
import { Context, Effect, Fiber, Option, Queue, Scope, Stream } from "effect";
import { testEffect } from "../test-effect.ts";
import { createPluginHost, type PluginHost } from "./host.ts";
import { definePlugin, type PluginDefinition, type PluginErrorEvent } from "./types.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { testPluginEnvironment } from "./test-environment.ts";
import { RegionsTag, SpawnProvidersTag, type PluginService } from "./services.ts";
import type { Panel } from "../ui/regions.tsx";

/**
 * What a plugin trades: an object whose liveness a check can see.
 *
 * `open` is what makes the ordering claims falsifiable. A dependent that reads
 * it during its own teardown proves the provider had not released anything yet;
 * without it, a teardown-order check only asserts that two lines ran.
 */
interface Pool {
  readonly version: number;
  open: boolean;
}

class PoolTag extends Context.Service<PoolTag, Pool>()("test/Pool") {}
class IndexTag extends Context.Service<IndexTag, { readonly of: string }>()("test/Index") {}
class NumberTag extends Context.Service<NumberTag, number>()("test/Number") {}

type AssertFalse<T extends false> = T;
type UndeclaredRequirement =
  Effect.Effect<void, never, NumberTag> extends Effect.Effect<
    void,
    never,
    import("./types.ts").PluginRequirements<[]>
  >
    ? true
    : false;
export type UndeclaredRequirementIsRejected = AssertFalse<UndeclaredRequirement>;

const cleanupFns: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanupFns.splice(0)) fn();
});

/**
 * A host holding only the registry entries a test names.
 *
 * Registries are entries now, so a test that wants one has to configure it. The
 * default is none: most of these tests trade services between plugins of their
 * own and would only be reading a registry they never registered with.
 */
function makeHost(
  registries: readonly PluginService[] = [],
): Effect.Effect<PluginHost, never, Scope.Scope> {
  return Effect.gen(function* () {
    const t = yield* Effect.promise(() => createTestRenderer({ width: 80, height: 24 }));
    cleanupFns.push(() => t.renderer.destroy());
    const environment = testPluginEnvironment(t.renderer);
    const host = yield* createPluginHost(environment);
    for (const tag of registries) {
      const entry = environment.registryEntries.find((candidate) =>
        candidate.provide?.some((provided) => provided.key === tag.key),
      );
      if (!entry) return yield* Effect.die(`missing test registry provider for ${tag.key}`);
      // A registry that will not start is a broken fixture, not a case under
      // test, so it dies here rather than colouring every caller's error type.
      yield* Effect.orDie(host.add(entry));
    }
    return host;
  });
}

/** A provider of `PoolTag` that writes every step of its own life to `log`. */
function poolProvider(
  log: string[],
  { id = "pool", version = 1 }: { id?: string; version?: number } = {},
) {
  const pool: Pool = { version, open: false };
  const definition = definePlugin({
    id,
    apiVersion: "1",
    provide: [PoolTag],
    effect: (ctx) =>
      Effect.gen(function* () {
        pool.open = true;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            pool.open = false;
            log.push(`${id} closed pool`);
          }),
        );
        ctx.provide(PoolTag, pool);
        log.push(`${id} provided v${version}`);
      }),
  });
  return { definition, pool };
}

/** A plugin that cannot run without `PoolTag` and reports what it saw. */
function poolConsumer(log: string[], id = "consumer"): PluginDefinition {
  return definePlugin({
    id,
    apiVersion: "1",
    inject: [PoolTag],
    effect: () =>
      Effect.gen(function* () {
        const pool = yield* PoolTag;
        log.push(`${id} started on v${pool.version}`);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => log.push(`${id} released, pool open=${pool.open}`)),
        );
      }),
  });
}

// --- Gating ---

testEffect("a plugin whose injected service nothing can provide is refused", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    const refused = yield* host.reconcile([poolConsumer(log)]);
    yield* Effect.yieldNow;

    // Not "waiting". No entry in the configuration declares 'test/Pool', so no
    // provider can arrive, and waiting on one is a plugin that is broken rather
    // than pending — which the host can tell before it starts anything.
    expect(refused).toEqual([{ id: "consumer", key: "test/Pool" }]);
    expect(host.status()).toEqual([]);
    expect(log).toEqual([]);
  }),
);

testEffect("registry services attribute writes to the running plugin", () =>
  Effect.gen(function* () {
    const host = yield* makeHost([RegionsTag]);
    const panel: Panel = {
      id: "service-panel",
      region: "left",
      anchor: "app",
      size: () => 1,
      component: () => null as never,
    };
    yield* host.add(
      definePlugin({
        id: "registry-consumer",
        apiVersion: "1",
        inject: [RegionsTag],
        effect: () =>
          Effect.gen(function* () {
            const regions = yield* RegionsTag;
            yield* regions.register(panel);
          }),
      }),
    );
    expect(host.status().filter((status) => status.id === "registry-consumer")).toEqual([
      { id: "registry-consumer", waitingFor: [] },
    ]);
  }),
);

testEffect("provider contexts preserve primitive service values", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const seen: number[] = [];

    yield* host.add(
      definePlugin({
        id: "number-provider",
        apiVersion: "1",
        provide: [NumberTag],
        effect: (ctx) => Effect.sync(() => void ctx.provide(NumberTag, 42)),
      }),
    );
    yield* host.add(
      definePlugin({
        id: "number-consumer",
        apiVersion: "1",
        inject: [NumberTag],
        effect: () =>
          Effect.gen(function* () {
            seen.push(yield* NumberTag);
          }),
      }),
    );

    expect(seen).toEqual([42]);
  }),
);

testEffect("the provider arriving last still activates the plugins that waited", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.reconcile([
      poolConsumer(log, "first"),
      poolConsumer(log, "second"),
      poolProvider(log).definition,
    ]);
    yield* Effect.yieldNow;

    // The provider is configured after both consumers and still runs before
    // them: order comes from who provides what, not from the config file.
    expect(log).toEqual(["pool provided v1", "first started on v1", "second started on v1"]);
    expect(host.status().map((s) => s.waitingFor)).toEqual([[], [], []]);
  }),
);

testEffect("a chain activates in dependency order from a single root", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    // Listed leaf-first, so nothing can start until the root arrives.
    yield* host.reconcile([
      definePlugin({
        id: "search",
        apiVersion: "1",
        inject: [IndexTag],
        effect: () => IndexTag.pipe(Effect.map((index) => void log.push(`search on ${index.of}`))),
      }),
      definePlugin({
        id: "index",
        apiVersion: "1",
        inject: [PoolTag],
        provide: [IndexTag],
        effect: (ctx) =>
          Effect.gen(function* () {
            const pool = yield* PoolTag;
            ctx.provide(IndexTag, { of: `pool v${pool.version}` });
            log.push("index built");
          }),
      }),
      poolProvider(log).definition,
    ]);
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    expect(log).toEqual(["pool provided v1", "index built", "search on pool v1"]);
  }),
);

testEffect("two plugins that inject each other both wait instead of deadlocking", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const started: string[] = [];

    // Each declares the other's key, so the configuration is satisfiable on
    // paper and both are admitted; the cycle only shows up at runtime, as two
    // plugins that never stop waiting.
    yield* host.reconcile([
      definePlugin({
        id: "a",
        apiVersion: "1",
        inject: [IndexTag],
        provide: [PoolTag],
        effect: (ctx) =>
          Effect.sync(() => {
            started.push("a");
            ctx.provide(PoolTag, { version: 1, open: true });
          }),
      }),
      definePlugin({
        id: "b",
        apiVersion: "1",
        inject: [PoolTag],
        provide: [IndexTag],
        effect: (ctx) =>
          Effect.sync(() => {
            started.push("b");
            ctx.provide(IndexTag, { of: "b" });
          }),
      }),
    ]);
    yield* Effect.yieldNow;

    expect(started).toEqual([]);
    expect(host.status().map((s) => [s.id, s.waitingFor])).toEqual([
      ["a", ["test/Index"]],
      ["b", ["test/Pool"]],
    ]);
  }),
);

// --- Soft reads ---

testEffect("get reads the current provider and stops reading once it leaves", () =>
  Effect.gen(function* () {
    const host = yield* makeHost([SpawnProvidersTag]);
    const log: string[] = [];
    const seen: number[] = [];

    const watcher = definePlugin({
      id: "watcher",
      apiVersion: "1",
      inject: [SpawnProvidersTag],
      effect: (ctx) =>
        Effect.gen(function* () {
          const providers = yield* SpawnProvidersTag;
          yield* providers.register([
            "watch",
            () => ({
              argv: [
                String(
                  Option.match(ctx.get(PoolTag), {
                    onNone: () => -1,
                    onSome: (pool) => pool.version,
                  }),
                ),
              ],
            }),
          ]);
        }),
    });

    yield* host.add(watcher);
    seen.push(Number(host.spawnProvider("watch")!.argv[0]));
    yield* host.add(poolProvider(log).definition);
    seen.push(Number(host.spawnProvider("watch")!.argv[0]));
    yield* host.remove("pool");
    seen.push(Number(host.spawnProvider("watch")!.argv[0]));

    // -1 is "nobody provides it": a soft read never waits, which is exactly
    // why a plugin that needs the service must declare it in `inject`.
    expect(seen).toEqual([-1, 1, -1]);
  }),
);

testEffect("two plugins cannot provide the same service", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];
    const errors = yield* Queue.unbounded<PluginErrorEvent>();
    const drain = yield* host.onError.pipe(
      Stream.runForEach((e) => Queue.offer(errors, e)),
      Effect.forkDetach,
    );
    yield* Effect.yieldNow;

    yield* host.add(poolProvider(log, { id: "pool-one" }).definition);
    yield* host.add(poolProvider(log, { id: "pool-two", version: 2 }).definition);
    yield* Effect.yieldNow;

    const reported = yield* Queue.takeAll(errors);
    yield* Fiber.interrupt(drain);

    const clash = reported.find((e) => e.pluginId === "pool-two");
    expect(clash?.error.message).toBe("service 'test/Pool' is already provided by 'pool-one'");
    // The first provider is untouched and still the one that answers; the
    // second unwinds its own half-built state and leaves nothing behind.
    expect(host.status().map((s) => s.id)).toEqual(["pool-one"]);
    expect(log).toEqual(["pool-one provided v1", "pool-two closed pool"]);
  }),
);

testEffect("a plugin cannot provide a service it did not declare", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const errors = yield* Queue.unbounded<PluginErrorEvent>();
    const drain = yield* host.onError.pipe(
      Stream.runForEach((e) => Queue.offer(errors, e)),
      Effect.forkDetach,
    );
    yield* Effect.yieldNow;

    const log: string[] = [];
    const refused = yield* host.reconcile([
      definePlugin({
        id: "smuggler",
        apiVersion: "1",
        effect: (ctx) => Effect.sync(() => ctx.provide(PoolTag, { version: 1, open: true })),
      }),
      poolConsumer(log),
    ]);
    yield* Effect.yieldNow;

    const reported = yield* Queue.takeAll(errors);
    yield* Fiber.interrupt(drain);

    expect(reported.find((e) => e.pluginId === "smuggler")?.error.message).toBe(
      "plugin 'smuggler' provided 'test/Pool', which it does not declare in 'provide'",
    );
    // An undeclared provision counts for nothing when the graph is read, which
    // is the whole reason the declaration has to be total: the consumer is
    // refused even though the smuggler would in fact have published the key.
    expect(refused).toEqual([{ id: "consumer", key: "test/Pool" }]);
    // Rejected at the call site too, so the service never reaches the registry
    // and the smuggler does not stay listed as running.
    expect(host.status()).toEqual([]);
    expect(log).toEqual([]);
  }),
);

// --- Withdrawal ordering ---

testEffect("a dependent finishes unwinding before its provider releases anything", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.reconcile([poolProvider(log).definition, poolConsumer(log)]);
    yield* Effect.yieldNow;
    log.length = 0;

    // Both leave together: dropping only the provider is refused while the
    // consumer still injects it, so this is how a provider is taken away.
    yield* host.reconcile([]);

    expect(log).toEqual(["consumer released, pool open=true", "pool closed pool"]);
  }),
);

testEffect("teardown walks the chain leaf-first", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.reconcile([
      poolProvider(log).definition,
      definePlugin({
        id: "index",
        apiVersion: "1",
        inject: [PoolTag],
        provide: [IndexTag],
        effect: (ctx) =>
          Effect.gen(function* () {
            ctx.provide(IndexTag, { of: "pool" });
            yield* Effect.addFinalizer(() => Effect.sync(() => void log.push("index released")));
          }),
      }),
      definePlugin({
        id: "search",
        apiVersion: "1",
        inject: [IndexTag],
        effect: () =>
          Effect.addFinalizer(() => Effect.sync(() => void log.push("search released"))).pipe(
            Effect.asVoid,
          ),
      }),
    ]);
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    log.length = 0;

    yield* host.reconcile([]);

    expect(log).toEqual(["search released", "index released", "pool closed pool"]);
  }),
);

testEffect("dispose unwinds dependents before their providers", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.add(poolProvider(log).definition);
    yield* host.add(poolConsumer(log));
    yield* Effect.yieldNow;
    log.length = 0;

    yield* host.dispose;

    expect(log).toEqual(["consumer released, pool open=true", "pool closed pool"]);
    expect(host.status()).toEqual([]);
  }),
);

// --- Replacement ---

testEffect("a provider cannot be dropped while something injects it", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.reconcile([poolProvider(log).definition, poolConsumer(log)]);
    yield* Effect.yieldNow;
    log.length = 0;

    const error = yield* Effect.flip(host.remove("pool"));

    // The consumer did nothing wrong, so the departure is refused rather than
    // the consumer unloaded behind the user's back. This is the whole of
    // "replaceable, not removable" — replacement is the test below, and no
    // plugin carries a flag saying which it is.
    expect(error).toBe("cannot drop the provider of 'test/Pool': plugin 'consumer' injects it");
    expect(host.status().map((s) => s.id)).toEqual(["pool", "consumer"]);
    expect(log).toEqual([]);
  }),
);

testEffect("replacing a provider re-acquires its dependents on the new service", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    const first = poolProvider(log);
    yield* host.add(first.definition);
    yield* host.add(poolConsumer(log));
    yield* Effect.yieldNow;
    log.length = 0;

    yield* host.add(poolProvider(log, { version: 2 }).definition);
    yield* Effect.yieldNow;

    expect(log).toEqual([
      // The candidate starts privately before it replaces the old provider.
      "pool provided v2",
      "consumer released, pool open=true",
      "pool closed pool",
      "consumer started on v2",
    ]);
    expect(first.pool.open).toBe(false);
  }),
);

testEffect("equal-valued replacement providers still invalidate the committed view", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const acquired: Pool[] = [];

    yield* host.add(poolProvider([]).definition);
    yield* host.add(
      definePlugin({
        id: "consumer",
        apiVersion: "1",
        inject: [PoolTag],
        effect: () =>
          PoolTag.pipe(
            Effect.tap((pool) => Effect.sync(() => void acquired.push(pool))),
            Effect.asVoid,
          ),
      }),
    );
    yield* Effect.yieldNow;

    yield* host.add(poolProvider([]).definition);
    yield* Effect.yieldNow;

    expect(acquired).toHaveLength(2);
    expect(acquired[0]!.version).toBe(acquired[1]!.version);
    expect(acquired[0]).not.toBe(acquired[1]);
  }),
);

testEffect("a provider that crashes takes its dependents back to waiting", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.reconcile([
      poolConsumer(log),
      definePlugin({
        id: "pool",
        apiVersion: "1",
        provide: [PoolTag],
        effect: (ctx) =>
          Effect.gen(function* () {
            ctx.provide(PoolTag, { version: 1, open: true });
            log.push("pool provided v1");
            yield* Effect.yieldNow;
            return yield* Effect.sync(() => {
              throw new Error("provider died");
            });
          }),
      }),
    ]);
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    expect(log).toEqual([
      "pool provided v1",
      "consumer started on v1",
      "consumer released, pool open=true",
    ]);
    expect(host.status()).toEqual([{ id: "consumer", waitingFor: ["test/Pool"] }]);
  }),
);
