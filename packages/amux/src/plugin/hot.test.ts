import { afterEach, expect, test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Path } from "effect";
import * as Graph from "effect/Graph";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { hotImport, hotModuleClosure, importGraph, pluginRoot } from "./hot.ts";
import { hotImportBatch } from "./hot.ts";
import { createPluginHost } from "./host.ts";
import { testPluginEnvironment } from "./test-environment.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { dependencyService } from "./services.ts";
import { testEffect } from "../test-effect.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const path = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

const temporary: string[] = [];
declare global {
  var AMUX_HOT_BATCH_VALUES: object[] | undefined;
}
afterEach(() => {
  const paths = temporary.splice(0);
  return Effect.runPromise(
    Effect.forEach(paths, (path) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(path, { recursive: true })).pipe(
        Effect.ignore,
      ),
    ).pipe(Effect.provide(BunFileSystem.layer)),
  );
});

test("a plugin's reloadable half is the directory named after its entry", () => {
  expect(pluginRoot(new URL("file:///a/b/agent-harness.tsx"))).toBe("/a/b/agent-harness/");
  expect(pluginRoot(new URL("file:///a/b/sidebar.ts"))).toBe("/a/b/sidebar/");
});

testEffect("an external plugin resolves the host's public API without node_modules", () =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const entry = path.join(dir, "outside.ts");
    yield* write(
      entry,
      `import { Effect } from "effect";
       import { definePlugin } from "amux";
       export default definePlugin({ id: "external-api", effect: () => Effect.void });`,
    );

    const source = pathToFileURL(entry);
    expect((yield* hotImport(source)).id).toBe("external-api");
    expect(hotModuleClosure([source]).map((module) => module.href)).toEqual([source.href]);
  }),
);

testEffect("importing again picks up an edit inside the plugin's own directory", () =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    yield* write(path.join(dir, "colours/palette.ts"), `export const accent = "red";`);
    yield* write(
      path.join(dir, "colours.ts"),
      `import { Effect } from "effect";
     import { definePlugin } from "../types.ts";
     import { accent } from "./colours/palette.ts";
      export default definePlugin({ id: accent, effect: () => Effect.void });`,
    );
    const source = pathToFileURL(path.join(dir, "colours.ts"));

    const before = yield* hotImport(source);
    yield* write(path.join(dir, "colours/palette.ts"), `export const accent = "blue";`);
    const after = yield* hotImport(source);

    expect(before.id).toBe("red");
    expect(after.id).toBe("blue");
  }),
);

/**
 * The guarantee that breaks silently if the resolver's boundary is wrong.
 *
 * A module the host and the plugin share must stay one module: a second copy of
 * something holding a registry or a signal would leave the plugin talking to a
 * world nobody else can see. The fixture names itself after a value the shared
 * module computes once, so a duplicate would be visible as a different name.
 */
testEffect("a module outside the plugin's directory is the same instance after a reload", () =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    yield* write(path.join(dir, "shared.ts"), `export const once = "load-" + Math.random();`);
    yield* write(
      path.join(dir, "reader.ts"),
      `import { Effect } from "effect";
     import { definePlugin } from "../types.ts";
     import { once } from "./shared.ts";
      export default definePlugin({ id: once, effect: () => Effect.void });`,
    );
    const source = pathToFileURL(path.join(dir, "reader.ts"));

    const first = yield* hotImport(source);
    const second = yield* hotImport(source);

    expect(first).not.toBe(second);
    expect(first.id).toBe(second.id);
  }),
);

testEffect("one batch generation gives every consumer one fresh shared module instance", () =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    yield* write(path.join(dir, "shared.ts"), `export const value = {};`);
    for (const id of ["one", "two"]) {
      yield* write(
        path.join(dir, `${id}/index.ts`),
        `import { Effect } from "effect";
         import { definePlugin } from "../../types.ts";
         import { value } from "../shared.ts";
         export default definePlugin({ id: "${id}", effect: () => Effect.sync(() => {
           (globalThis.AMUX_HOT_BATCH_VALUES ??= []).push(value);
         }) });`,
      );
    }
    const renderer = yield* Effect.promise(() => createTestRenderer({ width: 80, height: 24 }));
    yield* Effect.addFinalizer(() => Effect.sync(() => renderer.renderer.destroy()));
    const host = yield* createPluginHost(testPluginEnvironment(renderer.renderer));
    globalThis.AMUX_HOT_BATCH_VALUES = [];
    const definitions = yield* hotImportBatch(
      ["one", "two"].map((id) => pathToFileURL(path.join(dir, `${id}/index.ts`))),
      [pathToFileURL(path.join(dir, "shared.ts"))],
    );
    yield* Effect.forEach(definitions, (definition) => host.add(definition));

    expect(globalThis.AMUX_HOT_BATCH_VALUES).toHaveLength(2);
    expect(globalThis.AMUX_HOT_BATCH_VALUES![0]).toBe(globalThis.AMUX_HOT_BATCH_VALUES![1]);
  }),
);

