import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Scope } from "effect";
import { createPluginHost, type PluginEnvironment, type PluginHost } from "./host.ts";
import { loadPluginsFromConfig as loadConfiguredPlugins } from "./loader.ts";
import { testPluginEnvironment, type TestPluginEnvironment } from "./test-environment.ts";
import { definePlugin, type PluginDefinition } from "./types.ts";
import type { Config, PluginSpec } from "../config.ts";
import { decodeConfig, loadConfig } from "../config.ts";
import { testEffect } from "../test-effect.ts";
import type { Regions } from "../ui/regions.tsx";
import { createTestRenderer } from "@opentui/core/testing";

const testDir = fileURLToPath(new URL(".", import.meta.url));

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

const cleanupFns: (() => void)[] = [];
const registryEntriesByHost = new WeakMap<PluginHost, readonly PluginDefinition[]>();
const pluginStatuses = (host: PluginHost) =>
  host.status().filter((status) => !status.id.startsWith("amux.registry."));
afterEach(() => {
  for (const fn of cleanupFns.splice(0)) fn();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(testDir, ".test-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function writePluginFile(dir: string, name: string, content: string): Promise<string> {
  const fp = join(dir, name);
  await writeFile(fp, content);
  return fp;
}

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
) =>
  loadConfiguredPlugins(config, host, configDir, [
    ...(registryEntriesByHost.get(host) ?? []),
    ...entries,
  ]);

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

async function writeExampleConfig(dir: string, example: string): Promise<string> {
  const path = join(dir, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      plugins: [
        { path: "builtin:amux.agent-awareness", enabled: false },
        { path: "builtin:amux.sidebar", enabled: false },
        { path: "builtin:amux.agent-harness", enabled: false },
        { path: "builtin:amux.notifications", enabled: false },
        { path: join(testDir, "../../../../examples", example), enabled: true },
      ],
    }),
  );
  return path;
}

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
      return `${preamble}\nexport default { apiVersion: "1", activate: () => Effect.void };`;
    case "empty-id":
      return `${preamble}\nexport default { id: "", apiVersion: "1", activate: () => Effect.void };`;
    case "no-apiVersion":
      return `${preamble}\nexport default { id: "${id}", activate: () => Effect.void };`;
    case "no-activate":
      return `export default { id: "${id}", apiVersion: "1" };`;
    case "throw":
      return `throw new Error("syntax error");`;
    default:
      return `${preamble}\nexport default definePlugin({ id: "${id}", apiVersion: "1", effect: () => Effect.void });`;
  }
}

// --- Happy path ---

testEffect("loads a valid plugin", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(dir, "my-plugin.ts", mkPluginSrc("my-plugin")));

    const config = baseConfig({ plugins: [spec(join(dir, "my-plugin.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("my-plugin");
  }),
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
  }),
);

testEffect("loads the agent dashboard example through the config loader", () =>
  Effect.gen(function* () {
    const { host, regions } = yield* makeHost();
    const dir = yield* Effect.promise(() => tempDir());
    const configPath = yield* Effect.promise(() => writeExampleConfig(dir, "agent-dashboard.tsx"));
    const config = yield* Effect.promise(() => loadConfig(configPath));

    yield* loadPluginsFromConfig(config, host, dirname(configPath));

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["example.agent-dashboard"]);
    expect(regions.declared("bottom", "app")).toBe(true);
  }),
);

testEffect("loads the agent triage example through the config loader", () =>
  Effect.gen(function* () {
    const { host, regions } = yield* makeHost();
    const dir = yield* Effect.promise(() => tempDir());
    const configPath = yield* Effect.promise(() => writeExampleConfig(dir, "agent-triage.tsx"));
    const config = yield* Effect.promise(() => loadConfig(configPath));

    yield* loadPluginsFromConfig(config, host, dirname(configPath));

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["example.agent-triage"]);
    expect(regions.declared("right", "app")).toBe(true);
  }),
);

