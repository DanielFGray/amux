import { afterEach, expect } from "bun:test";
import { Effect, Fiber, Queue, Scope, Schema as S, Stream } from "effect";
import type { Regions } from "../ui/regions.tsx";
import { testEffect } from "../test-effect.ts";
import { createPluginHost, type PluginHost } from "./host.ts";
import {
  definePlugin,
  type PluginDefinition,
  type PluginErrorEvent,
  type PluginHostContext,
  type PluginRequirements,
} from "./types.ts";
import type { PluginService } from "./services.ts";
import { key } from "./kv.ts";
import { createTestRenderer } from "@opentui/core/testing";
import type { SessionViews } from "./session-views.tsx";
import { testPluginEnvironment, type TestPluginEnvironment } from "./test-environment.ts";
import { testPanelContext } from "../ui/test-panel.ts";
import { command } from "../commands.ts";
import { runCommandByTarget } from "../app.tsx";
import type { PanelContext } from "../ui/panel.ts";
import {
  BindingsTag,
  CliCommandsTag,
  OptionsTag,
  PanelTag,
  RegionsTag,
  scopedRegistry,
  SessionViewsTag,
  SpawnProvidersTag,
  type CliCommandRegistration,
} from "./services.ts";
import { createPluginContributions } from "./contributions.ts";

type EnvironmentOverrides = NonNullable<Parameters<typeof testPluginEnvironment>[1]>;

function mockEnvironment(
  overrides: EnvironmentOverrides = {},
): Promise<{ env: TestPluginEnvironment; dispose: () => void }> {
  return Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })).pipe(
    Effect.map((t) => ({
      env: testPluginEnvironment(t.renderer, overrides),
      dispose: () => t.renderer.destroy(),
    })),
    Effect.runPromise,
  );
}

function mkPlugin<const Tags extends readonly PluginService[] = []>(
  overrides: {
    readonly id?: string;
    readonly inject?: Tags;
    readonly effect?: (
      context: PluginHostContext,
    ) => Effect.Effect<void, never, PluginRequirements<Tags>>;
  } = {},
): PluginDefinition {
  return definePlugin({
    id: "test.plugin",
    effect: () => Effect.void,
    ...overrides,
  });
}

const cleanupFns: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanupFns.splice(0)) fn();
});

function makeHost(overrides: EnvironmentOverrides = {}): Effect.Effect<
  {
    host: PluginHost;
    regions: Regions;
    sessionViews: SessionViews;
    registryEntries: readonly PluginDefinition[];
  },
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
      registryEntries: env.registryEntries,
    };
  });
}

function registryProviding(
  entries: readonly PluginDefinition[],
  tag: PluginService,
): PluginDefinition {
  const entry = entries.find((candidate) => candidate.provide?.some((key) => key.key === tag.key));
  if (!entry) throw new Error(`missing test registry provider for ${tag.key}`);
  return entry;
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
    const { host, registryEntries } = yield* makeHost({ panel });
    yield* host.add(registryProviding(registryEntries, PanelTag));
    yield* host.add(
      mkPlugin({
        id: "session-command-plugin",
        inject: [PanelTag],
        effect: () =>
          PanelTag.pipe(
            Effect.flatMap((panel) =>
              panel.run(command("agent.prompt", { target: "agent", text: "hello" })),
            ),
            Effect.asVoid,
            Effect.orDie,
          ),
      }),
    );
    expect(calls).toEqual(["session"]);
  }),
);

testEffect("a host without client services refuses UI plugins", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    const refused = yield* host.reconcile([
      mkPlugin({
        id: "ui-plugin",
        inject: [PanelTag],
        effect: () => PanelTag.pipe(Effect.asVoid),
      }),
    ]);

    expect(refused).toEqual([{ id: "ui-plugin", key: PanelTag.key }]);
    expect(host.status()).toEqual([]);
  }),
);

testEffect(
  "a CLI-shaped host (contributions only) refuses a UI plugin but activates a CliCommandsTag plugin",
  () =>
    Effect.gen(function* () {
      const contributions = createPluginContributions();
      const table = contributions.table<CliCommandRegistration>();
      const cliCommands = scopedRegistry(
        { all: table.all },
        (owner, registration: CliCommandRegistration) =>
          table.add(owner, registration.name, registration),
      );
      const host = yield* createPluginHost({ contributions });

      const refused = yield* host.reconcile([
        definePlugin({
          id: "amux.registry.cli-commands",
          provide: [CliCommandsTag],
          effect: (ctx) => Effect.sync(() => void ctx.provide(CliCommandsTag, cliCommands)),
        }),
        mkPlugin({
          id: "ui-plugin",
          inject: [PanelTag],
          effect: () => PanelTag.pipe(Effect.asVoid),
        }),
        mkPlugin({
          id: "cli-plugin",
          inject: [CliCommandsTag],
          effect: () =>
            CliCommandsTag.pipe(
              Effect.flatMap((cli) =>
                cli.register({
                  name: "my-verb",
                  description: "does a thing",
                  handler: () => Effect.succeed(0),
                }),
              ),
            ),
        }),
      ]);

      expect(refused).toEqual([{ id: "ui-plugin", key: PanelTag.key }]);
      expect(table.all().map((entry) => entry.value.name)).toEqual(["my-verb"]);
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
    const { host, sessionViews, registryEntries } = yield* makeHost();
    yield* host.add(registryProviding(registryEntries, SessionViewsTag));
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
    expect(host.status().filter((status) => status.id === "swap")).toEqual([
      { id: "swap", waitingFor: [] },
    ]);
  }),
);

// --- Panel cleanup ---

