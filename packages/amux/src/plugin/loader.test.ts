import { afterEach, expect, test } from "bun:test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { BunFileSystem } from "@effect/platform-bun";
import { createPluginHost, type PluginHost } from "./host.ts";
import {
  loadDaemonPluginsFromConfig,
  loadPluginsFromConfig as loadConfiguredPlugins,
} from "./loader.ts";
import { testPluginEnvironment, type TestPluginEnvironment } from "./test-environment.ts";
import { definePlugin, type PluginDefinition } from "./types.ts";
import type { Config, PluginSpec } from "../config.ts";
import { decodeConfig, loadConfig } from "../config.ts";
import { testEffect } from "../test-effect.ts";
import type { Regions } from "../ui/regions.tsx";
import { createTestRenderer } from "@opentui/core/testing";

const testDir = fileURLToPath(new URL(".", import.meta.url));

const cleanupFns: (() => void)[] = [];
const registryEntriesByHost = new WeakMap<PluginHost, readonly PluginDefinition[]>();
const pluginStatuses = (host: PluginHost) =>
  host.status().filter((status) => !status.id.startsWith("amux.registry."));
afterEach(() => {
  for (const fn of cleanupFns.splice(0)) fn();
});

const tempDir: Effect.Effect<string, PlatformError, FileSystem.FileSystem | Scope.Scope> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ directory: testDir, prefix: ".test-" });
  });

const writePluginFile = (
  dir: string,
  name: string,
  content: string,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fp = join(dir, name);
    yield* fs.writeFileString(fp, content);
    return fp;
  });

// @effect-diagnostics-next-line asyncFunction:off -- opentui's test renderer is plain-async by design; see harness.ts's seam.
async function mockRegions(): Promise<{
  environment: TestPluginEnvironment;
  dispose: () => void;
}> {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const environment = testPluginEnvironment(t.renderer);
  return { environment, dispose: () => t.renderer.destroy() };
}

function makeHost(): Effect.Effect<{ host: PluginHost; regions: Regions }, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { environment, dispose } = yield* Effect.promise(() => mockRegions());
    cleanupFns.push(dispose);
    const host = yield* createPluginHost(environment);
    registryEntriesByHost.set(host, environment.registryEntries);
    return { host, regions: environment.registries.regions };
  });
}

const loadPluginsFromConfig = (
  config: Config,
  host: PluginHost,
  configDir: string,
  entries: readonly PluginDefinition[] = [],
  storeDir?: string,
) =>
  loadConfiguredPlugins(
    config,
    host,
    configDir,
    [...(registryEntriesByHost.get(host) ?? []), ...entries],
    ...(storeDir === undefined ? [] : [storeDir]),
  );

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    options: {},
    keys: { leader: "ctrl+a", bindings: {} },
    plugins: [],
    permissions: [],
    ...overrides,
  };
}

function spec(path: string, enabled = true): PluginSpec {
  return { path, enabled };
}

const writeExampleConfig = (
  dir: string,
  example: string,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = join(dir, "config.json");
    yield* fs.writeFileString(
      path,
      // Fixture JSON, not an encode of a typed Config — the plugin list is deliberately partial.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      JSON.stringify({
        plugins: [
          { path: join(dir, "not-a-plugin.ts"), enabled: false },
          { path: join(testDir, "../../../../examples", example), enabled: true },
        ],
      }),
    );
    return path;
  });

function mkPluginSrc(id: string, variant?: string): string {
  const typesPath = fileURLToPath(new URL("./types.ts", import.meta.url));
  const preamble = `import { Effect } from "effect";
import { definePlugin } from ${JSON.stringify(typesPath)};`;
  switch (variant) {
    case "no-default":
      return `export const x = 1;`;
    case "null-default":
      return `export default null;`;
    case "no-id":
      return `${preamble}\nexport default { activate: () => Effect.void };`;
    case "empty-id":
      return `${preamble}\nexport default { id: "", activate: () => Effect.void };`;
    case "no-activate":
      return `export default { id: "${id}" };`;
    case "throw":
      return `throw new Error("syntax error");`;
    default:
      return `${preamble}\nexport default definePlugin({ id: "${id}", effect: () => Effect.void });`;
  }
}

// --- Happy path ---

