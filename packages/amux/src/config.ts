import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_LEADER, type Keys } from "./bindings.ts";
import { type OptionDeltas } from "./options.ts";
import { JsonValueSchema, type JsonValue } from "./effect/AttachProtocol.ts";
import { Option, Schema as S } from "effect";
import { PermissionRuleSchema, type PermissionRule } from "./permission.ts";

export interface PluginSpec {
  readonly path: string;
  readonly enabled: boolean;
}

/**
 * The file, and nothing else.
 *
 * Both halves record only what the user changed: options.ts explains why for
 * settings, and the same rule has always held for bindings. What an option
 * *is* — its type, default, bounds and description — lives in options.ts, so
 * adding one does not touch this module.
 */
export interface Config {
  options: OptionDeltas;
  /** Prefix key and per-command overrides. Only commands the user has actually
   * rebound appear here, so the defaults stay free to change. */
  keys: Keys;
  /** Ordered list of user plugins to load. Each entry is a path string or a
   * { path, enabled } object. Relative paths resolve against the config
   * directory. Malformed entries are silently skipped. */
  plugins: PluginSpec[];
  /** Standing agent permission policy, in force in every project. Written by
   * hand: what the user approves in a pane is recorded against that project
   * instead, so an approval given in one repository cannot follow an agent into
   * the next. This is where a refusal that should hold everywhere belongs. */
  permissions: PermissionRule[];
}

export const DEFAULT_CONFIG: Config = {
  options: {},
  keys: { leader: DEFAULT_LEADER, bindings: {} },
  plugins: [
    { path: "builtin:amux.sidebar", enabled: true },
    { path: "builtin:amux.agent-harness", enabled: true },
    { path: "builtin:amux.notifications", enabled: true },
  ],
  permissions: [],
};

const CONFIG_DIR = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config");
export const CONFIG_PATH = join(CONFIG_DIR, "amux", "config.json");

const KeysSchema = S.Struct({
  leader: S.optionalWith(JsonValueSchema, { default: () => DEFAULT_LEADER }),
  bindings: S.optionalWith(S.Record({ key: S.String, value: JsonValueSchema }), {
    default: () => ({}),
  }),
});

const PluginSpecSchema = S.Struct({
  path: S.String.pipe(S.minLength(1)),
  enabled: S.optionalWith(S.Boolean, { default: () => true }),
});
const DEFAULT_PLUGINS_JSON: readonly JsonValue[] = DEFAULT_CONFIG.plugins.map(
  (plugin): JsonValue => ({ path: plugin.path, enabled: plugin.enabled }),
);

const ConfigSchema = S.Struct({
  options: S.optionalWith(S.Record({ key: S.String, value: JsonValueSchema }), {
    default: () => ({}),
  }),
  keys: S.optionalWith(KeysSchema, {
    default: () => ({ leader: DEFAULT_LEADER, bindings: {} }),
  }),
  plugins: S.optionalWith(S.Array(JsonValueSchema), { default: () => DEFAULT_PLUGINS_JSON }),
  permissions: S.optionalWith(S.Array(JsonValueSchema), { default: () => [] }),
});

/**
 * Read a loaded file into a Config.
 *
 * Option values are NOT validated here. They are stored as written and resolved
 * against the table on read (resolveOptions), which is what lets an entry
 * belonging to a name this build does not know survive a save instead of being
 * dropped by the decoder that failed to recognise it.
 */
export function decodeConfig(loaded: JsonValue): Config {
  const decoded = Option.getOrElse(S.decodeUnknownOption(ConfigSchema)(loaded), () =>
    S.decodeUnknownSync(ConfigSchema)({}),
  );
  const keys = decoded.keys;
  const leader = Option.getOrElse(
    S.decodeUnknownOption(S.String.pipe(S.filter((value) => value.trim().length > 0)))(keys.leader),
    () => DEFAULT_LEADER,
  );
  const bindings = Object.fromEntries(
    Object.entries(keys.bindings).flatMap(([name, value]) => {
      const entries = S.decodeUnknownOption(S.Array(JsonValueSchema))(value);
      if (Option.isNone(entries)) return [];
      return [
        [
          name,
          entries.value.flatMap((key) => {
            const decoded = S.decodeUnknownOption(S.String.pipe(S.minLength(1)))(key);
            return Option.isSome(decoded) ? [decoded.value] : [];
          }),
        ],
      ];
    }),
  );
  const plugins = decoded.plugins.flatMap((entry) => {
    const plugin = decodePluginEntry(entry);
    if (Option.isNone(plugin)) return [];
    return [plugin.value];
  });
  const permissions = decoded.permissions.flatMap((entry) => {
    const rule = decodePermissionRule(entry);
    return Option.isSome(rule) ? [rule.value] : [];
  });
  return {
    options: { ...decoded.options },
    keys: { leader, bindings },
    plugins: mergeDefaultPlugins(plugins),
    permissions,
  };
}

const decodePermissionRule = S.decodeUnknownOption(PermissionRuleSchema);

const decodePluginEntry = (entry: JsonValue): Option.Option<PluginSpec> => {
  const spec = S.decodeUnknownOption(PluginSpecSchema)(entry);
  if (Option.isSome(spec)) return spec;
  return Option.map(S.decodeUnknownOption(S.String.pipe(S.minLength(1)))(entry), (path) => ({
    path,
    enabled: true,
  }));
};

/** New bundled plugins are enabled for existing configs unless the user has an
 * explicit entry for that path. An explicit disabled entry remains authoritative. */
function mergeDefaultPlugins(saved: PluginSpec[]): PluginSpec[] {
  const byPath = new Map(saved.map((plugin) => [plugin.path, plugin]));
  return [
    ...DEFAULT_CONFIG.plugins.map((plugin) => byPath.get(plugin.path) ?? structuredClone(plugin)),
    ...saved.filter((plugin) => !DEFAULT_CONFIG.plugins.some((item) => item.path === plugin.path)),
  ];
}

export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return structuredClone(DEFAULT_CONFIG);
    return decodeConfig(await file.json());
  } catch (error) {
    console.warn(
      `Ignoring unreadable config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(config: Config, path = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
}
