import { afterEach, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Fiber, Scope } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import { createPluginHost, type PluginHost } from "./host.ts";
import { createReloader, type PluginReloader } from "./reloader.ts";
import { testPluginEnvironment } from "./test-environment.ts";
import { hotImport } from "./hot.ts";
import { testEffect } from "../test-effect.ts";
import { waitFor } from "../test-wait.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

declare global {
  var AMUX_RELOAD_TEST: string[] | undefined;
  var AMUX_RELOAD_GATE: Promise<void> | undefined;
}

const temporary: string[] = [];
const cleanupFns: (() => void)[] = [];
afterEach(async () => {
  for (const fn of cleanupFns.splice(0)) fn();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

testEffect("a reload runs the edited source in place of the running one", () =>
  Effect.gen(function* () {
    const world = yield* start("swap", version("swap", 1));

    yield* Effect.promise(() => writeFile(world.entry, version("swap", 2)));
    yield* world.reloader.reload("swap");

    expect(world.activations()).toEqual(["1", "2"]);
    expect(world.host.status().map((status) => status.id)).toEqual(["swap"]);
  }),
);

testEffect("reload replaces UI scope without touching external agent work", () =>
  Effect.gen(function* () {
    const world = yield* start("survives", version("survives", 1));
    const work = yield* Effect.forkDaemon(Effect.never);

    yield* Effect.promise(() => writeFile(world.entry, version("survives", 2)));
    yield* world.reloader.reload("survives");

    expect(world.activations()).toEqual(["1", "2"]);
    expect(["Running", "Suspended"]).toContain((yield* Fiber.status(work))._tag);
    yield* Fiber.interrupt(work);
  }),
);

testEffect("a change inside the plugin's directory is part of the reload", () =>
  Effect.gen(function* () {
    const world = yield* start(
      "inner",
      `import { Effect } from "effect";
       import { mark } from "./inner/mark.ts";
       export default { id: "inner", apiVersion: "1",
         effect: () => Effect.sync(() => { (globalThis.AMUX_RELOAD_TEST ??= []).push(mark); }) };`,
      { "inner/mark.ts": `export const mark = "1";` },
    );

    yield* Effect.promise(() =>
      Bun.write(join(world.directory, "inner/mark.ts"), `export const mark = "2";`),
    );
    yield* world.reloader.reload("inner");

    expect(world.activations()).toEqual(["1", "2"]);
  }),
);

testEffect("a source that will not import leaves the running version alone", () =>
  Effect.gen(function* () {
    const world = yield* start("broken", version("broken", 1));

    yield* Effect.promise(() => writeFile(world.entry, `this is not typescript ===`));
    const failure = yield* Effect.either(world.reloader.reload("broken"));

    expect(failure._tag).toBe("Left");
    expect(world.activations()).toEqual(["1"]);
    expect(world.host.status().map((status) => status.id)).toEqual(["broken"]);
  }),
);

testEffect("a failed candidate never becomes visible", () =>
  Effect.gen(function* () {
    const world = yield* start(
      "crash",
      `import { Effect } from "effect";
       import { RegionsTag } from "${pathToFileURL(join(testDir, "services.ts")).href}";
       export default { id: "crash", apiVersion: "1",
         inject: [RegionsTag], effect: () => Effect.gen(function* () {
           const regions = yield* RegionsTag;
           yield* regions.register({ id: "crash.panel", region: "left", anchor: "app",
              size: () => 1, component: () => null as never });
           (globalThis.AMUX_RELOAD_TEST ??= []).push("1");
         }) };`,
    );
    expect(world.panelVisible()).toBe(true);

    yield* Effect.promise(() =>
      writeFile(
        world.entry,
        `import { Effect } from "effect";
         import { RegionsTag } from "${pathToFileURL(join(testDir, "services.ts")).href}";
         export default { id: "crash", apiVersion: "1",
             inject: [RegionsTag], effect: () => Effect.gen(function* () {
               const regions = yield* RegionsTag;
               yield* regions.register({ id: "crash.panel", region: "left", anchor: "app",
                 size: () => 2, component: () => null as never });
              (globalThis.AMUX_RELOAD_TEST ??= []).push("candidate registered");
              yield* Effect.promise(() => globalThis.AMUX_RELOAD_GATE!);
              throw new Error("bad edit");
            }) };`,
      ),
    );
    let release!: () => void;
    globalThis.AMUX_RELOAD_GATE = new Promise((resolve) => {
      release = resolve;
    });
    const reloading = yield* Effect.forkDaemon(world.reloader.reload("crash"));
    yield* Effect.promise(() =>
      waitFor(() => world.activations().includes("candidate registered"), "candidate registration"),
    );

    // The candidate registered a larger panel but has not reached started, so
    // the committed generation remains the panel the layout can read.
    expect(world.panelThickness()).toBe(1);
    release();
    const failure = yield* Effect.either(Fiber.join(reloading));

    expect(failure._tag === "Left" && failure.left).toContain("kept the version that was running");
    // The version that worked stayed running while the candidate was closed.
    expect(world.activations()).toEqual(["1", "candidate registered"]);
    expect(world.panelVisible()).toBe(true);
    expect(world.host.status().map((status) => status.id)).toEqual(["crash"]);
  }),
);

testEffect("a plugin amux cannot see is not reloadable", () =>
  Effect.gen(function* () {
    const world = yield* start("named", version("named", 1));

    expect(world.reloader.reloadable()).toEqual(["named"]);
    const failure = yield* Effect.either(world.reloader.reload("someone-else"));
    expect(failure._tag === "Left" && failure.left).toContain("no reloadable plugin");
  }),
);

/** A plugin that says, every time it starts, which generation of itself it is. */
const version = (id: string, generation: number) =>
  `import { Effect } from "effect";
   export default { id: "${id}", apiVersion: "1",
     effect: () => Effect.sync(() => { (globalThis.AMUX_RELOAD_TEST ??= []).push("${generation}"); }) };`;

interface World {
  readonly host: PluginHost;
  readonly reloader: PluginReloader;
  readonly entry: string;
  readonly directory: string;
  readonly activations: () => readonly string[];
  readonly panelVisible: () => boolean;
  readonly panelThickness: () => number;
}

/** A host running one plugin from a scratch directory. */
const start = (
  id: string,
  source: string,
  extra: Record<string, string> = {},
): Effect.Effect<World, string, Scope.Scope> =>
  Effect.gen(function* () {
    globalThis.AMUX_RELOAD_TEST = [];
    const directory = yield* Effect.promise(() => mkdtemp(join(testDir, ".test-reload-")));
    temporary.push(directory);
    const entry = join(directory, `${id}.ts`);
    yield* Effect.promise(() => writeFile(entry, source));
    for (const [name, contents] of Object.entries(extra)) {
      yield* Effect.promise(() => Bun.write(join(directory, name), contents));
    }

    const renderer = yield* Effect.promise(() => createTestRenderer({ width: 80, height: 24 }));
    cleanupFns.push(() => renderer.renderer.destroy());
    const environment = testPluginEnvironment(renderer.renderer);
    const host = yield* createPluginHost(environment);

    const definition = yield* hotImport(pathToFileURL(entry)).pipe(Effect.orDie);
    yield* host.add(definition);

    return {
      host,
      entry,
      directory,
      reloader: createReloader(host, [{ id, source: pathToFileURL(entry), definition }]),
      activations: () => globalThis.AMUX_RELOAD_TEST ?? [],
      panelVisible: () => environment.registries.regions.declared("left", "app"),
      panelThickness: () => environment.registries.regions.thickness("left", "app"),
    };
  });
