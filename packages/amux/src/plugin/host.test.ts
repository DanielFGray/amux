import { afterEach, expect } from "bun:test";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Scope,
  Schema as S,
  Stream,
} from "effect";
import type { Slots } from "../ui/slots.ts";
import { testEffect } from "../test-effect.ts";
import { createPluginHost, type PluginHost } from "./host.ts";
import {
  definePlugin,
  type PluginDefinition,
  type PluginErrorEvent,
  type PluginHostContext,
  type PluginRequirements,
} from "./types.ts";
import { PluginActivateError } from "./activate-error.ts";
import type { PluginService } from "./services.ts";
import { key } from "./kv.ts";
import { createTestRenderer } from "@opentui/core/testing";
import type { SessionViews } from "./session-views.tsx";
import type { LayoutKinds } from "../layout-kinds.ts";
import { testPluginEnvironment, type TestPluginEnvironment } from "./test-environment.ts";
import { testPanelContext } from "../ui/test-panel.ts";
import { command } from "../commands.ts";
import { runCommandByTarget } from "../app.tsx";
import type { PanelContext } from "../ui/panel.ts";
import {
  BindingsTag,
  CliCommandsTag,
  LayoutKindsTag,
  OptionsTag,
  PanelTag,
  SlotsTag,
  scopedRegistry,
  SessionViewsTag,
  SpawnProvidersTag,
  type CliCommandRegistration,
} from "./services.ts";
import { createPluginContributions } from "./contributions.ts";
import type { LayoutKindRenderer } from "../layout-kinds.ts";

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
    ) => Effect.Effect<void, PluginActivateError, PluginRequirements<Tags>>;
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
    slots: Slots;
    sessionViews: SessionViews;
    layoutKinds: LayoutKinds;
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
      slots: env.registries.slots,
      sessionViews: env.registries.sessionViews,
      layoutKinds: env.registries.layoutKinds,
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
    expect(host.status()).toEqual([{ id: "p1", phase: "active", waitingFor: [] }]);
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
    const { refused } = yield* host.prepare([
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

      const { refused } = yield* host.prepare([
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
      yield* host.publish;

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
    expect(host.status()).toEqual([{ id: "p1", phase: "active", waitingFor: [] }]);
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
      { id: "swap", phase: "active", waitingFor: [] },
    ]);
  }),
);

testEffect("a failed replacement can be retried with the same definition", () =>
  Effect.gen(function* () {
    const host = yield* createPluginHost({ contributions: createPluginContributions() });
    let attempts = 0;
    let oldClosed = false;
    yield* host.add(
      mkPlugin({
        effect: () =>
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              oldClosed = true;
            }),
          ),
      }),
    );
    const replacement = mkPlugin({
      effect: () =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1 ? Effect.die("temporarily unavailable") : Effect.void;
        }),
    });

    expect(Exit.isFailure(yield* host.add(replacement).pipe(Effect.exit))).toBe(true);
    expect(oldClosed).toBe(false);
    yield* host.add(replacement);
    expect(attempts).toBe(2);
    expect(oldClosed).toBe(true);
  }),
);

testEffect("batch replacement keeps every old plugin when one candidate fails", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    const active: string[] = [];
    const version = (id: string, name: string, fail = false) =>
      mkPlugin({
        id,
        effect: () =>
          Effect.sync(() => {
            if (fail) throw new Error("candidate failed");
            active.push(name);
          }),
      });

    yield* host.add(version("one", "old-one"));
    yield* host.add(version("two", "old-two"));
    // Failed candidate keeps old; Publish commits the rest.
    const { refused, failed } = yield* host.prepare([
      version("one", "new-one"),
      version("two", "new-two", true),
    ]);
    yield* host.publish;

    expect(refused).toEqual([]);
    expect(failed.map((entry) => entry.id)).toEqual(["two"]);
    expect(failed[0]?.error.message).toBe("candidate failed");
    expect(
      host
        .status()
        .map((status) => [status.id, status.phase] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual([
      ["one", "active"],
      ["two", "active"],
    ]);
    expect(active).toEqual(["old-one", "old-two", "new-one"]);
  }),
);

// --- Prepare / publish / discard barrier ---

