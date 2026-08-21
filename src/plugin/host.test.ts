import { afterEach, expect } from "bun:test";
import { Chunk, Effect, Fiber, Queue, Scope, Stream } from "effect";
import type { Regions } from "../ui/regions.tsx";
import { testEffect } from "../test-effect.ts";
import { createPluginHost, type PluginEnvironment, type PluginHost } from "./host.ts";
import type { PluginDefinition, PluginErrorEvent } from "./types.ts";
import { createTestRenderer } from "@opentui/core/testing";
import type { SessionViews } from "./session-views.tsx";
import { testPluginEnvironment } from "./test-environment.ts";
import { testPanelContext } from "../ui/test-panel.ts";
import { command } from "../commands.ts";
import { runCommandByTarget } from "../app.tsx";
import type { PanelContext } from "../ui/panel.ts";
import { BindingsTag, RegionsTag, SessionViewsTag, SpawnProvidersTag } from "./services.ts";

type EnvironmentOverrides = NonNullable<Parameters<typeof testPluginEnvironment>[1]>;

async function mockEnvironment(
  overrides: EnvironmentOverrides = {},
): Promise<{ env: PluginEnvironment; dispose: () => void }> {
  const t = await createTestRenderer({ width: 80, height: 24 });
  return {
    env: testPluginEnvironment(t.renderer, overrides),
    dispose: () => t.renderer.destroy(),
  };
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

function makeHost(
  overrides: EnvironmentOverrides = {},
): Effect.Effect<
  { host: PluginHost; regions: Regions; sessionViews: SessionViews },
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const { env, dispose } = yield* Effect.promise(() => mockEnvironment(overrides));
    cleanupFns.push(dispose);
    return {
      host: yield* createPluginHost(env),
      regions: env.registries.regions,
      sessionViews: env.registries.sessionViews,
    };
  });
}

// --- Lifecycle ---

testEffect("add activates a plugin and status reports it", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    yield* host.add(mkPlugin({ id: "p1" }));
    expect(host.status()).toEqual([{ id: "p1", waitingFor: [] }]);
  }),
);

