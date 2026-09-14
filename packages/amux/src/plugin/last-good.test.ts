import { expect } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Option, Path } from "effect";
import * as FileSystem from "effect/FileSystem";
import { makeLastGoodStore, restoreLastGood } from "./last-good.ts";
import { testEffect } from "../test-effect.ts";

const testDir = new URL(".", import.meta.url).pathname;

testEffect("last-good generations survive an atomic store round trip", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: testDir,
      prefix: ".last-good-",
    });
    const path = yield* Path.Path;
    const store = yield* makeLastGoodStore(path.join(directory, "recovery.json"));
    expect(Option.isNone(yield* store.read)).toBe(true);

    const generation = {
      version: 1 as const,
      entries: ["file:///plugins/example.ts"],
      modules: [{ url: "file:///plugins/example.ts", text: "export default {}" }],
    };
    yield* store.write(generation);
    expect(Option.getOrThrow(yield* store.read)).toEqual(generation);
    const restored = yield* restoreLastGood(generation, path.join(directory, "archive"));
    expect(yield* fs.readFileString(new URL(restored.get(generation.entries[0]!)!).pathname)).toBe(
      "export default {}",
    );
  }).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
);
