/** @effect-diagnostics *:skip-file -- exercises Bun's real file write for scratch materialize/promote. */
import { afterEach, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import {
  managedPluginEntryPath,
  managedPluginSpecPath,
  materializeScratch,
  promoteScratch,
  scratchEntryPath,
} from "./scratch.ts";
import { DEFAULT_CONFIG, loadConfig } from "../config.ts";
import { testEffect } from "../test-effect.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const scratchSource = (id: string) =>
  `import { Effect } from "effect";
import { definePlugin } from "amux";
export default definePlugin({ id: ${JSON.stringify(id)}, effect: () => Effect.void });
`;

testEffect("materializeScratch writes the entry file", () =>
  Effect.gen(function* () {
    const scratchDir = yield* Effect.promise(() => mkdtemp(join(testDir, ".test-scratch-")));
    temporary.push(scratchDir);
    const url = yield* materializeScratch("live.review", scratchSource("live.review"), scratchDir).pipe(
      Effect.provide(BunFileSystem.layer),
    );
    expect(fileURLToPath(url)).toBe(scratchEntryPath("live.review", scratchDir));
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(scratchEntryPath("live.review", scratchDir))).toContain(
      "live.review",
    );
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("promoteScratch writes managed path, config, and removes scratch", () =>
  Effect.gen(function* () {
    const scratchDir = yield* Effect.promise(() => mkdtemp(join(testDir, ".test-scratch-")));
    const configDir = yield* Effect.promise(() => mkdtemp(join(testDir, ".test-config-")));
    temporary.push(scratchDir, configDir);
    yield* materializeScratch("live.review", scratchSource("live.review"), scratchDir).pipe(
      Effect.provide(BunFileSystem.layer),
    );
    const configPath = join(configDir, "config.json");
    const result = yield* promoteScratch("live.review", {
      config: structuredClone(DEFAULT_CONFIG),
      configDir,
      configPath,
      scratchDir,
    }).pipe(Effect.provide(BunFileSystem.layer));
    expect(result.path).toBe(managedPluginSpecPath("live.review"));
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(managedPluginEntryPath("live.review", configDir))).toContain(
      "live.review",
    );
    expect(yield* fs.exists(scratchEntryPath("live.review", scratchDir))).toBe(false);
    const saved = yield* loadConfig(configPath);
    expect(saved.plugins).toContainEqual({
      path: managedPluginSpecPath("live.review"),
      enabled: true,
    });
  }).pipe(Effect.provide(BunFileSystem.layer)),
);
