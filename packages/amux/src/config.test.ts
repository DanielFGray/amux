import { afterEach, expect, test } from "bun:test";
import { Effect, Layer, Path } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { DEFAULT_CONFIG, decodeConfig, loadConfig, saveConfig, type Config } from "./config.ts";
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
  const config = decodeConfig(
    JSON.stringify({
      keys: {
        leader: 7,
        bindings: { safe: ["ctrl+x", 4], __proto__: ["ctrl+p"] },
      },
    }),
  );

  expect(config.keys).toEqual({
    prefix: DEFAULT_CONFIG.keys.prefix,
    leader: DEFAULT_CONFIG.keys.leader,
    bindings: { safe: ["ctrl+x"], __proto__: ["ctrl+p"] },
  });
});

test("a whitespace-only mux chord in a legacy leader field uses the default prefix", () => {
  expect(decodeConfig(JSON.stringify({ keys: { leader: "   " } })).keys.prefix).toBe(
    DEFAULT_CONFIG.keys.prefix,
  );
  expect(decodeConfig(JSON.stringify({ keys: { leader: "   " } })).keys.leader).toBe(
    DEFAULT_CONFIG.keys.leader,
  );
});

test("legacy keys.leader migrates to keys.prefix; localleader becomes leader", () => {
  const config = decodeConfig(
    JSON.stringify({
      keys: {
        leader: "ctrl+b",
        localleader: ",",
        bindings: { "pane.zoom": ["<leader>z"], "editor.find": ["<localleader>/"] },
      },
    }),
  );
  expect(config.keys).toEqual({
    prefix: "ctrl+b",
    leader: ",",
    bindings: { "pane.zoom": ["<prefix>z"], "editor.find": ["<leader>/"] },
  });
});

test("a non-object config uses defaults", () => {
  expect(decodeConfig("null")).toEqual(DEFAULT_CONFIG);
});

test("options are stored as written and judged on the way out", () => {
  // Nothing is rejected at decode, because the decoder is not what knows the
  // bounds — and an entry it refused would be an entry a later build could not
  // read back.
  const config = decodeConfig(
    JSON.stringify({
      options: { "behaviour.scrollRows": 999, "behaviour.shell": 42 },
    }),
  );
  expect(config.options).toEqual({
    "behaviour.scrollRows": 999,
    "behaviour.shell": 42,
  });

  const options = resolveOptions(config.options);
  expect(options["behaviour.scrollRows"]).toBe(20);
  expect(options["behaviour.shell"]).toBe("");
});

test("an empty file is every default", () => {
  expect(decodeConfig("{}")).toEqual(DEFAULT_CONFIG);
  expect(resolveOptions(decodeConfig("{}").options)["behaviour.scrollRows"]).toBe(3);
});

test("a config without layoutRules decodes to no rules", () => {
  expect(decodeConfig("{}").layoutRules).toEqual([]);
  expect(decodeConfig(JSON.stringify({ permissions: [] })).layoutRules).toEqual([]);
});

test("layoutRules round-trip through decodeConfig", () => {
  const loaded = JSON.stringify({
    layoutRules: [
      { algorithm: "default", when: { maxCols: 80 } },
      { algorithm: "niri", when: { minCols: 81, workspace: "desk" } },
    ],
  });
  expect(decodeConfig(loaded).layoutRules).toEqual([
    { algorithm: "default", when: { maxCols: 80 } },
    { algorithm: "niri", when: { minCols: 81, workspace: "desk" } },
  ]);
});

test("malformed layoutRules entries are skipped", () => {
  const loaded = JSON.stringify({
    layoutRules: [{ algorithm: "niri", when: { maxCols: 80 } }, { algorithm: 7 }, null],
  });
  expect(decodeConfig(loaded).layoutRules).toEqual([{ algorithm: "niri", when: { maxCols: 80 } }]);
});

test("layoutRules reject negative or non-integer bounds", () => {
  const negative = JSON.stringify({
    layoutRules: [{ algorithm: "niri", when: { maxCols: -1 } }],
  });
  expect(decodeConfig(negative).layoutRules).toEqual([]);
  const fractional = JSON.stringify({
    layoutRules: [{ algorithm: "niri", when: { maxCols: 80.5 } }],
  });
  expect(decodeConfig(fractional).layoutRules).toEqual([]);
});

test("no plugins are active by default", () => {
  expect(DEFAULT_CONFIG.plugins).toEqual([]);
  expect(decodeConfig("{}").plugins).toEqual([]);
});

test("a config that names no plugins loads none", () => {
  expect(decodeConfig(JSON.stringify({ plugins: [] })).plugins).toEqual([]);
});

test("package specs decode beside path specs", () => {
  expect(
    decodeConfig(
      JSON.stringify({
        plugins: [
          { package: "example-plugin" },
          { package: "@scope/example-plugin", version: "^1.2.0", enabled: false },
          { path: "/plugins/sidebar.ts", enabled: false },
        ],
      }),
    ).plugins,
  ).toEqual([
    { package: "example-plugin", enabled: true },
    { package: "@scope/example-plugin", version: "^1.2.0", enabled: false },
    { path: "/plugins/sidebar.ts", enabled: false },
  ]);
});

testEffect("a changed config survives save and load", () =>
  Effect.gen(function* () {
    const path = yield* Effect.promise(() => temporaryConfig());
    // The last option is one this build does not declare — a plugin's, or one
    // from a newer release. It has to come back out of the file unchanged.
    const config: Config = {
      ...DEFAULT_CONFIG,
      options: {
        "behaviour.scrollRows": 10,
        "appearance.gap": true,
        "clock.format": "%H:%M",
      },
      keys: { prefix: "ctrl+b", leader: "space", bindings: { "app.quit": ["<leader>q"] } },
    };

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
