import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, decodeConfig, loadConfig, saveConfig } from "./config.ts";
import { resolveOptions } from "./options.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amux-config-"));
  temporaryDirectories.push(directory);
  return join(directory, "config.json");
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

test("a changed config survives save and load", async () => {
  const path = await temporaryConfig();
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

  await saveConfig(config, path);
  expect(await loadConfig(path)).toEqual(config);
});

test("invalid JSON falls back without throwing", async () => {
  const path = await temporaryConfig();
  await Bun.write(path, "{not json");

  await expect(loadConfig(path)).resolves.toEqual(DEFAULT_CONFIG);
});