testEffect("after Prepare, contribution lookups still show the committed plugins", () =>
  Effect.gen(function* () {
    const { host, sessionViews, registryEntries } = yield* makeHost();
    const registry = registryProviding(registryEntries, SessionViewsTag);
    yield* host.add(registry);
    const view = (id: string, name: string) =>
      mkPlugin({
        id,
        inject: [SessionViewsTag],
        effect: () =>
          SessionViewsTag.pipe(
            Effect.flatMap((views) => views.register([name, () => null])),
            Effect.asVoid,
          ),
      });

    yield* host.add(view("kept", "old-view"));
    expect(sessionViews.has("old-view")).toBe(true);

    yield* host.prepare([registry, view("kept", "new-view"), view("added", "added-view")]);

    expect(sessionViews.has("old-view")).toBe(true);
    expect(sessionViews.has("new-view")).toBe(false);
    expect(sessionViews.has("added-view")).toBe(false);
    expect(host.definitions().map((definition) => definition.id)).toEqual([
      "amux.registry.session-views",
      "kept",
    ]);
  }),
);

testEffect("after Publish, replacements and additions are visible and old runs close", () =>
  Effect.gen(function* () {
    const { host, sessionViews, registryEntries } = yield* makeHost();
    const registry = registryProviding(registryEntries, SessionViewsTag);
    yield* host.add(registry);
    const closed: string[] = [];
    const view = (id: string, name: string) =>
      mkPlugin({
        id,
        inject: [SessionViewsTag],
        effect: () =>
          Effect.gen(function* () {
            const views = yield* SessionViewsTag;
            yield* views.register([name, () => null]);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed.push(name);
              }),
            );
          }),
      });

    yield* host.add(view("kept", "old-view"));
    yield* host.add(view("gone", "gone-view"));
    yield* host.prepare([registry, view("kept", "new-view"), view("added", "added-view")]);
    yield* host.publish;

    expect(sessionViews.has("old-view")).toBe(false);
    expect(sessionViews.has("gone-view")).toBe(false);
    expect(sessionViews.has("new-view")).toBe(true);
    expect(sessionViews.has("added-view")).toBe(true);
    expect(closed.sort()).toEqual(["gone-view", "old-view"]);
    expect(
      host
        .definitions()
        .map((definition) => definition.id)
        .filter((id) => !id.startsWith("amux.registry."))
        .sort(),
    ).toEqual(["added", "kept"]);
  }),
);

testEffect("after Discard, committed plugins stay and candidate finalizers run", () =>
  Effect.gen(function* () {
    const { host, sessionViews, registryEntries } = yield* makeHost();
    const registry = registryProviding(registryEntries, SessionViewsTag);
    yield* host.add(registry);
    const closed: string[] = [];
    const view = (id: string, name: string) =>
      mkPlugin({
        id,
        inject: [SessionViewsTag],
        effect: () =>
          Effect.gen(function* () {
            const views = yield* SessionViewsTag;
            yield* views.register([name, () => null]);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed.push(name);
              }),
            );
          }),
      });

    yield* host.add(view("kept", "old-view"));
    yield* host.prepare([registry, view("kept", "new-view"), view("added", "added-view")]);
    yield* host.discard;

    expect(sessionViews.has("old-view")).toBe(true);
    expect(sessionViews.has("new-view")).toBe(false);
    expect(sessionViews.has("added-view")).toBe(false);
    expect(closed.sort()).toEqual(["added-view", "new-view"]);
    expect(host.definitions().map((definition) => definition.id)).toEqual([
      "amux.registry.session-views",
      "kept",
    ]);
  }),
);

