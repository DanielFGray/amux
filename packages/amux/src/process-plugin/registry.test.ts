import { expect } from "bun:test";
import { Effect, Layer, Path } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { fileURLToPath } from "node:url";
import { PROCESS_PLUGIN_MANIFEST } from "./manifest.ts";
import {
  getProcessPlugin,
  linkProcessPlugin,
  listProcessPlugins,
  unlinkProcessPlugin,
} from "./registry.ts";
import { invokeProcessPluginAction } from "./cli.ts";
import { testEffect } from "../test-effect.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const layers = Layer.mergeAll(BunFileSystem.layer, Path.layer);

const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    directory: testDir,
    prefix: ".test-process-plugin-",
  });
  const pluginRoot = path.join(root, "example-plugin");
  yield* fs.makeDirectory(pluginRoot, { recursive: true });
  yield* fs.writeFileString(
    path.join(pluginRoot, PROCESS_PLUGIN_MANIFEST),
    [
      'id = "example.smoke"',
      'name = "Smoke"',
      'version = "0.1.0"',
      "",
      "[[actions]]",
      'id = "ping"',
      'title = "Ping"',
      'command = ["sh", "-c", "echo ping-ok"]',
      "",
      "[[panes]]",
      'id = "board"',
      'title = "Board"',
      'command = ["sh", "-c", "echo pane"]',
      "",
    ].join("\n"),
  );
  const roots = {
    registryPath: path.join(root, "registry.json"),
    configRoot: path.join(root, "config"),
    stateRoot: path.join(root, "state"),
  };
  return { root, pluginRoot, roots };
});

testEffect("link, list, invoke action, unlink", () =>
  Effect.gen(function* () {
    const { pluginRoot, roots } = yield* world;
    const linked = yield* linkProcessPlugin(pluginRoot, { roots });
    expect(linked.pluginId).toBe("example.smoke");
    expect(linked.manifest.actions).toHaveLength(1);

    const listed = yield* listProcessPlugins({ roots });
    expect(listed.map((p) => p.pluginId)).toEqual(["example.smoke"]);

    const got = yield* getProcessPlugin("example.smoke", { roots });
    expect(got.pluginRoot).toBe(pluginRoot);

    const ran = yield* invokeProcessPluginAction("example.smoke", "ping", { roots });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.trim()).toBe("ping-ok");

    expect(yield* unlinkProcessPlugin("example.smoke", { roots })).toBe(true);
    expect(yield* listProcessPlugins({ roots })).toEqual([]);
  }).pipe(Effect.provide(layers)),
);

testEffect("get fails for an unknown plugin", () =>
  Effect.gen(function* () {
    const { roots } = yield* world;
    const result = yield* getProcessPlugin("missing", { roots }).pipe(Effect.exit);
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(layers)),
);
