import { afterEach, expect } from "bun:test";
import { Chunk, Context, Effect, Fiber, Option, Queue, Scope, Stream } from "effect";
import { testEffect } from "../test-effect.ts";
import { createPluginHost, type PluginHost } from "./host.ts";
import { definePlugin, type PluginDefinition, type PluginErrorEvent } from "./types.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { testPluginEnvironment } from "./test-environment.ts";
import { RegionsTag } from "./services.ts";
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

class PoolTag extends Context.Tag("test/Pool")<PoolTag, Pool>() {}
class IndexTag extends Context.Tag("test/Index")<IndexTag, { readonly of: string }>() {}

const cleanupFns: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanupFns.splice(0)) fn();
});

function makeHost(): Effect.Effect<PluginHost, never, Scope.Scope> {
  return Effect.gen(function* () {
    const t = yield* Effect.promise(() => createTestRenderer({ width: 80, height: 24 }));
    cleanupFns.push(() => t.renderer.destroy());
    return yield* createPluginHost(testPluginEnvironment(t.renderer));
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

testEffect("a plugin whose injected service has no provider does not start", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.add(poolConsumer(log));
    yield* Effect.yieldNow();

    expect(log).toEqual([]);
    expect(host.status()).toEqual([{ id: "consumer", waitingFor: ["test/Pool"] }]);
  }),
);

testEffect("registry services attribute writes to the running plugin", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
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
    expect(host.status()).toEqual([{ id: "registry-consumer", waitingFor: [] }]);
  }),
);

testEffect("the provider arriving last still activates the plugins that waited", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.add(poolConsumer(log, "first"));
    yield* host.add(poolConsumer(log, "second"));
    expect(log).toEqual([]);

    yield* host.add(poolProvider(log).definition);
    yield* Effect.yieldNow();

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

    // Added leaf-first, so nothing can start until the root arrives.
    yield* host.add(
      definePlugin({
        id: "search",
        apiVersion: "1",
        inject: [IndexTag],
        effect: () => IndexTag.pipe(Effect.map((index) => void log.push(`search on ${index.of}`))),
      }),
    );
    yield* host.add(
      definePlugin({
        id: "index",
        apiVersion: "1",
        inject: [PoolTag],
        effect: (ctx) =>
          Effect.gen(function* () {
            const pool = yield* PoolTag;
            ctx.provide(IndexTag, { of: `pool v${pool.version}` });
            log.push("index built");
          }),
      }),
    );
    yield* host.add(poolProvider(log).definition);
    yield* Effect.yieldNow();
    yield* Effect.yieldNow();

    expect(log).toEqual(["pool provided v1", "index built", "search on pool v1"]);
  }),
);

testEffect("two plugins that inject each other both wait instead of deadlocking", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const started: string[] = [];

    yield* host.add(
      definePlugin({
        id: "a",
        apiVersion: "1",
        inject: [IndexTag],
        effect: (ctx) =>
          Effect.sync(() => {
            started.push("a");
            ctx.provide(PoolTag, { version: 1, open: true });
          }),
      }),
    );
    yield* host.add(
      definePlugin({
        id: "b",
        apiVersion: "1",
        inject: [PoolTag],
        effect: (ctx) =>
          Effect.sync(() => {
            started.push("b");
            ctx.provide(IndexTag, { of: "b" });
          }),
      }),
    );
    yield* Effect.yieldNow();

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
    const host = yield* makeHost();
    const log: string[] = [];
    const seen: number[] = [];

    const watcher = definePlugin({
      id: "watcher",
      apiVersion: "1",
      effect: (ctx) =>
        Effect.sync(() => {
          ctx.registerSpawnProvider("watch", () => ({
            argv: [
              String(
                Option.match(ctx.get(PoolTag), {
                  onNone: () => -1,
                  onSome: (pool) => pool.version,
                }),
              ),
            ],
          }));
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
      Effect.forkDaemon,
    );
    yield* Effect.yieldNow();

    yield* host.add(poolProvider(log, { id: "pool-one" }).definition);
    yield* host.add(poolProvider(log, { id: "pool-two", version: 2 }).definition);
    yield* Effect.yieldNow();

    const reported = Chunk.toReadonlyArray(yield* Queue.takeAll(errors));
    yield* Fiber.interrupt(drain);

    const clash = reported.find((e) => e.pluginId === "pool-two");
    expect(clash?.error.message).toBe("service 'test/Pool' is already provided by 'pool-one'");
    // The first provider is untouched and still the one that answers; the
    // second unwinds its own half-built state and leaves nothing behind.
    expect(host.status().map((s) => s.id)).toEqual(["pool-one"]);
    expect(log).toEqual(["pool-one provided v1", "pool-two closed pool"]);
  }),
);

// --- Withdrawal ordering ---

testEffect("a dependent finishes unwinding before its provider releases anything", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.add(poolProvider(log).definition);
    yield* host.add(poolConsumer(log));
    yield* Effect.yieldNow();
    log.length = 0;

    yield* host.remove("pool");

    expect(log).toEqual(["consumer released, pool open=true", "pool closed pool"]);
  }),
);