testEffect("loads multiple plugins in order", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(dir, "a.ts", mkPluginSrc("a")));
    yield* Effect.promise(() => writePluginFile(dir, "b.ts", mkPluginSrc("b")));

    const config = baseConfig({
      plugins: [spec(join(dir, "a.ts")), spec(join(dir, "b.ts"))],
    });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    const ids = pluginStatuses(host)
      .map((s) => s.id)
      .sort();
    expect(ids).toEqual(["a", "b"]);
  }),
);

testEffect("discovers plugins in the config directory's plugins/ subdirectory", () =>
  Effect.gen(function* () {
    const configHome = yield* Effect.promise(() => tempDir());
    const pluginDir = join(configHome, "amux", "plugins");
    yield* Effect.promise(() => mkdir(pluginDir, { recursive: true }));
    yield* Effect.promise(() =>
      writePluginFile(pluginDir, "discovered.ts", mkPluginSrc("discovered")),
    );
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(baseConfig(), host, join(configHome, "amux"));

    expect(pluginStatuses(host).map((status) => status.id)).toEqual(["discovered"]);
  }),
);

// --- Relative paths ---

testEffect("resolves relative paths against configDir", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(dir, "rel.ts", mkPluginSrc("rel-plugin")));

    const config = baseConfig({ plugins: [spec("rel.ts")] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("rel-plugin");
  }),
);

// --- file:// URLs ---

testEffect("resolves file:// URLs to paths", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    const fp = yield* Effect.promise(() =>
      writePluginFile(dir, "url.ts", mkPluginSrc("url-plugin")),
    );
    const urlSpec = spec("file://" + fp);

    const config = baseConfig({ plugins: [urlSpec] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("url-plugin");
  }),
);

// --- enabled / disabled ---

testEffect("skips disabled plugins", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(dir, "enabled.ts", mkPluginSrc("enabled")));
    yield* Effect.promise(() => writePluginFile(dir, "disabled.ts", mkPluginSrc("disabled")));

    const config = baseConfig({
      plugins: [spec(join(dir, "enabled.ts")), spec(join(dir, "disabled.ts"), false)],
    });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("enabled");
  }),
);

// --- One bad plugin does not block others ---

testEffect("one bad plugin does not block the next", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(dir, "bad.ts", mkPluginSrc("bad", "no-default")));
    yield* Effect.promise(() => writePluginFile(dir, "good.ts", mkPluginSrc("good")));

    const config = baseConfig({
      plugins: [spec(join(dir, "bad.ts")), spec(join(dir, "good.ts"))],
    });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    const ids = pluginStatuses(host).map((s) => s.id);
    expect(ids).toEqual(["good"]);
  }),
);

testEffect("a plugin that throws on import does not block others", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(dir, "crash.ts", mkPluginSrc("crash", "throw")));
    yield* Effect.promise(() => writePluginFile(dir, "ok.ts", mkPluginSrc("ok")));

    const config = baseConfig({
      plugins: [spec(join(dir, "crash.ts")), spec(join(dir, "ok.ts"))],
    });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("ok");
  }),
);

// --- Validation: missing default export ---

