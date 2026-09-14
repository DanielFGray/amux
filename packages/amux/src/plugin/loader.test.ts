import { afterEach, expect, test } from "bun:test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Layer, Path, Result, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { BunFileSystem } from "@effect/platform-bun";
import { createPluginHost, type PluginHost } from "./host.ts";
import {
  loadPlugins as loadConfiguredPlugins,
  prepareDaemonPlugins,
  PluginReconcileError,
  type PluginEntry,
} from "./loader.ts";
import { testPluginEnvironment, type TestPluginEnvironment } from "./test-environment.ts";
import { definePlugin, type PluginDefinition } from "./types.ts";
import type { Config, PluginSpec } from "../config.ts";
import { decodeConfig, loadConfig } from "../config.ts";
import { testEffect } from "../test-effect.ts";
import type { Slots } from "../ui/slots.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { makeLastGoodStore } from "./last-good.ts";

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

function makeHost(): Effect.Effect<{ host: PluginHost; slots: Slots }, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { environment, dispose } = yield* Effect.promise(() => mockRegions());
    cleanupFns.push(dispose);
    const host = yield* createPluginHost(environment);
    registryEntriesByHost.set(host, environment.registryEntries);
    return { host, slots: environment.registries.slots };
  });
}

const loadPlugins = (
  config: Config,
  host: PluginHost,
  configDir: string,
  entries: readonly PluginDefinition[] = [],
  previous: readonly PluginEntry[] = [],
  storeDir?: string,
) =>
  loadConfiguredPlugins(
    config.plugins,
    host,
    configDir,
    [...(registryEntriesByHost.get(host) ?? []), ...entries],
    previous,
    ...(storeDir === undefined ? [] : [storeDir]),
  );

const loadAndPublishDaemonPlugins = (
  plugins: Config["plugins"],
  host: PluginHost,
  configDir: string,
) =>
  prepareDaemonPlugins(plugins, host, configDir).pipe(
    Effect.tap(() =>
      host.publish.pipe(Effect.mapError((message) => new PluginReconcileError({ message }))),
    ),
  );

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    options: {},
    keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
    plugins: [],
    permissions: [],
    layoutRules: [],
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

    yield* loadPlugins(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("my-plugin");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a quarantined last-good archive is loaded instead of a broken disk edit", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const entry = yield* writePluginFile(dir, "saved.ts", "this is broken disk source");
    const source = pathToFileURL(entry);
    const store = yield* makeLastGoodStore(join(dir, ".amux", "plugin-last-good.json"));
    yield* store.write({
      version: 1,
      entries: [source.href],
      modules: [{ url: source.href, text: mkPluginSrc("saved") }],
      quarantined: true,
    });
    const { host } = yield* makeHost();

    const loaded = yield* loadPlugins(baseConfig({ plugins: [spec(entry)] }), host, dir);

    expect(loaded.recovered).toBe(true);
    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["saved"]);
  }).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
);

