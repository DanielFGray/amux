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

const testDir = fileURLToPath(new URL(".", import.meta.url));

declare global {
  var AMUX_RELOAD_TEST: string[] | undefined;
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

testEffect("a version that will not start gives way to the one that did", () =>
  Effect.gen(function* () {
    const world = yield* start("crash", version("crash", 1));

    yield* Effect.promise(() =>
      writeFile(
        world.entry,
        `import { Effect } from "effect";
         export default { id: "crash", apiVersion: "1",
           effect: () => Effect.sync(() => { throw new Error("bad edit"); }) };`,
      ),
    );
    const failure = yield* Effect.either(world.reloader.reload("crash"));

    expect(failure._tag === "Left" && failure.left).toContain("kept the version that was running");
    // Back on the version that worked, which had to run its effect again to say so.
    expect(world.activations()).toEqual(["1", "1"]);
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
}

/** A host running one plugin from a scratch directory. */
const start = (
  id: string,
  source: string,
  extra: Record<string, string> = {},
): Effect.Effect<World, never, Scope.Scope> =>
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
    const host = yield* createPluginHost(testPluginEnvironment(renderer.renderer));

    const definition = yield* hotImport(pathToFileURL(entry)).pipe(Effect.orDie);
    yield* host.add(definition);

    return {
      host,
      entry,
      directory,
      reloader: createReloader(host, [{ id, source: pathToFileURL(entry), definition }]),
      activations: () => globalThis.AMUX_RELOAD_TEST ?? [],
    };
  });