testEffect("teardown walks the chain leaf-first", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.add(poolProvider(log).definition);
    yield* host.add(
      definePlugin({
        id: "index",
        apiVersion: "1",
        inject: [PoolTag],
        effect: (ctx) =>
          Effect.gen(function* () {
            ctx.provide(IndexTag, { of: "pool" });
            yield* Effect.addFinalizer(() => Effect.sync(() => void log.push("index released")));
          }),
      }),
    );
    yield* host.add(
      definePlugin({
        id: "search",
        apiVersion: "1",
        inject: [IndexTag],
        effect: () =>
          Effect.addFinalizer(() => Effect.sync(() => void log.push("search released"))).pipe(
            Effect.asVoid,
          ),
      }),
    );
    yield* Effect.yieldNow();
    yield* Effect.yieldNow();
    log.length = 0;

    yield* host.remove("pool");

    expect(log).toEqual(["search released", "index released", "pool closed pool"]);
  }),
);

testEffect("dispose unwinds dependents before their providers", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.add(poolProvider(log).definition);
    yield* host.add(poolConsumer(log));
    yield* Effect.yieldNow();
    log.length = 0;

    yield* host.dispose;

    expect(log).toEqual(["consumer released, pool open=true", "pool closed pool"]);
    expect(host.status()).toEqual([]);
  }),
);

// --- Replacement ---

testEffect("a withdrawn provider leaves its dependents waiting, not stopped", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.add(poolProvider(log).definition);
    yield* host.add(poolConsumer(log));
    yield* Effect.yieldNow();

    yield* host.remove("pool");
    expect(host.status()).toEqual([{ id: "consumer", waitingFor: ["test/Pool"] }]);

    log.length = 0;
    yield* host.add(poolProvider(log, { version: 7 }).definition);
    yield* Effect.yieldNow();

    expect(log).toEqual(["pool provided v7", "consumer started on v7"]);
  }),
);

testEffect("replacing a provider re-acquires its dependents on the new service", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    const first = poolProvider(log);
    yield* host.add(first.definition);
    yield* host.add(poolConsumer(log));
    yield* Effect.yieldNow();
    log.length = 0;

    yield* host.add(poolProvider(log, { version: 2 }).definition);
    yield* Effect.yieldNow();

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

testEffect("a provider that crashes takes its dependents back to waiting", () =>
  Effect.gen(function* () {
    const host = yield* makeHost();
    const log: string[] = [];

    yield* host.add(poolConsumer(log));
    yield* host.add(
      definePlugin({
        id: "pool",
        apiVersion: "1",
        effect: (ctx) =>
          Effect.gen(function* () {
            ctx.provide(PoolTag, { version: 1, open: true });
            log.push("pool provided v1");
            yield* Effect.yieldNow();
            return yield* Effect.sync(() => {
              throw new Error("provider died");
            });
          }),
      }),
    );
    yield* Effect.yieldNow();
    yield* Effect.yieldNow();
    yield* Effect.yieldNow();

    expect(log).toEqual([
      "pool provided v1",
      "consumer started on v1",
      "consumer released, pool open=true",
    ]);
    expect(host.status()).toEqual([{ id: "consumer", waitingFor: ["test/Pool"] }]);
  }),
);
