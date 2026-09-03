import { afterEach, expect, test } from "bun:test";
import { Effect, Layer, Path } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { DEFAULT_CONFIG, decodeConfig, loadConfig, saveConfig } from "./config.ts";
import { resolveOptions } from "./options.ts";
import { testEffect } from "./test-effect.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  const paths = temporaryDirectories.splice(0);
  return Effect.runPromise(
    Effect.forEach(paths, (path) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(path, { recursive: true })).pipe(
        Effect.ignore,
      ),
    ).pipe(Effect.provide(BunFileSystem.layer)),
  );
});

function temporaryConfig(): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectory({ prefix: "amux-config-" })),
      );
      temporaryDirectories.push(directory);
      return path.join(directory, "config.json");
    }).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, Path.layer))),
  );
}

test("malformed key bindings cannot break keymap compilation", () => {
  const config = decodeConfig({
    keys: {
      leader: 7,
      bindings: { safe: ["ctrl+x", 4], __proto__: ["ctrl+p"] },
    },
  });

  expect(config.keys).toEqual({
    leader: DEFAULT_CONFIG.keys.leader,
    bindings: { safe: ["ctrl+x"], __proto__: ["ctrl+p"] },
  });
});

test("a whitespace-only leader uses the default", () => {
  expect(decodeConfig({ keys: { leader: "   " } }).keys.leader).toBe(DEFAULT_CONFIG.keys.leader);
});

test("a non-object config uses defaults", () => {
  expect(decodeConfig(null)).toEqual(DEFAULT_CONFIG);
});

test("options are stored as written and judged on the way out", () => {
  // Nothing is rejected at decode, because the decoder is not what knows the
  // bounds — and an entry it refused would be an entry a later build could not
  // read back.
  const config = decodeConfig({
    options: { "behaviour.scrollRows": 999, "behaviour.shell": 42 },
  });
  expect(config.options).toEqual({
    "behaviour.scrollRows": 999,
    "behaviour.shell": 42,
  });

  const options = resolveOptions(config.options);
  expect(options["behaviour.scrollRows"]).toBe(20);
  expect(options["behaviour.shell"]).toBe("");
});

test("an empty file is every default", () => {
  expect(decodeConfig({})).toEqual(DEFAULT_CONFIG);
  expect(resolveOptions(decodeConfig({}).options)["behaviour.scrollRows"]).toBe(3);
});

test("the default sidebar is an ordinary enabled plugin spec", () => {
  expect(DEFAULT_CONFIG.plugins).toEqual([
    { path: "builtin:amux.agent-awareness", enabled: true },
    { path: "builtin:amux.sidebar", enabled: true },
    { path: "builtin:amux.agent-harness", enabled: true },
    { path: "builtin:amux.notifications", enabled: true },
    { path: "builtin:amux.agent-hooks-cli", enabled: true },
  ]);
  expect(decodeConfig({}).plugins).toEqual(DEFAULT_CONFIG.plugins);
  expect(
    decodeConfig({
      plugins: [{ path: "builtin:amux.sidebar", enabled: false }],
    }).plugins,
  ).toEqual([
    { path: "builtin:amux.agent-awareness", enabled: true },
    { path: "builtin:amux.sidebar", enabled: false },
    { path: "builtin:amux.agent-harness", enabled: true },
    { path: "builtin:amux.notifications", enabled: true },
    { path: "builtin:amux.agent-hooks-cli", enabled: true },
  ]);
});

test("existing plugin lists gain new bundled defaults without duplicating saved entries", () => {
  expect(
    decodeConfig({
      plugins: [{ path: "builtin:amux.sidebar", enabled: true }],
    }).plugins,
  ).toEqual(DEFAULT_CONFIG.plugins);
});

test("an explicit disabled bundled plugin remains disabled", () => {
  expect(
    decodeConfig({
      plugins: [{ path: "builtin:amux.agent-harness", enabled: false }],
    }).plugins,
  ).toContainEqual({ path: "builtin:amux.agent-harness", enabled: false });
});

testEffect("a changed config survives save and load", () =>
  Effect.gen(function* () {
    const path = yield* Effect.promise(() => temporaryConfig());
    const config = decodeConfig({
      // The last is an option this build does not declare — a plugin's, or one
      // from a newer release. It has to come back out of the file unchanged.
      options: {
        "behaviour.scrollRows": 10,
        "appearance.gap": true,
        "clock.format": "%H:%M",
      },
      keys: { leader: "ctrl+b", bindings: { "app.quit": ["<leader>q"] } },
    });

    yield* saveConfig(config, path);
    expect(yield* loadConfig(path)).toEqual(config);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("invalid JSON falls back without throwing", () =>
  Effect.gen(function* () {
    const path = yield* Effect.promise(() => temporaryConfig());
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, "{not json");

    expect(yield* loadConfig(path)).toEqual(DEFAULT_CONFIG);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);