testEffect("a changed shared workspace module identifies every dependent plugin", () =>
  Effect.gen(function* () {
    yield* hotImport(pathToFileURL(path.join(testDir, "../../../plugin-sidebar/src/index.tsx")));
    const harnessDir = yield* FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) =>
        fs.makeTempDirectory({
          directory: path.join(testDir, "../../../plugin-agent-harness/src"),
          prefix: ".test-hot-",
        }),
      ),
      Effect.provide(BunFileSystem.layer),
    );
    temporary.push(harnessDir);
    yield* write(
      path.join(harnessDir, "index.ts"),
      `import { Effect } from "effect";
       import { AgentAwarenessTag } from "@danielfgray/amux-agent-awareness/presence.ts";
       import { definePlugin } from "@danielfgray/amux";
       export default definePlugin({ id: AgentAwarenessTag.key ? "harness" : "missing",
         effect: () => Effect.void });`,
    );
    yield* hotImport(pathToFileURL(path.join(harnessDir, "index.ts")));

    const snapshot = Graph.toSnapshot(importGraph());
    const urls = new Map(snapshot.nodes.map(({ index, data }) => [index, data]));
    const imports = (target: string) =>
      snapshot.edges
        .filter(({ target: edgeTarget }) => urls.get(edgeTarget) === target)
        .map(({ source }) => urls.get(source));
    const sidebar = pathToFileURL(path.join(testDir, "../../../plugin-sidebar/src/index.tsx")).href;
    const harness = pathToFileURL(path.join(harnessDir, "index.ts")).href;

    const changed = pathToFileURL(
      path.join(testDir, "../../../agent-awareness/src/presence.ts"),
    ).href;
    expect(imports(changed)).toContain(sidebar);
    expect(imports(changed)).toContain(harness);
  }),
);

/**
 * The decode schema drops every property it does not name, so a plugin field
 * the schema forgets is read off disk and thrown away — and the plugin then
 * runs without it, which for `inject` means starting before its services
 * exist. Nothing else catches that: the plugin still loads and still works in
 * memory, where the definition never goes through the schema at all.
 */
testEffect("an intercepted dependency survives the trip through the decoder", () =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    yield* write(
      path.join(dir, "needs.ts"),
      `import { Context, Effect } from "effect";
     import { definePlugin } from "../types.ts";
     import { intercept } from "../services.ts";
     class Pool extends Context.Service<Pool, number>()("test/Pool") {}
     Object.assign(Pool, { interception: {
       empty: {}, combine: (left, right) => ({ ...left, ...right }),
       access: (service) => service,
     }});
      export default definePlugin({ id: "needs",
       inject: [intercept(Pool, { access: "read" })],
       effect: () => Effect.void });`,
    );

    const definition = yield* hotImport(pathToFileURL(path.join(dir, "needs.ts")));

    expect(definition.inject?.map((dependency) => dependencyService(dependency).key)).toEqual([
      "test/Pool",
    ]);
    expect(definition.inject?.[0]).toMatchObject({ metadata: { access: "read" } });
  }),
);

testEffect("a module that is not a plugin is refused with the reason", () =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    yield* write(path.join(dir, "nope.ts"), `export default { id: "nope" };`);

    const failure = yield* Effect.result(hotImport(pathToFileURL(path.join(dir, "nope.ts"))));
    expect(failure._tag).toBe("Failure");
    expect(failure._tag === "Failure" && failure.failure).toContain("activate");
  }),
);

/** A fixture directory under the plugin tree, removed after the test. It has to
 *  live beside the real plugins: the resolver's boundary is a directory. */
const scratch = Effect.gen(function* () {
  const dir = yield* FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectory({ directory: testDir, prefix: ".test-hot-" })),
  );
  temporary.push(dir);
  return dir;
}).pipe(Effect.provide(BunFileSystem.layer));

/** `Bun.write` creates missing parent directories; `writeFile` does not. The
 *  fixtures rely on that for nested files, so both go through Bun's writer. */
const write = (path: string, contents: string) => Effect.promise(() => Bun.write(path, contents));
