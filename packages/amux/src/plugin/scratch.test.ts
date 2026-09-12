/** @effect-diagnostics *:skip-file -- exercises Bun's real dynamic import and file-write timing for scratch eval; same seam as reloader.test.ts. */
import { afterEach, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Scope } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import { createPluginHost, type PluginHost } from "./host.ts";
import { createReloader, type PluginReloader } from "./reloader.ts";
import { evalScratch, managedPluginEntryPath, promoteScratch, sendSelectionScratchSource, sendTopBufferToPane } from "./scratch.ts";
import { loadPluginsFromConfig } from "./loader.ts";
import { DEFAULT_CONFIG, loadConfig, type Config } from "../config.ts";
import { testPluginEnvironment } from "./test-environment.ts";
import { testEffect } from "../test-effect.ts";
import { CommandsTag, type CommandRegistration } from "./services.ts";
import { commandInvocation, CurrentInvocation, makeCommands } from "../commands.ts";
import * as FileSystem from "effect/FileSystem";

const testDir = fileURLToPath(new URL(".", import.meta.url));

declare global {
  var AMUX_SCRATCH_TEST: string[] | undefined;
}

const temporary: string[] = [];
const cleanupFns: (() => void)[] = [];
afterEach(async () => {
  for (const fn of cleanupFns.splice(0)) fn();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const pluginStatuses = (host: PluginHost) =>
  host.status().filter((status) => !status.id.startsWith("amux.registry."));

/** A scratch plugin that registers one command and marks its generation. */
const scratchSource = (id: string, generation: string, verb = "send-selection") =>
  `import { Effect, Schema as S } from "effect";
   import { definePlugin, CommandsTag, registerCommand } from "amux";
   export default definePlugin({
     id: "${id}",
     inject: [CommandsTag],
     effect: () => Effect.gen(function* () {
       (globalThis.AMUX_SCRATCH_TEST ??= []).push("${generation}");
       yield* registerCommand(
         "${verb}",
         { text: S.optional(S.String) },
         { desc: "spike: send selection to review", group: "scratch", target: "server", exposure: "human" },
         (args) => Effect.sync(() => {
           (globalThis.AMUX_SCRATCH_TEST ??= []).push("run:${generation}:" + (args.text ?? ""));
         }),
       );
     }),
   });`;

interface World {
  readonly host: PluginHost;
  readonly reloader: PluginReloader;
  readonly scratchDir: string;
  readonly commands: Map<string, CommandRegistration>;
  readonly activations: () => readonly string[];
}

const start = (): Effect.Effect<World, string, Scope.Scope> =>
  Effect.gen(function* () {
    globalThis.AMUX_SCRATCH_TEST = [];
    const scratchDir = yield* Effect.promise(() => mkdtemp(join(testDir, ".test-scratch-")));
    temporary.push(scratchDir);

    const renderer = yield* Effect.promise(() => createTestRenderer({ width: 80, height: 24 }));
    cleanupFns.push(() => renderer.renderer.destroy());

    const commands = new Map<string, CommandRegistration>();
    const environment = testPluginEnvironment(renderer.renderer, {
      registries: {
        commands: (_owner, registration) => {
          commands.set(registration.verb, registration);
          return () => {
            if (commands.get(registration.verb) === registration) commands.delete(registration.verb);
          };
        },
      },
    });
    const host = yield* createPluginHost(environment);
    const commandsRegistry = environment.registryEntries.find((entry) =>
      entry.provide?.some((tag) => tag.key === CommandsTag.key),
    );
    if (!commandsRegistry) return yield* Effect.fail("missing commands registry provider");
    yield* host.add(commandsRegistry);

    return {
      host,
      scratchDir,
      commands,
      reloader: createReloader(host, []),
      activations: () => globalThis.AMUX_SCRATCH_TEST ?? [],
    };
  });

const evalIn = (world: World, id: string, source: string) =>
  evalScratch(world.reloader, id, source, world.scratchDir).pipe(Effect.provide(BunFileSystem.layer));

testEffect("scratch eval adopts a plugin and registers its command", () =>
  Effect.gen(function* () {
    const world = yield* start();
    yield* evalIn(world, "live.review", scratchSource("live.review", "1"));

    expect(pluginStatuses(world.host).map((status) => status.id)).toEqual(["live.review"]);
    expect(world.reloader.reloadable()).toEqual(["live.review"]);
    expect(world.commands.has("send-selection")).toBe(true);
    expect(world.activations()).toEqual(["1"]);

    yield* world.commands.get("send-selection")!.handler({ text: "yanked line" });
    expect(world.activations()).toEqual(["1", "run:1:yanked line"]);
  }),
);

testEffect("revising scratch source and re-eval reloads in place", () =>
  Effect.gen(function* () {
    const world = yield* start();
    yield* evalIn(world, "live.review", scratchSource("live.review", "1"));
    yield* evalIn(world, "live.review", scratchSource("live.review", "2"));

    expect(world.activations()).toEqual(["1", "2"]);
    expect(world.commands.has("send-selection")).toBe(true);
    yield* world.commands.get("send-selection")!.handler({ text: "next" });
    expect(world.activations()).toEqual(["1", "2", "run:2:next"]);
  }),
);

testEffect("a broken scratch eval leaves the last good command standing", () =>
  Effect.gen(function* () {
    const world = yield* start();
    yield* evalIn(world, "live.review", scratchSource("live.review", "1"));

    const failure = yield* Effect.result(
      evalIn(world, "live.review", `this is not typescript ===`),
    );

    expect(failure._tag).toBe("Failure");
    expect(failure._tag === "Failure" && failure.failure).toContain(
      "last good generation of 'live.review' kept running",
    );
    expect(world.activations()).toEqual(["1"]);
    expect(pluginStatuses(world.host).map((status) => status.id)).toEqual(["live.review"]);
    expect(world.commands.has("send-selection")).toBe(true);
    yield* world.commands.get("send-selection")!.handler({ text: "still" });
    expect(world.activations()).toEqual(["1", "run:1:still"]);
  }),
);

testEffect("scratch id must match the definePlugin id", () =>
  Effect.gen(function* () {
    const world = yield* start();
    const failure = yield* Effect.result(
      evalIn(world, "live.review", scratchSource("other.id", "1")),
    );
    expect(failure._tag).toBe("Failure");
    expect(pluginStatuses(world.host)).toEqual([]);
  }),
);

testEffect("send-selection template evals and registers the demo verb", () =>
  Effect.gen(function* () {
    const world = yield* start();
    yield* evalIn(world, "live.review", sendSelectionScratchSource("live.review", "pane-1"));

    expect(pluginStatuses(world.host).map((status) => status.id)).toEqual(["live.review"]);
    expect(world.commands.has("send-selection")).toBe(true);
  }),
);

testEffect("sendTopBufferToPane selects the pane then pastes the top buffer", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const commands = makeCommands({
      "pane.select": (value: { readonly _tag: string; readonly pane?: string }) =>
        Effect.sync(() => {
          calls.push(`select:${value.pane ?? ""}`);
        }),
      "buffer.paste": () =>
        Effect.sync(() => {
          calls.push("paste");
        }),
    });
    yield* sendTopBufferToPane(commands.run, "review").pipe(
      Effect.provideService(CurrentInvocation, commandInvocation("key")),
    );
    expect(calls).toEqual(["select:review", "paste"]);
  }),
);

