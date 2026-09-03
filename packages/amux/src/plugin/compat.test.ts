import { expect, test } from "bun:test";
import { Effect, Schema as S, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { BunFileSystem } from "@effect/platform-bun";
import { fileURLToPath } from "node:url";
import { AMUX_PLUGIN_HOST_VERSION, checkPluginCompat, satisfiesRange } from "./compat.ts";
import { testEffect } from "../test-effect.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

testEffect("the host version pins to the amux package version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
    );
    const pkg = yield* S.decodeEffect(S.fromJsonString(S.Struct({ version: S.String })))(text);
    expect(pkg.version).toBe(AMUX_PLUGIN_HOST_VERSION);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

test("satisfiesRange covers the range shapes plugins actually declare", () => {
  expect(satisfiesRange("0.1.0", "^0.1.0")).toBe(true);
  expect(satisfiesRange("0.1.4", "^0.1.0")).toBe(true);
  expect(satisfiesRange("0.2.0", "^0.1.0")).toBe(false);
  expect(satisfiesRange("1.2.3", "^1.2.3")).toBe(true);
  expect(satisfiesRange("2.0.0", "^1.2.3")).toBe(false);
  expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
  expect(satisfiesRange("0.1.5", "~0.1.0")).toBe(true);
  expect(satisfiesRange("0.2.0", "~0.1.0")).toBe(false);
  expect(satisfiesRange("0.1.0", "0.1.0")).toBe(true);
  expect(satisfiesRange("0.1.1", "0.1.0")).toBe(false);
  expect(satisfiesRange("0.1.0", ">=0.1.0")).toBe(true);
  expect(satisfiesRange("0.1.0", ">=0.1.0 <0.2.0")).toBe(true);
  expect(satisfiesRange("0.2.0", ">=0.1.0 <0.2.0")).toBe(false);
  expect(satisfiesRange("0.1.0", "*")).toBe(true);
  expect(satisfiesRange("0.1.7", "0.1")).toBe(true);
  expect(satisfiesRange("0.2.0", "0.1")).toBe(false);
});

test("satisfiesRange is fail-closed on shapes outside the subset", () => {
  // Bun.semver.satisfies answers true to every one of these; the gate must not.
  expect(satisfiesRange("0.1.0", "garbage")).toBe(false);
  expect(satisfiesRange("0.1.0", "")).toBe(false);
  expect(satisfiesRange("0.1.0", "^")).toBe(false);
  expect(satisfiesRange("0.1.0", "=>0.1.0")).toBe(false);
  expect(satisfiesRange("0.1.0", "^0.1.0 || ^1.0.0")).toBe(false);
  expect(satisfiesRange("0.1.0", "latest")).toBe(false);
  expect(satisfiesRange("0.1.0", "1.2.3 - 2.3.4")).toBe(false);
});

const tempDir: Effect.Effect<string, PlatformError, FileSystem.FileSystem | Scope.Scope> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ directory: testDir, prefix: ".test-compat-" });
  });

const writeManifest = Effect.fnUntraced(function* (
  dir: string,
  manifest: {
    readonly name: string;
    readonly version: string;
    readonly engines?: Record<string, string>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    `${dir}/package.json`,
    // Fixture JSON, not an encode of a typed manifest.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    JSON.stringify(manifest),
  );
  yield* fs.writeFileString(dir + "/plugin.ts", `export default { id: "probed" };\n`);
});

const sourceOf = (dir: string) => new URL(`file://${dir}/plugin.ts`);

testEffect("a plugin with no engines.amux is not gated", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writeManifest(dir, { name: "ungated", version: "1.0.0" });

    const result = yield* Effect.result(checkPluginCompat(sourceOf(dir), "probed"));

    expect(result._tag).toBe("Success");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a plugin whose range covers the host loads", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writeManifest(dir, {
      name: "compatible",
      version: "1.0.0",
      engines: { amux: "^0.1.0" },
    });

    const result = yield* Effect.result(checkPluginCompat(sourceOf(dir), "probed"));

    expect(result._tag).toBe("Success");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a plugin whose range misses the host is refused by name", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writeManifest(dir, {
      name: "incompatible",
      version: "1.0.0",
      engines: { amux: "^99.0.0" },
    });

    const result = yield* Effect.result(checkPluginCompat(sourceOf(dir), "probed"));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toContain("probed");
      expect(result.failure).toContain("^99.0.0");
      expect(result.failure).toContain(AMUX_PLUGIN_HOST_VERSION);
    }
  }).pipe(Effect.provide(BunFileSystem.layer)),
);