testEffect("loads the editor package through its configured package entrypoint", () =>
  Effect.gen(function* () {
    const { host } = yield* makeHost();
    const editor = join(testDir, "../../../editor");
    const config = baseConfig({ plugins: [spec(editor)] });

    yield* loadPlugins(config, host, testDir);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["amux.editor"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("loads a path plugin's daemon entrypoint", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "index.ts", mkPluginSrc("client-plugin"));
    yield* writePluginFile(dir, "daemon.ts", mkPluginSrc("daemon-plugin"));

    const config = baseConfig({ plugins: [spec(join(dir, "index.ts"))] });
    const { host } = yield* makeHost();

    yield* loadAndPublishDaemonPlugins(config.plugins, host, dir);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["daemon-plugin"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect(
  "a directory-style path plugin resolves entrypoints through its own package.json exports",
  () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(join(dir, "src"), { recursive: true });
      yield* writePluginFile(dir, "src/index.ts", mkPluginSrc("client-plugin"));
      yield* writePluginFile(dir, "src/daemon.ts", mkPluginSrc("daemon-plugin"));
      yield* fs.writeFileString(
        join(dir, "package.json"),
        // Fixture JSON, not an encode of a typed manifest.
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          name: "a-directory-plugin",
          exports: { ".": "./src/index.ts", "./daemon": "./src/daemon.ts" },
        }),
      );

      const config = baseConfig({ plugins: [spec(dir)] });
      const { host: clientHost } = yield* makeHost();
      yield* loadPlugins(config, clientHost, dir);
      expect(pluginStatuses(clientHost).map((status) => status.id)).toEqual(["client-plugin"]);

      const { host: daemonHost } = yield* makeHost();
      yield* loadAndPublishDaemonPlugins(config.plugins, daemonHost, dir);
      expect(pluginStatuses(daemonHost).map((status) => status.id)).toEqual(["daemon-plugin"]);
    }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("loads the worked external status bar example", () =>
  Effect.gen(function* () {
    const { host, slots } = yield* makeHost();
    const config = baseConfig({
      plugins: [spec(join(testDir, "../../../../examples/status-bar.tsx"))],
    });

    yield* loadPlugins(config, host, testDir);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["example.status-bar"]);
    expect(slots.declared("bottom", "app")).toBe(true);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("the agent dashboard example stays gated with no AgentAwarenessTag provider", () =>
  Effect.gen(function* () {
    const { host, slots } = yield* makeHost();
    const dir = yield* tempDir;
    const configPath = yield* writeExampleConfig(dir, "agent-dashboard.tsx");
    const config = yield* loadConfig(configPath).pipe(Effect.provide(BunFileSystem.layer));

    yield* loadPlugins(config, host, dirname(configPath));

    // This test's host provides no `AgentAwarenessTag`, and the example
    // injects it for its roster view, so it never activates — the same
    // gating a real client would show with the awareness plugin disabled.
    expect(pluginStatuses(host).map((status) => status.id)).toEqual([]);
    expect(slots.declared("bottom", "app")).toBe(false);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("the agent triage example stays gated with no AgentAwarenessTag provider", () =>
  Effect.gen(function* () {
    const { host, slots } = yield* makeHost();
    const dir = yield* tempDir;
    const configPath = yield* writeExampleConfig(dir, "agent-triage.tsx");
    const config = yield* loadConfig(configPath).pipe(Effect.provide(BunFileSystem.layer));

    yield* loadPlugins(config, host, dirname(configPath));

    expect(pluginStatuses(host).map((status) => status.id)).toEqual([]);
    expect(slots.declared("right", "app")).toBe(false);
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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(baseConfig(), host, join(configHome, "amux"));

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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("reports a plugin with an empty id", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "emptyid.ts", mkPluginSrc("emptyid", "empty-id"));

    const config = baseConfig({ plugins: [spec(join(dir, "emptyid.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- Malformed config defaults ---

testEffect("empty plugins array does nothing", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const { host } = yield* makeHost();

    yield* loadPlugins(baseConfig(), host, dir);

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

    yield* loadPlugins(baseConfig({ plugins: [spec(join(dir, "configured.ts"))] }), host, dir, [
      core,
    ]);

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

    yield* loadPlugins(config, host, dir);

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

    yield* loadPlugins(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("abs-plugin");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

// --- loadPlugins doesn't block host lifecycle ---

testEffect("host continues working after loader finishes", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* writePluginFile(dir, "pre.ts", mkPluginSrc("pre"));

    const config = baseConfig({ plugins: [spec(join(dir, "pre.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPlugins(config, host, dir);
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

    yield* loadPlugins(config, host, dir, [], [], store);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["fake-example"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a configured package with no install is skipped", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const store = join(dir, "store");

    const config = baseConfig({ plugins: [{ package: "absent-plugin", enabled: true }] });
    const { host } = yield* makeHost();

    yield* loadPlugins(config, host, dir, [], [], store);

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

    yield* loadPlugins(config, host, dir, [], [], store);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["present"]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("keeps the previous entry when edited source fails to import", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const entry = yield* writePluginFile(dir, "kept.ts", mkPluginSrc("kept"));
    const config = baseConfig({ plugins: [spec(entry)] });
    const { host } = yield* makeHost();

    const first = yield* loadPlugins(config, host, dir);
    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["kept"]);
    expect(first.failures).toEqual([]);

    yield* writePluginFile(dir, "kept.ts", mkPluginSrc("kept", "throw"));
    const second = yield* loadPlugins(config, host, dir, [], first.entries);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["kept"]);
    expect(second.entries).toEqual(first.entries);
    expect(second.failures).toEqual([expect.objectContaining({ spec: entry })]);
    expect(second.failures[0]?.reason.length).toBeGreaterThan(0);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("keeps the previous entry when edited source fails the compat check", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const fs = yield* FileSystem.FileSystem;
    const entry = yield* writePluginFile(dir, "compat.ts", mkPluginSrc("compat"));
    yield* fs.writeFileString(
      join(dir, "package.json"),
      // Fixture JSON for engines.amux — not a typed Config encode.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      JSON.stringify({ name: "compat-probe", engines: { amux: "^0.1.0" } }),
    );
    const config = baseConfig({ plugins: [spec(entry)] });
    const { host } = yield* makeHost();

    const first = yield* loadPlugins(config, host, dir);
    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["compat"]);

    yield* fs.writeFileString(
      join(dir, "package.json"),
      // Fixture JSON for engines.amux — not a typed Config encode.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      JSON.stringify({ name: "compat-probe", engines: { amux: "^99.0.0" } }),
    );
    const second = yield* loadPlugins(config, host, dir, [], first.entries);

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["compat"]);
    expect(second.entries).toEqual(first.entries);
    expect(second.failures.map((failure) => failure.spec)).toEqual([entry]);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("a reconcile failure fails the load", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const entry = yield* writePluginFile(dir, "collide.ts", mkPluginSrc("amux.consumer.0"));
    const { environment, dispose } = yield* Effect.promise(() => mockRegions());
    cleanupFns.push(dispose);
    const host = yield* createPluginHost({
      ...environment,
      consumers: [
        {
          name: "panel",
          inject: [],
          activate: () => Effect.void,
        },
      ],
    });
    registryEntriesByHost.set(host, environment.registryEntries);

    const result = yield* Effect.result(
      loadPlugins(baseConfig({ plugins: [spec(entry)] }), host, dir),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(PluginReconcileError);
      expect(result.failure.message).toContain("collides with a host-owned consumer");
    }
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