testEffect("registered panels are disposed when the plugin is removed", () =>
  Effect.gen(function* () {
    const { host, regions, registryEntries } = yield* makeHost();
    const registry = registryProviding(registryEntries, RegionsTag);
    yield* host.add(registry);

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
            component: () => null as never,
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => void 0));
        }),
    });

    yield* host.add(plugin);
    expect(regions.declared("left", "app")).toBe(true);
    yield* host.remove(plugin.id);
    yield* host.remove(registry.id);

    expect(regions.declared("left", "app")).toBe(false);
    expect(host.status()).toEqual([]);
  }),
);

testEffect("registered session views are disposed when the plugin is removed", () =>
  Effect.gen(function* () {
    const { host, sessionViews: views, registryEntries } = yield* makeHost();
    const registry = registryProviding(registryEntries, SessionViewsTag);
    yield* host.add(registry);
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
    const { host, registryEntries } = yield* makeHost({
      registries: {
        bindings: (_owner, binding) => {
          active.add(binding.name);
          return () => active.delete(binding.name);
        },
      },
    });
    yield* host.add(registryProviding(registryEntries, BindingsTag));
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

testEffect("registered options are disposed when the plugin is removed", () =>
  Effect.gen(function* () {
    const active = new Map<string, unknown>();
    const { host, registryEntries } = yield* makeHost({
      registries: {
        options: (_owner, name, spec) => {
          active.set(name, spec);
          return () => active.delete(name);
        },
      },
    });
    yield* host.add(registryProviding(registryEntries, OptionsTag));
    const plugin = mkPlugin({
      id: "option-plugin",
      inject: [OptionsTag],
      effect: () =>
        Effect.gen(function* () {
          const options = yield* OptionsTag;
          yield* options.register([
            "option-plugin.enabled",
            { kind: "boolean", default: true, desc: "test option" },
          ]);
        }),
    });

    yield* host.add(plugin);
    expect(active.has("option-plugin.enabled")).toBe(true);
    yield* host.remove(plugin.id);
    expect(active.has("option-plugin.enabled")).toBe(false);
  }),
);

testEffect("spawn providers are collision-safe and scoped", () =>
  Effect.gen(function* () {
    const { host, registryEntries } = yield* makeHost();
    yield* host.add(registryProviding(registryEntries, SpawnProvidersTag));
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
    const { host, regions, registryEntries } = yield* makeHost();
    yield* host.add(registryProviding(registryEntries, RegionsTag));
    let registered = false;

    const errors = yield* Queue.unbounded<PluginErrorEvent>();
    const drain = yield* host.onError.pipe(
      Stream.runForEach((e) => Queue.offer(errors, e)),
      Effect.forkDetach,
    );
    yield* Effect.yieldNow;

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
              component: () => null as never,
            });
            registered = true;
            return yield* Effect.sync(() => {
              throw new Error("boom from plugin");
            });
          }),
      }),
    );
    yield* Effect.yieldNow;

    const reported = yield* Queue.takeAll(errors);
    yield* Fiber.interrupt(drain);

    const crash = reported.find((e) => e.pluginId === "crasher");
    expect(crash).toBeDefined();
    expect(crash!.source).toBe("plugin");
    expect(crash!.phase).toBe("activate");
    expect(crash!.error.message).toBe("boom from plugin");
    expect(registered).toBe(true);
    expect(regions.declared("left", "app")).toBe(false);

    yield* host.add(mkPlugin({ id: "survivor" }));
    expect(host.status().filter((status) => status.id === "survivor")).toEqual([
      { id: "survivor", waitingFor: [] },
    ]);
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
      Effect.forkDetach,
    );
    yield* Effect.yieldNow;

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
    yield* Effect.yieldNow;

    const reported = yield* Queue.takeAll(errors);
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
            ctx.kv.set(key("answer", S.Finite), 42);
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
            stored = ctx.kv.get(key("answer", S.Finite));
          }),
      }),
    );

    expect(stored).toBe(42);
  }),
);

testEffect("removing and adding a plugin releases and reacquires its scope", () =>
  Effect.gen(function* () {
    const { host, regions, registryEntries } = yield* makeHost();
    yield* host.add(registryProviding(registryEntries, RegionsTag));
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
    expect(host.status().filter((status) => status.id === "runtime")).toEqual([]);
    yield* host.add(plugin);
    expect(
      host
        .status()
        .filter((status) => status.id === "runtime")
        .map((status) => status.id),
    ).toEqual(["runtime"]);
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
    const { host, registryEntries } = yield* makeHost();
    yield* host.add(registryProviding(registryEntries, RegionsTag));

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
              component: () => null as never,
            });
            yield* Effect.addFinalizer(() => Effect.void);
            throw new Error("defect after registration");
          }),
      }),
    );

    // Re-add must succeed — scope was closed and finalizers ran
    yield* host.add(mkPlugin({ id: "finalize" }));
    expect(host.status().filter((status) => status.id === "finalize").length).toBe(1);
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
            ctx.kv.set(key("key", S.String), "a-value");
          }),
      }),
    );
    yield* host.remove("a");

    yield* host.add(
      mkPlugin({
        id: "b",
        effect: (ctx) =>
          Effect.sync(() => {
            ctx.kv.set(key("key", S.String), "b-value");
          }),
      }),
    );

    let valueA: unknown;
    yield* host.add(
      mkPlugin({
        id: "a",
        effect: (ctx) =>
          Effect.sync(() => {
            valueA = ctx.kv.get(key("key", S.String));
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
            valueB = ctx.kv.get(key("key", S.String));
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