testEffect("reports a plugin with no default export", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() =>
      writePluginFile(dir, "nodefault.ts", mkPluginSrc("nodefault", "no-default")),
    );

    const config = baseConfig({ plugins: [spec(join(dir, "nodefault.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }),
);

// --- Validation: null default export ---

testEffect("reports a plugin with a null default export", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() =>
      writePluginFile(dir, "null.ts", mkPluginSrc("null", "null-default")),
    );

    const config = baseConfig({ plugins: [spec(join(dir, "null.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }),
);

// --- Validation: missing or empty id ---

testEffect("reports a plugin with no id field", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(dir, "noid.ts", mkPluginSrc("noid", "no-id")));

    const config = baseConfig({ plugins: [spec(join(dir, "noid.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }),
);

testEffect("reports a plugin with an empty id", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() =>
      writePluginFile(dir, "emptyid.ts", mkPluginSrc("emptyid", "empty-id")),
    );

    const config = baseConfig({ plugins: [spec(join(dir, "emptyid.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }),
);

// --- Validation: missing apiVersion ---

testEffect("reports a plugin with no apiVersion", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() =>
      writePluginFile(dir, "noapi.ts", mkPluginSrc("noapi", "no-apiVersion")),
    );

    const config = baseConfig({ plugins: [spec(join(dir, "noapi.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }),
);

// --- Validation: missing activation function ---

testEffect("reports a plugin with no activation function", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() =>
      writePluginFile(dir, "noeff.ts", mkPluginSrc("noeff", "no-activate")),
    );

    const config = baseConfig({ plugins: [spec(join(dir, "noeff.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }),
);

// --- Missing file ---

testEffect("handles a missing file gracefully", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    const missing = join(dir, "does-not-exist.ts");

    const config = baseConfig({ plugins: [spec(missing)] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }),
);

// --- Malformed config defaults ---

testEffect("empty plugins array does nothing", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(baseConfig(), host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }),
);

testEffect("reconciles core and configured entries as one configuration", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(dir, "configured.ts", mkPluginSrc("configured")));
    const { host } = yield* makeHost();
    const core = definePlugin({
      id: "amux.windows",
      apiVersion: "1",
      effect: () => Effect.void,
    });

    yield* loadPluginsFromConfig(
      baseConfig({ plugins: [spec(join(dir, "configured.ts"))] }),
      host,
      dir,
      [core],
    );

    expect(pluginStatuses(host).map((status) => status.id).sort()).toEqual([
      "amux.windows",
      "configured",
    ]);
  }),
);

// --- Path traversal prevention ---

testEffect("relative paths that escape configDir are rejected", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());

    const config = baseConfig({ plugins: [spec("../other/plugin.ts")] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(0);
  }),
);

// --- Explicit absolute paths are allowed ---

testEffect("absolute paths outside configDir are allowed", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    const other = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(other, "abs.ts", mkPluginSrc("abs-plugin")));

    const config = baseConfig({ plugins: [spec(join(other, "abs.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);

    expect(pluginStatuses(host).length).toBe(1);
    expect(pluginStatuses(host)[0]!.id).toBe("abs-plugin");
  }),
);

// --- loadPluginsFromConfig doesn't block host lifecycle ---

testEffect("host continues working after loader finishes", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => tempDir());
    yield* Effect.promise(() => writePluginFile(dir, "pre.ts", mkPluginSrc("pre")));

    const config = baseConfig({ plugins: [spec(join(dir, "pre.ts"))] });
    const { host } = yield* makeHost();

    yield* loadPluginsFromConfig(config, host, dir);
    yield* host.add(
      definePlugin({
        id: "post",
        apiVersion: "1",
        effect: () => Effect.void,
      }),
    );

    expect(
      pluginStatuses(host)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["post", "pre"]);
  }),
);

// --- Decode config preserves plugins ---

test("decodeConfig preserves valid plugin specs", () => {
  const config = decodeConfig({
    plugins: [
      "./relative.ts",
      "/absolute/path.ts",
      { path: "/with/options.ts", enabled: true },
      { path: "/disabled.ts", enabled: false },
      "",
      null,
      42,
      { enabled: true },
      { path: 123 },
    ],
  });

  expect(config.plugins).toEqual([
    { path: "builtin:amux.agent-awareness", enabled: true },
    { path: "builtin:amux.sidebar", enabled: true },
    { path: "builtin:amux.agent-harness", enabled: true },
    { path: "builtin:amux.notifications", enabled: true },
    { path: "./relative.ts", enabled: true },
    { path: "/absolute/path.ts", enabled: true },
    { path: "/with/options.ts", enabled: true },
    { path: "/disabled.ts", enabled: false },
  ]);
});
