import { expect } from "bun:test";
import { Effect, Layer, Path } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { fileURLToPath } from "node:url";
import { decodeConfig } from "../config.ts";
import { JsonValueSchema } from "../effect/AttachProtocol.ts";
import { Schema as S } from "effect";
import { runPluginCli } from "./plugin-cli.ts";
import { testEffect } from "../test-effect.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

const layers = Layer.mergeAll(BunFileSystem.layer, Path.layer);

const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    directory: testDir,
    prefix: ".test-plugin-cli-",
  });
  return { root, configPath: path.join(root, "config.json"), storeDir: path.join(root, "store") };
});

const configuredPlugins = Effect.fnUntraced(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  if (!text) return [];
  const parsed = yield* S.decodeEffect(S.fromJsonString(JsonValueSchema))(text);
  return decodeConfig(parsed).plugins;
});

const cli = (argv: readonly string[], configPath: string, storeDir: string) =>
  Effect.promise(() => runPluginCli(argv, configPath, storeDir));

testEffect("bare plugin prints help", () =>
  Effect.gen(function* () {
    const { configPath, storeDir } = yield* world;
    expect(yield* cli([], configPath, storeDir)).toBe(0);
  }).pipe(Effect.provide(layers)),
);

testEffect("unknown verbs and missing args are usage errors", () =>
  Effect.gen(function* () {
    const { configPath, storeDir } = yield* world;
    expect(yield* cli(["frobnicate", "x"], configPath, storeDir)).toBe(2);
    expect(yield* cli(["add"], configPath, storeDir)).toBe(2);
    expect(yield* cli(["add", "a", "b"], configPath, storeDir)).toBe(2);
    expect(yield* cli(["rm"], configPath, storeDir)).toBe(2);
    expect(yield* cli(["ls", "extra"], configPath, storeDir)).toBe(2);
    expect(yield* cli(["upgrade"], configPath, storeDir)).toBe(2);
  }).pipe(Effect.provide(layers)),
);

testEffect("ls on an empty world succeeds", () =>
  Effect.gen(function* () {
    const { configPath, storeDir } = yield* world;
    expect(yield* cli(["ls"], configPath, storeDir)).toBe(0);
  }).pipe(Effect.provide(layers)),
);

testEffect("add accepts a local path and rm drops it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { root, configPath, storeDir } = yield* world;
    const plugin = path.join(root, "my-plugin.ts");
    yield* fs.writeFileString(plugin, `export default { id: "mine" };\n`);

    expect(yield* cli(["add", plugin], configPath, storeDir)).toBe(0);
    expect(yield* configuredPlugins(configPath)).toEqual([{ path: plugin, enabled: true }]);

    expect(yield* cli(["ls"], configPath, storeDir)).toBe(0);

    expect(yield* cli(["rm", plugin], configPath, storeDir)).toBe(0);
    expect(yield* configuredPlugins(configPath)).toEqual([]);
  }).pipe(Effect.provide(layers)),
);

testEffect("add rejects a spec that is neither a path nor a package", () =>
  Effect.gen(function* () {
    const { configPath, storeDir } = yield* world;
    expect(yield* cli(["add", "!!!"], configPath, storeDir)).toBe(1);
    expect(yield* configuredPlugins(configPath)).toEqual([]);
  }).pipe(Effect.provide(layers)),
);

testEffect("rm and upgrade of unknown names fail", () =>
  Effect.gen(function* () {
    const { configPath, storeDir } = yield* world;
    expect(yield* cli(["rm", "absent-plugin"], configPath, storeDir)).toBe(1);
    expect(yield* cli(["upgrade", "absent-plugin"], configPath, storeDir)).toBe(1);
    expect(yield* cli(["upgrade", "present-plugin@1.0.0"], configPath, storeDir)).toBe(1);
  }).pipe(Effect.provide(layers)),
);
