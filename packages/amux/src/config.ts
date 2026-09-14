// Path.Path-service adoption (replacing node:path across the service layer for
// injectable path handling) is a repo-wide policy decision tracked separately,
// not something to half-apply in one file.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";
import { DEFAULT_LEADER, DEFAULT_PREFIX, type Keys } from "./bindings.ts";
import { type OptionDeltas } from "./options.ts";
import { JsonValueSchema, type JsonValue } from "./effect/AttachProtocol.ts";
import { Config as EffectConfig, Effect, Option, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { PermissionRuleSchema, type PermissionRule } from "./permission.ts";
import { LayoutRuleSchema, type LayoutRule } from "./layout-rules.ts";
import { errorMessage } from "./error-message.ts";

/**
 * One entry in config's `plugins` array, naming a plugin and whether it is
 * active. A path names a plugin file directly (relative paths resolve
 * against the config directory); a package names an npm package installed
 * in the plugin store, with an optional version pin. Bare strings are paths —
 * a package spec is always the object form, so a scoped package name is
 * never mistaken for a relative path.
 */
export type PluginSpec =
  | { readonly path: string; readonly enabled: boolean }
  | { readonly package: string; readonly version?: string; readonly enabled: boolean };

/** The config key a spec is filed under: its path, or its package name. */
export function pluginSpecKey(spec: PluginSpec): string {
  return "package" in spec ? spec.package : spec.path;
}

/**
 * Insert or replace a plugin spec by {@link pluginSpecKey}, enabling it.
 * Shared by `amux plugin add` and scratch promote — one writer shape.
 */
export function upsertPluginSpec(config: Config, spec: PluginSpec): Config {
  const key = pluginSpecKey(spec);
  const index = config.plugins.findIndex((entry) => pluginSpecKey(entry) === key);
  if (index < 0) return { ...config, plugins: [...config.plugins, spec] };
  return {
    ...config,
    plugins: config.plugins.map((entry, at) =>
      at === index ? { ...entry, ...spec, enabled: true } : entry,
    ) as PluginSpec[],
  };
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
  /** Ordered list of user plugins to load. Each entry is a path string, a
   * { path, enabled } object, or a { package, version?, enabled } object
   * naming an npm package in the plugin store. Relative paths resolve
   * against the config directory. Malformed entries are silently skipped. */
  plugins: PluginSpec[];
  /** Standing agent permission policy, in force in every project. Written by
   * hand: what the user approves in a pane is recorded against that project
   * instead, so an approval given in one repository cannot follow an agent into
   * the next. This is where a refusal that should hold everywhere belongs. */
  permissions: PermissionRule[];
  /**
   * Ordered tiling election rules. Each entry names an algorithm id and a
   * `when` condition (optional inclusive non-negative integer
   * `minCols`/`maxCols`/`minRows`/`maxRows`, optional space **name** as
   * `workspace`). The first rule whose condition holds and whose algorithm a
   * plugin registered wins; otherwise `options["behaviour.tilingAlgorithm"]`
   * if registered, else the built-in default. Malformed entries are skipped on
   * load (same silent drop as `permissions`). If two spaces share a name, a
   * `workspace` rule applies to both.
   *
   * @example
   * ```json
   * {
   *   "layoutRules": [
   *     { "algorithm": "default", "when": { "maxCols": 80 } },
   *     { "algorithm": "niri", "when": { "minCols": 81, "workspace": "desk" } }
   *   ]
   * }
   * ```
   */
  layoutRules: LayoutRule[];
}

export const DEFAULT_CONFIG: Config = {
  options: {},
  keys: { prefix: DEFAULT_PREFIX, leader: DEFAULT_LEADER, bindings: {} },
  // Bare amux is tmux with nothing extra loaded: no plugin is active until
  // the user names one, by path or by installed package.
  plugins: [],
  permissions: [],
  layoutRules: [],
};

/**
 * `${XDG_CONFIG_HOME:-~/.config}`. An Effect, not a module-level constant:
 * reading XDG at import time was an Effect.runSync side effect. Callers that
 * need the default roots yield them (same shape as process-plugin/paths.ts).
 */
const xdgConfigHome = EffectConfig.string("XDG_CONFIG_HOME").pipe(
  EffectConfig.orElse(() =>
    EffectConfig.string("HOME").pipe(EffectConfig.map((home) => join(home, ".config"))),
  ),
  EffectConfig.withDefault(join(".", ".config")),
);

export const configDir: Effect.Effect<string> = xdgConfigHome.pipe(Effect.orDie);

export const configPath: Effect.Effect<string> = Effect.map(configDir, (dir) =>
  join(dir, "amux", "config.json"),
);

const KeysSchema = S.Struct({
  // Optional so a pre-rename file ({ leader: mux-chord }) still decodes;
  // {@link decodeConfig} migrates it into prefix + leader.
  prefix: S.optional(JsonValueSchema),
  leader: JsonValueSchema.pipe(S.withDecodingDefaultType(Effect.succeed(DEFAULT_LEADER))),
  localleader: S.optional(JsonValueSchema),
  bindings: S.Record(S.String, JsonValueSchema).pipe(S.withDecodingDefaultType(Effect.succeed({}))),
});

const PluginPathSpecSchema = S.Struct({
  path: S.String.pipe(S.check(S.isMinLength(1))),
  enabled: S.Boolean.pipe(S.withDecodingDefaultType(Effect.succeed(true))),
});
const PluginPackageSpecSchema = S.Struct({
  package: S.String.pipe(S.check(S.isMinLength(1))),
  version: S.optional(S.String.pipe(S.check(S.isMinLength(1)))),
  enabled: S.Boolean.pipe(S.withDecodingDefaultType(Effect.succeed(true))),
});
/** Typed plugin spec — Load / RPC payloads use this, not JsonValue. */
export const PluginSpecSchema = S.Union([PluginPathSpecSchema, PluginPackageSpecSchema]);
const DEFAULT_PLUGINS_JSON: readonly JsonValue[] = [];

/**
 * Daemon → plugin-host Load payload: the plugin specs and the directory
 * relative paths resolve against. Owner: config.ts.
 */
/** Per-Prepare load set. Host directories are fixed at host spawn (env → Effect Config). */
export const PluginHostLoadInputSchema = S.Struct({
  plugins: S.Array(PluginSpecSchema),
});
export type PluginHostLoadInput = typeof PluginHostLoadInputSchema.Type;

const ConfigSchema = S.Struct({
  options: S.Record(S.String, JsonValueSchema).pipe(S.withDecodingDefaultType(Effect.succeed({}))),
  keys: KeysSchema.pipe(
    S.withDecodingDefaultType(
      Effect.succeed({
        prefix: DEFAULT_PREFIX,
        leader: DEFAULT_LEADER,
        bindings: {},
      }),
    ),
  ),
  plugins: S.Array(JsonValueSchema).pipe(
    S.withDecodingDefaultType(Effect.succeed(DEFAULT_PLUGINS_JSON)),
  ),
  permissions: S.Array(JsonValueSchema).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
  layoutRules: S.Array(JsonValueSchema).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
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
    S.decodeSync(ConfigSchema)({}),
  );
  const keys = decoded.keys;
  const nonEmpty = S.String.pipe(S.check(S.makeFilter((value) => value.trim().length > 0)));
  const readString = (value: JsonValue | undefined, fallback: string) =>
    Option.getOrElse(
      Option.flatMap(Option.fromNullishOr(value), (v) => S.decodeUnknownOption(nonEmpty)(v)),
      () => fallback,
    );

  // Pre-rename configs stored the mux chord under `keys.leader` and (briefly)
  // the editor chord under `keys.localleader`. New shape: `prefix` + `leader`.
  const legacy = keys.prefix === undefined;
  const prefix = legacy
    ? readString(keys.leader, DEFAULT_PREFIX)
    : readString(keys.prefix, DEFAULT_PREFIX);
  const leader = legacy
    ? readString(keys.localleader, DEFAULT_LEADER)
    : readString(keys.leader, DEFAULT_LEADER);

  const rewriteToken = (key: string): string => {
    if (!legacy) return key;
    return key.replaceAll("<leader>", "<prefix>").replaceAll("<localleader>", "<leader>");
  };
  const bindings = Object.fromEntries(
    Object.entries(keys.bindings).flatMap(([name, value]) => {
      const entries = S.decodeUnknownOption(S.Array(JsonValueSchema))(value);
      if (Option.isNone(entries)) return [];
      return [
        [
          name,
          entries.value.flatMap((key) => {
            const decoded = S.decodeUnknownOption(S.String.pipe(S.check(S.isMinLength(1))))(key);
            return Option.isSome(decoded) ? [rewriteToken(decoded.value)] : [];
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
  const layoutRules = decoded.layoutRules.flatMap((entry) => {
    const rule = decodeLayoutRule(entry);
    return Option.isSome(rule) ? [rule.value] : [];
  });
  return {
    options: { ...decoded.options },
    keys: { prefix, leader, bindings },
    plugins,
    permissions,
    layoutRules,
  };
}

const decodePermissionRule = S.decodeUnknownOption(PermissionRuleSchema);
const decodeLayoutRule = S.decodeUnknownOption(LayoutRuleSchema);

const decodePluginEntry = (entry: JsonValue): Option.Option<PluginSpec> => {
  const spec = S.decodeUnknownOption(PluginSpecSchema)(entry);
  if (Option.isSome(spec)) return spec;
  return Option.map(
    S.decodeUnknownOption(S.String.pipe(S.check(S.isMinLength(1))))(entry),
    (path) => ({
      path,
      enabled: true,
    }),
  );
};

export const loadConfig = (path?: string): Effect.Effect<Config, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const resolved = path ?? (yield* configPath);
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(resolved);
      if (!exists) return structuredClone(DEFAULT_CONFIG);
      const contents = yield* fs.readFileString(resolved);
      return decodeConfig(yield* S.decodeEffect(S.fromJsonString(JsonValueSchema))(contents));
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Ignoring unreadable config at ${resolved}: ${errorMessage(error)}`).pipe(
          Effect.as(structuredClone(DEFAULT_CONFIG)),
        ),
      ),
    );
  });

export const saveConfig = (
  config: Config,
  path?: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const resolved = path ?? (yield* configPath);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(resolved), { recursive: true });
    // Config is validated field-by-field on read, by design (see decodeConfig's
    // doc comment) rather than through one derived schema for the whole shape;
    // encoding an already-typed Config has no unknown-shape risk to guard against.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    yield* fs.writeFileString(resolved, JSON.stringify(config, null, 2) + "\n");
  });