testEffect("Prepare keeps a failed id on the old run; Publish commits the rest", () =>
  Effect.gen(function* () {
    const { host, sessionViews, registryEntries } = yield* makeHost();
    const registry = registryProviding(registryEntries, SessionViewsTag);
    yield* host.add(registry);
    const view = (id: string, name: string, fail = false) =>
      mkPlugin({
        id,
        inject: [SessionViewsTag],
        effect: () =>
          Effect.gen(function* () {
            const views = yield* SessionViewsTag;
            yield* views.register([name, () => null]);
            if (fail) return yield* new PluginActivateError({ message: "candidate failed" });
          }),
      });

    yield* host.add(view("one", "old-one"));
    yield* host.add(view("two", "old-two"));
    // Failed candidate keeps old; Publish commits the rest.
    yield* host.prepare([registry, view("one", "new-one"), view("two", "new-two", true)]);
    yield* host.publish;

    expect(sessionViews.has("old-one")).toBe(false);
    expect(sessionViews.has("new-one")).toBe(true);
    expect(sessionViews.has("old-two")).toBe(true);
    expect(sessionViews.has("new-two")).toBe(false);
    expect(
      host
        .status()
        .filter((status) => status.id === "one" || status.id === "two")
        .map((status) => [status.id, status.phase] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual([
      ["one", "active"],
      ["two", "active"],
    ]);
  }),
);

class StagedNumberTag extends Context.Service<StagedNumberTag, number>()("test/StagedNumber") {}

testEffect("host.get does not see add-candidate services before Publish", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    const seen: number[] = [];
    const consumerStarted = yield* Deferred.make<void>();

    yield* host.prepare([
      definePlugin({
        id: "number-provider",
        provide: [StagedNumberTag],
        effect: (ctx) => Effect.sync(() => void ctx.provide(StagedNumberTag, 7)),
      }),
      definePlugin({
        id: "number-consumer",
        inject: [StagedNumberTag],
        effect: () =>
          StagedNumberTag.pipe(
            Effect.flatMap((value) =>
              Effect.gen(function* () {
                seen.push(value);
                yield* Deferred.succeed(consumerStarted, undefined);
              }),
            ),
          ),
      }),
    ]);

    // Co-prepared injectors may activate on the candidate; host.get stays blind
    // until Publish commits the generation.
    expect(host.get(StagedNumberTag)).toEqual(Option.none());
    yield* Deferred.await(consumerStarted);
    expect(seen).toEqual([7]);
    expect(host.get(StagedNumberTag)).toEqual(Option.none());

    yield* host.publish;
    expect(host.get(StagedNumberTag)).toEqual(Option.some(7));
  }),
);

// --- Panel cleanup ---