testEffect("sendTopBufferToPane pastes into the focused pane when none is named", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const commands = makeCommands({
      "buffer.paste": () =>
        Effect.sync(() => {
          calls.push("paste");
        }),
    });
    yield* sendTopBufferToPane(commands.run).pipe(
      Effect.provideService(CurrentInvocation, commandInvocation("key")),
    );
    expect(calls).toEqual(["paste"]);
  }),
);

testEffect("promoteScratch writes managed path + config so a fresh load picks it up", () =>
  Effect.gen(function* () {
    const world = yield* start();
    const id = "live.promote";
    yield* evalIn(world, id, scratchSource(id, "g1"));

    const configDir = yield* Effect.promise(() => mkdtemp(join(testDir, ".test-promote-cfg-")));
    temporary.push(configDir);
    const configPath = join(configDir, "config.json");
    const empty: Config = { ...DEFAULT_CONFIG, plugins: [] };

    const promoted = yield* promoteScratch(world.reloader, id, {
      config: empty,
      configDir,
      configPath,
    }).pipe(Effect.provide(BunFileSystem.layer));

    expect(promoted.path).toBe("plugins/live.promote.ts");
    expect(promoted.config.plugins).toEqual([{ path: "plugins/live.promote.ts", enabled: true }]);

    const onDisk = yield* loadConfig(configPath).pipe(Effect.provide(BunFileSystem.layer));
    expect(onDisk.plugins).toEqual([{ path: "plugins/live.promote.ts", enabled: true }]);

    // Fresh host + ordinary config loader — no scratch path, no special case.
    const renderer = yield* Effect.promise(() => createTestRenderer({ width: 80, height: 24 }));
    cleanupFns.push(() => renderer.renderer.destroy());
    const environment = testPluginEnvironment(renderer.renderer, {
      registries: {
        commands: () => () => undefined,
      },
    });
    const freshHost = yield* createPluginHost(environment);
    const commandsRegistry = environment.registryEntries.find((entry) =>
      entry.provide?.some((tag) => tag.key === CommandsTag.key),
    );
    if (!commandsRegistry) return yield* Effect.fail("missing commands registry");
    yield* freshHost.add(commandsRegistry);

    const loaded = yield* loadPluginsFromConfig(onDisk, freshHost, configDir, [
      ...environment.registryEntries,
    ]);
    expect(loaded.entries.some((entry) => entry.id === id)).toBe(true);
    expect(
      freshHost.status().some((status) => status.id === id && status.phase === "active"),
    ).toBe(true);
  }),
);

testEffect("after promote, reload reads the managed path not scratch", () =>
  Effect.gen(function* () {
    const world = yield* start();
    const id = "live.retarget";
    yield* evalIn(world, id, scratchSource(id, "scratch-g1"));
    const scratchPath = fileURLToPath(world.reloader.get(id)!.source);

    const configDir = yield* Effect.promise(() => mkdtemp(join(testDir, ".test-retarget-cfg-")));
    temporary.push(configDir);
    const configPath = join(configDir, "config.json");
    const managed = managedPluginEntryPath(id, configDir);

    yield* promoteScratch(world.reloader, id, {
      config: { ...DEFAULT_CONFIG, plugins: [] },
      configDir,
      configPath,
    }).pipe(Effect.provide(BunFileSystem.layer));

    const tracked = world.reloader.get(id)!;
    expect(fileURLToPath(tracked.source)).toBe(managed);
    expect(fileURLToPath(tracked.source)).not.toBe(scratchPath);
    expect(fileURLToPath(tracked.source).includes(world.scratchDir)).toBe(false);

    // Leave scratch stale; only the managed file advances — reload must see it.
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(managed, scratchSource(id, "managed-g2"));
    yield* world.reloader.reload(id, { disk: true });
    expect(world.activations()).toContain("managed-g2");
    expect(fileURLToPath(world.reloader.get(id)!.source)).toBe(managed);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);