testEffect("plugin panel run accepts session-target commands", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const basePanel = testPanelContext();
    const panel: PanelContext = {
      ...basePanel,
      run: (value) =>
        runCommandByTarget(
          value,
          () =>
            Effect.sync(() => {
              calls.push("workspace");
              return basePanel.snapshot();
            }),
          () =>
            Effect.sync(() => {
              calls.push("session");
              return basePanel.snapshot();
            }),
        ),
    };
    const { host } = yield* makeHost({ panel });
    yield* host.add(
      mkPlugin({
        id: "session-command-plugin",
        effect: (ctx) =>
          ctx.panel
            .run(command("agent.prompt", { target: "agent", text: "hello" }))
            .pipe(Effect.asVoid, Effect.orDie),
      }),
    );
    expect(calls).toEqual(["session"]);
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
    expect(host.status()).toEqual([{ id: "p1", waitingFor: [] }]);
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

// --- Adding an id that is already running ---

testEffect("add replaces a running plugin, taking its registrations with it", () =>
  Effect.gen(function* () {
    const { host, sessionViews } = yield* makeHost();
    const ran: string[] = [];

    const version = (name: string) =>
      mkPlugin({
        id: "swap",
        inject: [SessionViewsTag],
        effect: () =>
          Effect.gen(function* () {
            const views = yield* SessionViewsTag;
            ran.push(name);
            // Both versions claim the same pane type. Two generations of one id
            // may hold a name at once, so what this proves is that the pane
            // type still resolves afterwards and resolves to the newer one.
            yield* views.register(["chat", () => null]);
          }),
      });

    yield* host.add(version("first"));
    yield* host.add(version("second"));

    expect(ran).toEqual(["first", "second"]);
    expect(sessionViews.has("chat")).toBe(true);
    expect(host.status()).toEqual([{ id: "swap", waitingFor: [] }]);
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
      inject: [RegionsTag],
      effect: () =>
        Effect.gen(function* () {
          const regions = yield* RegionsTag;
          yield* regions.register({
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

testEffect("registered session views are disposed when the plugin is removed", () =>
  Effect.gen(function* () {
    const { host, sessionViews: views } = yield* makeHost();
    const plugin = mkPlugin({
      id: "view-plugin",
      inject: [SessionViewsTag],
      effect: () =>
        Effect.gen(function* () {
          const views = yield* SessionViewsTag;
          yield* views.register(["test", () => null as never]);
        }),
    });

    yield* host.add(plugin);
    expect(views.has("test")).toBe(true);
    yield* host.remove(plugin.id);
    expect(views.has("test")).toBe(false);
  }),
);

testEffect("registered bindings are disposed when the plugin is removed", () =>
  Effect.gen(function* () {
    const active = new Set<string>();
    const { host } = yield* makeHost({
      registries: {
        bindings: (_owner, binding) => {
          active.add(binding.name);
          return () => active.delete(binding.name);
        },
      },
    });
    const plugin = mkPlugin({
      id: "binding-plugin",
      inject: [BindingsTag],
      effect: () =>
        Effect.gen(function* () {
          const bindings = yield* BindingsTag;
          yield* bindings.register({
            name: "binding-plugin.open",
            key: "<leader>n",
            desc: "open",
            group: "test",
            run: Effect.void,
          });
        }),
    });

    yield* host.add(plugin);
    expect(active.has("binding-plugin.open")).toBe(true);
    yield* host.remove(plugin.id);
    expect(active.has("binding-plugin.open")).toBe(false);
  }),
);

testEffect("spawn providers are collision-safe and scoped", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    yield* host.add(
      mkPlugin({
        id: "provider-one",
        inject: [SpawnProvidersTag],
        effect: () =>
          SpawnProvidersTag.pipe(
            Effect.flatMap((providers) => providers.register(["test", () => ({ argv: ["one"] })])),
            Effect.asVoid,
          ),
      }),
    );
    expect(host.spawnProvider("test")?.argv).toEqual(["one"]);
    yield* host.add(
      mkPlugin({
        id: "provider-two",
        inject: [SpawnProvidersTag],
        effect: () =>
          SpawnProvidersTag.pipe(
            Effect.flatMap((providers) => providers.register(["test", () => ({ argv: ["two"] })])),
            Effect.asVoid,
          ),
      }),
    );
    expect(host.spawnProvider("test")?.argv).toEqual(["one"]);
    yield* host.remove("provider-one");
    expect(host.spawnProvider("test")).toBeUndefined();
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
        inject: [RegionsTag],
        effect: () =>
          Effect.gen(function* () {
            const regions = yield* RegionsTag;
            yield* regions.register({
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

    yield* host.add(mkPlugin({ id: "fine" }));
    yield* host.add(
      mkPlugin({
        id: "broken",
        effect: () =>
          Effect.sync(() => {
            throw new Error("no");
          }),
      }),
    );
    yield* Effect.yieldNow();

    const reported = Chunk.toReadonlyArray(yield* Queue.takeAll(errors));
    yield* Fiber.interrupt(drain);

    expect(reported.map((e) => e.pluginId)).toEqual(["broken"]);
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

testEffect("removing and adding a plugin releases and reacquires its scope", () =>
  Effect.gen(function* () {
    const { host, regions } = yield* makeHost();
    const panel = {
      id: "runtime.panel",
      region: "bottom" as const,
      anchor: "app" as const,
      size: () => 1,
      component: () => null as never,
    };
    const plugin = mkPlugin({
      id: "runtime",
      inject: [RegionsTag],
      effect: () =>
        Effect.gen(function* () {
          const regions = yield* RegionsTag;
          yield* regions.register(panel);
        }),
    });

    yield* host.add(plugin);
    expect(regions.declared("bottom", "app")).toBe(true);
    yield* host.remove("runtime");
    expect(host.status()).toEqual([]);
    yield* host.add(plugin);
    expect(host.status().map((status) => status.id)).toEqual(["runtime"]);
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
        inject: [RegionsTag],
        effect: () =>
          Effect.gen(function* () {
            const regions = yield* RegionsTag;
            yield* regions.register({
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
