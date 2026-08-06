import { afterEach, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { Chunk, Effect, Exit, Fiber, Queue, Scope, Stream } from "effect";
import { createPanelContext, type PanelContext, type SidebarDisplay } from "../ui/panel.ts";
import { createRegions, type Regions } from "../ui/regions.tsx";
import { resolveOptions } from "../options.ts";
import { testEffect } from "../test-effect.ts";
import { createPluginHost, type PluginHost } from "./host.ts";
import type { PluginDefinition, PluginErrorEvent } from "./types.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import type { CliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

function emptySnapshot(revision = 0): WorkspaceSnapshot {
  return { revision, spaces: [], state: { activeSpace: null } };
}

function emptyDisplay(): SidebarDisplay {
  return { rows: [], spaceCount: 0, agentCount: 0, blockedCount: 0 };
}

function mockPanelContext(): PanelContext {
  const [snapshot] = createSignal<WorkspaceSnapshot>(emptySnapshot());
  const [tick] = createSignal(0);
  const [options] = createSignal(resolveOptions({}));
  const [display] = createSignal(emptyDisplay());
  const [selected] = createSignal<string | null>(null);
  return createPanelContext(
    snapshot,
    tick,
    () => Effect.succeed(emptySnapshot()),
    options,
    () => {},
    display,
    () => {},
    selected,
    () => {},
  );
}

async function mockRegions(): Promise<{
  regions: Regions;
  renderer: CliRenderer;
  dispose: () => void;
}> {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const regions = createRegions(t.renderer);
  return { regions, renderer: t.renderer, dispose: () => t.renderer.destroy() };
}

function mkPlugin(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id: "test.plugin",
    apiVersion: "1",
    effect: () => Effect.void,
    ...overrides,
  };
}

const cleanupFns: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanupFns.splice(0)) fn();
});

function makeHost(): Effect.Effect<{ host: PluginHost; regions: Regions }, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { regions, dispose } = yield* Effect.promise(() => mockRegions());
    cleanupFns.push(dispose);
    const panelCtx = mockPanelContext();
    return { host: yield* createPluginHost(panelCtx, regions), regions };
  });
}

// --- Lifecycle ---

testEffect("add activates a plugin and status reports it", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    yield* host.add(mkPlugin({ id: "p1" }));
    expect(host.status()).toEqual([{ id: "p1", active: true, error: null }]);
  }),
);

testEffect("remove deactivates a plugin and status clears it", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    yield* host.add(mkPlugin({ id: "p1" }));
    yield* host.remove("p1");
    expect(host.status()).toEqual([]);
  }),
);

testEffect("remove of an unknown id is a no-op", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    yield* host.add(mkPlugin({ id: "p1" }));
    yield* host.remove("nope");
    expect(host.status()).toEqual([{ id: "p1", active: true, error: null }]);
  }),
);

testEffect("dispose removes every active plugin", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    yield* host.add(mkPlugin({ id: "a" }));
    yield* host.add(mkPlugin({ id: "b" }));
    yield* host.dispose;
    expect(host.status()).toEqual([]);
  }),
);

// --- Duplicate IDs ---

testEffect("add with a duplicate id reports an error and does not replace", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    yield* host.add(mkPlugin({ id: "dup" }));

    const errors = yield* Queue.unbounded<PluginErrorEvent>();
    const drain = yield* host.onError.pipe(
      Stream.runForEach((e) => Queue.offer(errors, e)),
      Effect.forkDaemon,
    );
    yield* Effect.yieldNow();

    yield* host.add(mkPlugin({ id: "dup" }));
    yield* Effect.yieldNow();

    const reported = Chunk.toReadonlyArray(yield* Queue.takeAll(errors));
    yield* Fiber.interrupt(drain);

    const duplicate = reported.filter((e) => e.phase === "activate" && e.pluginId === "dup");
    expect(duplicate.length).toBe(1);
    expect(duplicate[0]!.source).toBe("host");
    expect(duplicate[0]!.error.message).toContain("already active");
    expect(host.status()).toEqual([{ id: "dup", active: true, error: null }]);
  }),
);

// --- apiVersion ---