testEffect("loads a valid plugin", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "my-plugin.ts", mkPluginSrc("my-plugin"));

    const config = baseConfig({ plugins: [spec(join(dir, "my-plugin.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("my-plugin");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("loads a path plugin's daemon entrypoint", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "index.ts", mkPluginSrc("client-plugin"));
    yield* writePluginFile(dir, "daemon.ts", mkPluginSrc("daemon-plugin"));

    const config = baseConfig({ plugins: [spec(join(dir, "index.ts"))] });
    const { host } = yield* makeHost();

    yield* loadDaemonPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["daemon-plugin"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("loads the worked external status bar example", () =>
  Effect.gen(function* () {
    const { host, regions } = yield* makeHost();
    const config = baseConfig({
      plugins: [spec(join(testDir, "../../../../examples/status-bar.tsx"))],
    });

    yield* loadPluginsFromConfig(config, host, testDir);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["example.status-bar"]);
    expect(regions.declared("bottom", "app")).toBe(true);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("loads the agent dashboard example through the config loader", () =>
  Effect.gen(function* () {
    const { host, regions } = yield* makeHost();
    const dir = yield* tempDir;
    const configPath = yield* writeExampleConfig(dir, "agent-dashboard.tsx");
    const config = yield* loadConfig(configPath).pipe(Effect.provide(BunFileSystem.layer));

    yield* loadPluginsFromConfig(config, host, dirname(configPath));

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["example.agent-dashboard"]);
    expect(regions.declared("bottom", "app")).toBe(true);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("loads the agent triage example through the config loader", () =>
  Effect.gen(function* () {
    const { host, regions } = yield* makeHost();
    const dir = yield* tempDir;
    const configPath = yield* writeExampleConfig(dir, "agent-triage.tsx");
    const config = yield* loadConfig(configPath).pipe(Effect.provide(BunFileSystem.layer));

    yield* loadPluginsFromConfig(config, host, dirname(configPath));

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["example.agent-triage"]);
    expect(regions.declared("right", "app")).toBe(true);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("loads multiple plugins in order", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "a.ts", mkPluginSrc("a"));
    yield* writePluginFile(dir, "b.ts", mkPluginSrc("b"));

    const config = baseConfig({
      plugins: [spec(join(dir, "a.ts")), spec(join(dir, "b.ts"))],
    });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    const ids = pluginStatuses(host)
      .map((s) => s.id)
      .sort();
    expect(ids).toEqual(["a", "b"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("discovers plugins in the config directory's plugins/ subdirectory", () =>
  Effect.gen(function* () {
    const configHome = yield* tempDir;
    const pluginDir = join(configHome, "amux", "plugins");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(pluginDir, { recursive: true });
    yield* writePluginFile(pluginDir, "discovered.ts", mkPluginSrc("discovered"));
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(baseConfig(), host, join(configHome, "amux"));

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["discovered"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Relative paths ---

testEffect("resolves relative paths against configDir", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "rel.ts", mkPluginSrc("rel-plugin"));

    const config = baseConfig({ plugins: [spec("rel.ts")] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("rel-plugin");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- file:// URLs ---

testEffect("resolves file:// URLs to paths", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const fp = yield* writePluginFile(dir, "url.ts", mkPluginSrc("url-plugin"));
    const urlSpec = spec("file://" + fp);

    const config = baseConfig({ plugins: [urlSpec] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("url-plugin");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- enabled / disabled ---

testEffect("skips disabled plugins", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "enabled.ts", mkPluginSrc("enabled"));
    yield* writePluginFile(dir, "disabled.ts", mkPluginSrc("disabled"));

    const config = baseConfig({
      plugins: [spec(join(dir, "enabled.ts")), spec(join(dir, "disabled.ts"), false)],
    });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("enabled");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- One bad plugin does not block others ---

testEffect("one bad plugin does not block the next", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "bad.ts", mkPluginSrc("bad", "no-default"));
    yield* writePluginFile(dir, "good.ts", mkPluginSrc("good"));

    const config = baseConfig({
      plugins: [spec(join(dir, "bad.ts")), spec(join(dir, "good.ts"))],
    });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    const ids = pluginStatuses(host).map((s) => s.id);
    expect(ids).toEqual(["good"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a plugin that throws on import does not block others", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "crash.ts", mkPluginSrc("crash", "throw"));
    yield* writePluginFile(dir, "ok.ts", mkPluginSrc("ok"));

    const config = baseConfig({
      plugins: [spec(join(dir, "crash.ts")), spec(join(dir, "ok.ts"))],
    });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("ok");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Validation: missing default export ---

testEffect("reports a plugin with no default export", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "nodefault.ts", mkPluginSrc("nodefault", "no-default"));

    const config = baseConfig({ plugins: [spec(join(dir, "nodefault.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Validation: null default export ---

testEffect("reports a plugin with a null default export", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "null.ts", mkPluginSrc("null", "null-default"));

    const config = baseConfig({ plugins: [spec(join(dir, "null.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Validation: missing or empty id ---

testEffect("reports a plugin with no id field", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "noid.ts", mkPluginSrc("noid", "no-id"));

    const config = baseConfig({ plugins: [spec(join(dir, "noid.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("reports a plugin with an empty id", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "emptyid.ts", mkPluginSrc("emptyid", "empty-id"));

    const config = baseConfig({ plugins: [spec(join(dir, "emptyid.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Validation: missing activation function ---

testEffect("reports a plugin with no activation function", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "noeff.ts", mkPluginSrc("noeff", "no-activate"));

    const config = baseConfig({ plugins: [spec(join(dir, "noeff.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Missing file ---

testEffect("handles a missing file gracefully", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const missing = join(dir, "does-not-exist.ts");

    const config = baseConfig({ plugins: [spec(missing)] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Malformed config defaults ---

testEffect("empty plugins array does nothing", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(baseConfig(), host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("reconciles core and configured entries as one configuration", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "configured.ts", mkPluginSrc("configured"));
    const { host } = yield* makeHost();
    const core = definePlugin({
      id: "amux.windows",
      effect: () => Effect.void,
    });

    yield* loadPluginsFromConfig(
      baseConfig({ plugins: [spec(join(dir, "configured.ts"))] }),
      host,
      dir,
      [core],
    );

    expect(
      pluginStatuses(host)
        .map((status) => status.id)
        .sort(),
    ).toEqual(["amux.windows", "configured"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Path traversal prevention ---

testEffect("relative paths that escape configDir are rejected", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;

    const config = baseConfig({ plugins: [spec("../other/plugin.ts")] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Explicit absolute paths are allowed ---

testEffect("absolute paths outside configDir are allowed", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const other = yield* tempDir;
    yield* writePluginFile(other, "abs.ts", mkPluginSrc("abs-plugin"));

    const config = baseConfig({ plugins: [spec(join(other, "abs.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("abs-plugin");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- loadPluginsFromConfig doesn't block host lifecycle ---

testEffect("host continues working after loader finishes", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "pre.ts", mkPluginSrc("pre"));

    const config = baseConfig({ plugins: [spec(join(dir, "pre.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);
    yield* host.add(
      definePlugin({
        id: "post",
        effect: () => Effect.void,
      }),
    );

    expect(
      pluginStatuses(host)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["post", "pre"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Package specs resolve through the plugin store ---

/** A store tree shaped the way `installPackage` leaves one, without the network. */
const fakeInstall = Effect.fnUntraced(function* (
  store: string,
  name: string,
  pluginId: string,
  engines?: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = join(store, name);
  yield* fs.makeDirectory(join(dir, "node_modules", name), { recursive: true });
  yield* fs.writeFileString(
    join(dir, "package.json"),
    // Fixture JSON, not an encode of a typed manifest.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    JSON.stringify({
      name: "amux-installed-plugin",
      private: true,
      dependencies: { [name]: "^0.2.0" },
    }),
  );
  const installedBase = {
    name,
    version: "0.2.0",
    exports: { ".": "./index.js" },
  };
  yield* fs.writeFileString(
    join(dir, "node_modules", name, "package.json"),
    // Fixture JSON, not an encode of a typed manifest.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    JSON.stringify(engines === undefined ? installedBase : { ...installedBase, engines }),
  );
  yield* fs.writeFileString(
    join(dir, "node_modules", name, "index.js"),
    `import { Effect } from "effect";\nexport default { id: "${pluginId}", activate: () => Effect.void };\n`,
  );
});

testEffect("loads an installed package by name", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const store = join(dir, "store");
    yield* fakeInstall(store, "fake-example-plugin", "fake-example");

    const config = baseConfig({ plugins: [{ package: "fake-example-plugin", enabled: true }] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir, [], store);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["fake-example"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a configured package with no install is skipped", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const store = join(dir, "store");

    const config = baseConfig({ plugins: [{ package: "absent-plugin", enabled: true }] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir, [], store);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a package whose engines.amux misses the host is refused, without blocking others", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const store = join(dir, "store");
    yield* fakeInstall(store, "future-plugin", "future", { amux: "^99.0.0" });
    yield* fakeInstall(store, "present-plugin", "present", { amux: "^0.1.0" });

    const config = baseConfig({
      plugins: [
        { package: "future-plugin", enabled: true },
        { package: "present-plugin", enabled: true },
      ],
    });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir, [], store);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["present"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Decode config preserves plugins ---

test("decodeConfig preserves valid plugin specs", () => {
  const config = decodeConfig({
    plugins: [
      "./relative.ts",
      "/absolute/path.ts",
      { path: "/with/options.ts", enabled: true },
      { path: "/disabled.ts", enabled: false },
      { package: "example-plugin" },
      { package: "@scope/example-plugin", version: "^1.2.0", enabled: false },
      "",
      null,
      42,
      { enabled: true },
      { path: 123 },
      { package: "" },
    ],
  });

  expect(config.plugins).toEqual([
    { path: "./relative.ts", enabled: true },
    { path: "/absolute/path.ts", enabled: true },
    { path: "/with/options.ts", enabled: true },
    { path: "/disabled.ts", enabled: false },
    { package: "example-plugin", enabled: true },
    { package: "@scope/example-plugin", version: "^1.2.0", enabled: false },
  ]);
});