testEffect("registered panels are disposed when the plugin is removed", () =>
  Effect.gen(function* () {
    const { host, slots, registryEntries } = yield* makeHost();
    const registry = registryProviding(registryEntries, SlotsTag);
    yield* host.add(registry);

    const plugin = mkPlugin({
      id: "panel-plugin",
      inject: [SlotsTag],
      effect: () =>
        Effect.gen(function* () {
          const slots = yield* SlotsTag;
          yield* slots.register({
            slot: "left.app",
            occupant: { id: "panel-plugin.test", size: () => 20, component: () => null as never },
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => void 0));
        }),
    });

    yield* host.add(plugin);
    expect(slots.declared("left", "app")).toBe(true);
    yield* host.remove(plugin.id);
    yield* host.remove(registry.id);

    expect(slots.declared("left", "app")).toBe(false);
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

testEffect(
  "replacing a layout-kind plugin updates the committed renderer; a failed candidate keeps it",
  () =>
    Effect.gen(function* () {
      const { host, layoutKinds, registryEntries } = yield* makeHost();
      yield* host.add(registryProviding(registryEntries, LayoutKindsTag));

      const stub = (label: string): LayoutKindRenderer => ({
        render: () => {
          throw new Error(`renderer ${label} is not drawn in this test`);
        },
      });
      const oldRenderer = stub("old");
      const newRenderer = stub("new");
      const failRenderer = stub("fail");

      yield* host.add(
        mkPlugin({
          id: "kind-plugin",
          inject: [LayoutKindsTag],
          effect: () =>
            Effect.gen(function* () {
              const kinds = yield* LayoutKindsTag;
              yield* kinds.register(["scroll", oldRenderer]);
            }),
        }),
      );
      expect(layoutKinds.renderer("scroll")).toBe(oldRenderer);

      yield* host.add(
        mkPlugin({
          id: "kind-plugin",
          inject: [LayoutKindsTag],
          effect: () =>
            Effect.gen(function* () {
              const kinds = yield* LayoutKindsTag;
              yield* kinds.register(["scroll", newRenderer]);
            }),
        }),
      );
      expect(layoutKinds.renderer("scroll")).toBe(newRenderer);

      const failed = mkPlugin({
        id: "kind-plugin",
        inject: [LayoutKindsTag],
        effect: () =>
          Effect.gen(function* () {
            const kinds = yield* LayoutKindsTag;
            yield* kinds.register(["scroll", failRenderer]);
            return yield* new PluginActivateError({ message: "candidate failed" });
          }),
      });
      expect(Exit.isFailure(yield* host.add(failed).pipe(Effect.exit))).toBe(true);
      expect(layoutKinds.renderer("scroll")).toBe(newRenderer);
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
            key: "<prefix>n",
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
    expect(
      yield* Effect.flip(
        host.add(
          mkPlugin({
            id: "provider-two",
            inject: [SpawnProvidersTag],
            effect: () =>
              SpawnProvidersTag.pipe(
                Effect.flatMap((providers) =>
                  providers.register(["test", () => ({ argv: ["two"] })]),
                ),
                Effect.asVoid,
              ),
          }),
        ),
      ),
    ).toBe("'test' is already registered by 'provider-one'");
    expect(host.spawnProvider("test")?.argv).toEqual(["one"]);
    yield* host.remove("provider-one");
    expect(host.spawnProvider("test")).toBeUndefined();
  }),
);

// --- Defect isolation ---

testEffect("a plugin effect that throws a defect reports the error without crashing the host", () =>
  Effect.gen(function* () {
    const { host, slots, registryEntries } = yield* makeHost();
    yield* host.add(registryProviding(registryEntries, SlotsTag));
    let registered = false;

    const errors = yield* Queue.unbounded<PluginErrorEvent>();
    const drain = yield* host.onError.pipe(
      Stream.runForEach((e) => Queue.offer(errors, e)),
      Effect.forkDetach,
    );
    yield* Effect.yieldNow;

    expect(
      yield* Effect.flip(
        host.add(
          mkPlugin({
            id: "crasher",
            inject: [SlotsTag],
            effect: () =>
              Effect.gen(function* () {
                const slots = yield* SlotsTag;
                yield* slots.register({
                  slot: "left.app",
                  occupant: {
                    id: "crasher.test",
                    size: () => 20,
                    component: () => null as never,
                  },
                });
                registered = true;
                return yield* Effect.sync(() => {
                  throw new Error("boom from plugin");
                });
              }),
          }),
        ),
      ),
    ).toBe("boom from plugin");
    yield* Effect.yieldNow;

    const reported = yield* Queue.takeAll(errors);
    yield* Fiber.interrupt(drain);

    const crash = reported.find((e) => e.pluginId === "crasher");
    expect(crash).toBeDefined();
    expect(crash!.source).toBe("plugin");
    expect(crash!.phase).toBe("activate");
    expect(crash!.error.message).toBe("boom from plugin");
    expect(registered).toBe(true);
    expect(slots.declared("left", "app")).toBe(false);

    yield* host.add(mkPlugin({ id: "survivor" }));
    expect(host.status().filter((status) => status.id === "survivor")).toEqual([
      { id: "survivor", phase: "active", waitingFor: [] },
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
    expect(
      yield* Effect.flip(
        host.add(
          mkPlugin({
            id: "broken",
            effect: () =>
              Effect.sync(() => {
                throw new Error("no");
              }),
          }),
        ),
      ),
    ).toBe("no");
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
    const { host, slots, registryEntries } = yield* makeHost();
    yield* host.add(registryProviding(registryEntries, SlotsTag));
    const plugin = mkPlugin({
      id: "runtime",
      inject: [SlotsTag],
      effect: () =>
        Effect.gen(function* () {
          const slots = yield* SlotsTag;
          yield* slots.register({
            slot: "bottom.app",
            occupant: {
              id: "runtime.panel",
              size: () => 1,
              component: () => null as never,
            },
          });
        }),
    });

    yield* host.add(plugin);
    expect(slots.declared("bottom", "app")).toBe(true);
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

    expect(
      yield* Effect.flip(
        host.add(
          mkPlugin({
            id: "defected",
            effect: () =>
              Effect.sync(() => {
                throw new Error("boom");
              }),
          }),
        ),
      ),
    ).toBe("boom");

    // Re-add must succeed — the defect cleaned up state and scope
    yield* host.add(mkPlugin({ id: "defected" }));
    expect(host.status().length).toBe(1);
    expect(host.status()[0]!.id).toBe("defected");
  }),
);

testEffect("defect closes the plugin scope and runs registered finalizers", () =>
  Effect.gen(function* () {
    const { host, registryEntries } = yield* makeHost();
    yield* host.add(registryProviding(registryEntries, SlotsTag));

    expect(
      yield* Effect.flip(
        host.add(
          mkPlugin({
            id: "finalize",
            inject: [SlotsTag],
            effect: () =>
              Effect.gen(function* () {
                const slots = yield* SlotsTag;
                yield* slots.register({
                  slot: "left.app",
                  occupant: { id: "finalize.test", size: () => 20, component: () => null as never },
                });
                yield* Effect.addFinalizer(() => Effect.void);
                throw new Error("defect after registration");
              }),
          }),
        ),
      ),
    ).toBe("defect after registration");

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

    yield* Effect.gen(function* () {
      host = (yield* makeHost()).host;
      yield* host.add(mkPlugin({ id: "scoped" }));
      expect(host.status().length).toBe(1);
    }).pipe(Effect.scoped);

    expect(host.status()).toEqual([]);
    yield* host.dispose;
    expect(host.status()).toEqual([]);
  }),
);