testEffect("add rejects an unsupported apiVersion", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();

    const errors = yield* Queue.unbounded<PluginErrorEvent>();
    const drain = yield* host.onError.pipe(
      Stream.runForEach((e) => Queue.offer(errors, e)),
      Effect.forkDaemon,
    );
    yield* Effect.yieldNow();

    yield* host.add(mkPlugin({ id: "badver", apiVersion: "99" }));
    yield* Effect.yieldNow();

    const reported = Chunk.toReadonlyArray(yield* Queue.takeAll(errors));
    yield* Fiber.interrupt(drain);

    const versionError = reported.find((e) => e.pluginId === "badver");
    expect(versionError).toBeDefined();
    expect(versionError!.error.message).toContain("apiVersion '99'");
    expect(versionError!.error.message).toContain("supports '1'");
    expect(host.status()).toEqual([]);
  }),
);

// --- Panel cleanup ---

testEffect("registered panels are disposed when the plugin is removed", () =>
  Effect.gen(function* () {
    const { host, regions } = yield* makeHost();

    const plugin = mkPlugin({
      id: "panel-plugin",
      effect: (ctx) =>
        Effect.gen(function* () {
          ctx.registerPanel({
            id: "panel-plugin.test",
            region: "left",
            anchor: "app",
            size: () => 20,
            component: () => null as unknown as never,
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => void 0));
        }),
    });

    yield* host.add(plugin);
    expect(regions.declared("left", "app")).toBe(true);
    yield* host.remove(plugin.id);

    expect(regions.declared("left", "app")).toBe(false);
    expect(host.status()).toEqual([]);
  }),
);

// --- Defect isolation ---

testEffect("a plugin effect that throws a defect reports the error without crashing the host", () =>
  Effect.gen(function* () {
    const { host, regions } = yield* makeHost();
    let registered = false;

    const errors = yield* Queue.unbounded<PluginErrorEvent>();
    const drain = yield* host.onError.pipe(
      Stream.runForEach((e) => Queue.offer(errors, e)),
      Effect.forkDaemon,
    );
    yield* Effect.yieldNow();

    yield* host.add(
      mkPlugin({
        id: "crasher",
        effect: (ctx) =>
          Effect.gen(function* () {
            ctx.registerPanel({
              id: "crasher.test",
              region: "left",
              anchor: "app",
              size: () => 20,
              component: () => null as unknown as never,
            });
            registered = true;
            return yield* Effect.sync(() => {
              throw new Error("boom from plugin");
            });
          }),
      }),
    );
    yield* Effect.yieldNow();

    const reported = Chunk.toReadonlyArray(yield* Queue.takeAll(errors));
    yield* Fiber.interrupt(drain);

    const crash = reported.find((e) => e.pluginId === "crasher");
    expect(crash).toBeDefined();
    expect(crash!.source).toBe("plugin");
    expect(crash!.phase).toBe("activate");
    expect(crash!.error.message).toBe("boom from plugin");
    expect(registered).toBe(true);
    expect(regions.declared("left", "app")).toBe(false);

    yield* host.add(mkPlugin({ id: "survivor" }));
    expect(host.status().length).toBe(1);
    expect(host.status()[0]!.id).toBe("survivor");
  }),
);

// --- Multiple plugins ---

testEffect("multiple plugins can coexist and are removed independently", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    yield* host.add(mkPlugin({ id: "a" }));
    yield* host.add(mkPlugin({ id: "b" }));
    yield* host.add(mkPlugin({ id: "c" }));

    expect(host.status().length).toBe(3);

    yield* host.remove("b");
    const remaining = host.status();
    expect(remaining.length).toBe(2);
    expect(remaining.map((s) => s.id).sort()).toEqual(["a", "c"]);
  }),
);

// --- Error channel ---

