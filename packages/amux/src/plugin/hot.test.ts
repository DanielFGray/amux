import { afterEach, expect, test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Path } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { hotImport, pluginRoot } from "./hot.ts";
import { dependencyService } from "./services.ts";
import { testEffect } from "../test-effect.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const path = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

const temporary: string[] = [];
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

testEffect("importing again picks up an edit inside the plugin's own directory", () =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    yield* write(path.join(dir, "colours/palette.ts"), `export const accent = "red";`);
    yield* write(
      path.join(dir, "colours.ts"),
      `import { Effect } from "effect";
     import { definePlugin } from "../types.ts";
     import { accent } from "./colours/palette.ts";
     export default definePlugin({ id: accent, apiVersion: "1", effect: () => Effect.void });`,
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
     export default definePlugin({ id: once, apiVersion: "1", effect: () => Effect.void });`,
    );
    const source = pathToFileURL(path.join(dir, "reader.ts"));

    const first = yield* hotImport(source);
    const second = yield* hotImport(source);

    expect(first).not.toBe(second);
    expect(first.id).toBe(second.id);
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
     export default definePlugin({ id: "needs", apiVersion: "1",
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
    expect(failure._tag === "Failure" && failure.failure).toContain("apiVersion");
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
