import { expect, test } from "bun:test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { join } from "path";
import { Effect, Option, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { BunFileSystem } from "@effect/platform-bun";
import { fileURLToPath } from "node:url";
import {
  listInstalled,
  parsePackageSpec,
  pluginDirFor,
  pluginStoreDir,
  readInstalledManifest,
  resolveInstalledEntry,
  uninstallPackage,
} from "./store.ts";
import { testEffect } from "../test-effect.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

testEffect("the store lives under the XDG data dir", () =>
  Effect.gen(function* () {
    const store = yield* pluginStoreDir;
    expect(store.endsWith(join("amux", "plugins"))).toBe(true);
  }),
);

test("parsePackageSpec splits names and pins, scoped included", () => {
  expect(parsePackageSpec("example-plugin")).toEqual(
    Option.some({ name: "example-plugin", version: Option.none() }),
  );
  expect(parsePackageSpec("example-plugin@1.2.3")).toEqual(
    Option.some({ name: "example-plugin", version: Option.some("1.2.3") }),
  );
  expect(parsePackageSpec("@scope/example-plugin")).toEqual(
    Option.some({ name: "@scope/example-plugin", version: Option.none() }),
  );
  expect(parsePackageSpec("@scope/example-plugin@^1.2.0")).toEqual(
    Option.some({ name: "@scope/example-plugin", version: Option.some("^1.2.0") }),
  );
});

test("parsePackageSpec rejects paths and malformed specs", () => {
  expect(parsePackageSpec("./relative.ts")).toEqual(Option.none());
  expect(parsePackageSpec("/absolute/path.ts")).toEqual(Option.none());
  expect(parsePackageSpec("")).toEqual(Option.none());
  expect(parsePackageSpec("   ")).toEqual(Option.none());
  expect(parsePackageSpec("has spaces")).toEqual(Option.none());
  expect(parsePackageSpec("name@")).toEqual(Option.none());
  expect(parsePackageSpec("@scope")).toEqual(Option.none());
  expect(parsePackageSpec("!!!")).toEqual(Option.none());
});

testEffect("pluginDirFor flattens scoped names and stays inside the store", () =>
  Effect.gen(function* () {
    const store = yield* pluginStoreDir;
    expect(pluginDirFor("example-plugin", store)).toBe(join(store, "example-plugin"));
    expect(pluginDirFor("@scope/example-plugin", store)).toBe(
      join(store, "scope__example-plugin"),
    );
  }),
);

const tempDir: Effect.Effect<string, PlatformError, FileSystem.FileSystem | Scope.Scope> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ directory: testDir, prefix: ".test-store-" });
  });

const writeJson = Effect.fnUntraced(function* (
  path: string,
  value:
    | {
        readonly name: string;
        readonly private: boolean;
        readonly dependencies: Record<string, string>;
      }
    | {
        readonly name: string;
        readonly version: string;
        readonly exports: Record<string, string>;
        readonly engines?: Record<string, string>;
      },
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path.split("/").slice(0, -1).join("/"), { recursive: true });
  yield* fs.writeFileString(
    path,
    // Fixture JSON, not an encode of a typed manifest.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    JSON.stringify(value),
  );
});

/** A store tree shaped the way `installPackage` leaves one, without the network. */
const fakeInstall = Effect.fnUntraced(function* (store: string, name: string, version: string) {
  const dir = pluginDirFor(name, store);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(join(dir, "node_modules", name), { recursive: true });
  yield* writeJson(join(dir, "package.json"), {
    name: "amux-installed-plugin",
    private: true,
    dependencies: { [name]: `^${version}` },
  });
  yield* writeJson(join(dir, "node_modules", name, "package.json"), {
    name,
    version,
    exports: { ".": "./index.js" },
    engines: { amux: "^0.1.0" },
  });
  yield* fs.writeFileString(
    join(dir, "node_modules", name, "index.js"),
    `export default { id: "fake-example" };\n`,
  );
});

testEffect("an empty store lists nothing", () =>
  Effect.gen(function* () {
    const store = yield* tempDir;
    expect(yield* listInstalled(store)).toEqual([]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a fake install resolves, reads, lists, and uninstalls", () =>
  Effect.gen(function* () {
    const store = yield* tempDir;
    yield* fakeInstall(store, "fake-example-plugin", "0.2.0");

    const entry = yield* resolveInstalledEntry("fake-example-plugin", store);
    expect(entry.endsWith(join("node_modules", "fake-example-plugin", "index.js"))).toBe(true);

    expect(yield* readInstalledManifest("fake-example-plugin", store)).toEqual({
      version: "0.2.0",
      enginesAmux: "^0.1.0",
    });

    expect(yield* listInstalled(store)).toEqual([
      { name: "fake-example-plugin", version: "0.2.0" },
    ]);

    yield* uninstallPackage("fake-example-plugin", store);
    expect(yield* listInstalled(store)).toEqual([]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a missing package fails resolution with its name", () =>
  Effect.gen(function* () {
    const store = yield* tempDir;

    const failure = yield* Effect.result(resolveInstalledEntry("absent-plugin", store));

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") expect(failure.failure).toContain("absent-plugin");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);