testEffect("onError delivers events to subscribers after add/remove", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();

    const errors = yield* Queue.unbounded<PluginErrorEvent>();
    const drain = yield* host.onError.pipe(
      Stream.runForEach((e) => Queue.offer(errors, e)),
      Effect.forkDaemon,
    );
    yield* Effect.yieldNow();

    yield* host.add(mkPlugin({ id: "already" }));
    yield* host.add(mkPlugin({ id: "already" }));
    yield* Effect.yieldNow();

    const reported = Chunk.toReadonlyArray(yield* Queue.takeAll(errors));
    yield* Fiber.interrupt(drain);

    const dups = reported.filter((e) => e.pluginId === "already");
    expect(dups.length).toBe(1);
  }),
);

// --- KV store survives deactivation ---

testEffect("KV values survive a remove/add cycle", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();

    yield* host.add(
      mkPlugin({
        id: "kv-test",
        effect: (ctx) =>
          Effect.sync(() => {
            ctx.kv.set("answer", 42);
          }),
      }),
    );
    yield* host.remove("kv-test");

    let stored: unknown;
    yield* host.add(
      mkPlugin({
        id: "kv-test",
        effect: (ctx) =>
          Effect.sync(() => {
            stored = ctx.kv.get("answer");
          }),
      }),
    );

    expect(stored).toBe(42);
  }),
);

// --- Defect scope cleanup ---

testEffect("defect closes the plugin scope so the id can be re-added", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();

    yield* host.add(
      mkPlugin({
        id: "defected",
        effect: () =>
          Effect.sync(() => {
            throw new Error("boom");
          }),
      }),
    );

    // Re-add must succeed — the defect cleaned up state and scope
    yield* host.add(mkPlugin({ id: "defected" }));
    expect(host.status().length).toBe(1);
    expect(host.status()[0]!.id).toBe("defected");
  }),
);

testEffect("defect closes the plugin scope and runs registered finalizers", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();

    yield* host.add(
      mkPlugin({
        id: "finalize",
        effect: (ctx) =>
          Effect.gen(function* () {
            ctx.registerPanel({
              id: "finalize.test",
              region: "left",
              anchor: "app",
              size: () => 20,
              component: () => null as unknown as never,
            });
            yield* Effect.addFinalizer(() => Effect.void);
            throw new Error("defect after registration");
          }),
      }),
    );

    // Re-add must succeed — scope was closed and finalizers ran
    yield* host.add(mkPlugin({ id: "finalize" }));
    expect(host.status().length).toBe(1);
  }),
);

// --- Per-plugin KV isolation ---

testEffect("KV is isolated per plugin so plugins cannot see each other's keys", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();

    yield* host.add(
      mkPlugin({
        id: "a",
        effect: (ctx) =>
          Effect.sync(() => {
            ctx.kv.set("key", "a-value");
          }),
      }),
    );
    yield* host.remove("a");

    yield* host.add(
      mkPlugin({
        id: "b",
        effect: (ctx) =>
          Effect.sync(() => {
            ctx.kv.set("key", "b-value");
          }),
      }),
    );

    let valueA: unknown;
    yield* host.add(
      mkPlugin({
        id: "a",
        effect: (ctx) =>
          Effect.sync(() => {
            valueA = ctx.kv.get("key");
          }),
      }),
    );
    yield* host.remove("a");

    let valueB: unknown;
    yield* host.remove("b");
    yield* host.add(
      mkPlugin({
        id: "b",
        effect: (ctx) =>
          Effect.sync(() => {
            valueB = ctx.kv.get("key");
          }),
      }),
    );

    expect(valueA).toBe("a-value");
    expect(valueB).toBe("b-value");
  }),
);

// --- Idempotent dispose ---

testEffect("dispose is idempotent", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    yield* host.add(mkPlugin({ id: "p1" }));
    yield* host.dispose;
    yield* host.dispose;
    expect(host.status()).toEqual([]);
  }),
);

// --- Auto-disposal via scope closure ---

testEffect("host auto-disposes when enclosing scope closes", () =>
  Effect.gen(function* () {
    let host: PluginHost = null!;

    yield* Effect.scoped(
      Effect.gen(function* () {
        host = (yield* makeHost()).host;
        yield* host.add(mkPlugin({ id: "scoped" }));
        expect(host.status().length).toBe(1);
      }),
    );

    expect(host.status()).toEqual([]);
    yield* host.dispose;
    expect(host.status()).toEqual([]);
  }),
);
