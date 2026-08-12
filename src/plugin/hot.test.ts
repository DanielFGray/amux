import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import { hotImport, pluginRoot } from "./hot.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("a plugin's reloadable half is the directory named after its entry", () => {
  expect(pluginRoot(new URL("file:///a/b/agent-harness.tsx"))).toBe("/a/b/agent-harness/");
  expect(pluginRoot(new URL("file:///a/b/sidebar.ts"))).toBe("/a/b/sidebar/");
});

test("importing again picks up an edit inside the plugin's own directory", async () => {
  const dir = await scratch();
  await Bun.write(join(dir, "colours/palette.ts"), `export const accent = "red";`);
  await writeFile(
    join(dir, "colours.ts"),
    `import { Effect } from "effect";
     import { accent } from "./colours/palette.ts";
     export default { id: accent, apiVersion: "1", effect: () => Effect.void };`,
  );
  const source = pathToFileURL(join(dir, "colours.ts"));

  const before = await Effect.runPromise(hotImport(source));
  await Bun.write(join(dir, "colours/palette.ts"), `export const accent = "blue";`);
  const after = await Effect.runPromise(hotImport(source));

  expect(before.id).toBe("red");
  expect(after.id).toBe("blue");
});

/**
 * The guarantee that breaks silently if the resolver's boundary is wrong.
 *
 * A module the host and the plugin share must stay one module: a second copy of
 * something holding a registry or a signal would leave the plugin talking to a
 * world nobody else can see. The fixture names itself after a value the shared
 * module computes once, so a duplicate would be visible as a different name.
 */
test("a module outside the plugin's directory is the same instance after a reload", async () => {
  const dir = await scratch();
  await writeFile(join(dir, "shared.ts"), `export const once = "load-" + Math.random();`);
  await writeFile(
    join(dir, "reader.ts"),
    `import { Effect } from "effect";
     import { once } from "./shared.ts";
     export default { id: once, apiVersion: "1", effect: () => Effect.void };`,
  );
  const source = pathToFileURL(join(dir, "reader.ts"));

  const first = await Effect.runPromise(hotImport(source));
  const second = await Effect.runPromise(hotImport(source));

  expect(first).not.toBe(second);
  expect(first.id).toBe(second.id);
});

test("a module that is not a plugin is refused with the reason", async () => {
  const dir = await scratch();
  await writeFile(join(dir, "nope.ts"), `export default { id: "nope" };`);

  const failure = await Effect.runPromise(
    Effect.either(hotImport(pathToFileURL(join(dir, "nope.ts")))),
  );
  expect(failure._tag).toBe("Left");
  expect(failure._tag === "Left" && failure.left).toContain("apiVersion");
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(testDir, ".test-hot-"));
  temporary.push(dir);
  return dir;
}
