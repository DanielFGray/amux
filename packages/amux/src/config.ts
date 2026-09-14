// Path.Path-service adoption (replacing node:path across the service layer for
// injectable path handling) is a repo-wide policy decision tracked separately,
// not something to half-apply in one file.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";
import { DEFAULT_LEADER, DEFAULT_PREFIX, type Keys } from "./bindings.ts";
import {
  OptionDeltasSchema,
  type OptionDeltas,
} from "./options.ts";
import { Config as EffectConfig, Effect, Option, Schema as S, SchemaGetter } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { PermissionRuleSchema, type PermissionRule } from "./permission.ts";
import { LayoutRuleSchema, type LayoutRule } from "./layout-rules.ts";
import { errorMessage } from "./error-message.ts";
import { NonEmptyString } from "./schema-primitives.ts";
import { softArray } from "./soft-schema.ts";

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

/**
 * Decode an array item with its owner Schema; a failure becomes a skipped
 * entry rather than failing the whole array (hand-edited config tolerance).
 * See soft-schema.ts.
 */

/** Accept any string; wrong types become empty so migration can apply defaults. */
const LooseString = S.String.pipe(
  S.catchDecoding(() => Effect.succeed(Option.some(""))),
);

const BindingSequenceSchema = softArray(NonEmptyString);

const RawKeysSchema = S.Struct({
  // Optional so a pre-rename file ({ leader: mux-chord }) still decodes;
  // KeysSchema migrates it into prefix + leader.
  prefix: S.optionalKey(LooseString),
  leader: LooseString.pipe(S.withDecodingDefaultType(Effect.succeed(""))),
  localleader: S.optionalKey(LooseString),
  bindings: S.Record(S.String, BindingSequenceSchema).pipe(
    S.withDecodingDefaultType(Effect.succeed({})),
  ),
});

type RawKeys = typeof RawKeysSchema.Type;

function nonEmptyChord(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim().length > 0 ? value : fallback;
}

const KeysDecodedSchema = S.Struct({
  prefix: S.String,
  leader: S.String,
  bindings: S.Record(S.String, S.Array(S.String)),
});

const KeysSchema = RawKeysSchema.pipe(
  S.decodeTo(KeysDecodedSchema, {
    decode: SchemaGetter.transform((keys: RawKeys) => {
      const legacy = keys.prefix === undefined;
      const prefix = legacy
        ? nonEmptyChord(keys.leader, DEFAULT_PREFIX)
        : nonEmptyChord(keys.prefix, DEFAULT_PREFIX);
      const leader = legacy
        ? nonEmptyChord(keys.localleader, DEFAULT_LEADER)
        : nonEmptyChord(keys.leader, DEFAULT_LEADER);
      const rewriteToken = (key: string): string => {
        if (!legacy) return key;
        return key.replaceAll("<leader>", "<prefix>").replaceAll("<localleader>", "<leader>");
      };
      const bindings = Object.fromEntries(
        Object.entries(keys.bindings).map(([name, sequence]) => [
          name,
          sequence.map(rewriteToken),
        ]),
      );
      return { prefix, leader, bindings };
    }),
    encode: SchemaGetter.transform((keys: typeof KeysDecodedSchema.Type) => ({
      prefix: keys.prefix,
      leader: keys.leader,
      bindings: Object.fromEntries(
        Object.entries(keys.bindings).map(([name, sequence]) => [name, [...sequence]]),
      ),
    })),
  }),
);

const PluginPathSpecSchema = S.Struct({
  path: S.String.pipe(S.check(S.isMinLength(1))),
  enabled: S.Boolean.pipe(S.withDecodingDefaultType(Effect.succeed(true))),
});
const PluginPackageSpecSchema = S.Struct({
  package: S.String.pipe(S.check(S.isMinLength(1))),
  version: S.optional(S.String.pipe(S.check(S.isMinLength(1)))),
  enabled: S.Boolean.pipe(S.withDecodingDefaultType(Effect.succeed(true))),
});
/** Typed plugin spec — Load / RPC payloads use this. */
export const PluginSpecSchema = S.Union([PluginPathSpecSchema, PluginPackageSpecSchema]);

/** Bare path string in the config file → path spec with enabled true. */
const BarePluginPathSchema = NonEmptyString.pipe(
  S.decodeTo(PluginPathSpecSchema, {
    decode: SchemaGetter.transform((path: string) => ({ path, enabled: true })),
    encode: SchemaGetter.transform((spec: typeof PluginPathSpecSchema.Encoded) => spec.path),
  }),
);

const PluginConfigEntrySchema = S.Union([PluginSpecSchema, BarePluginPathSchema]);

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
  options: OptionDeltasSchema.pipe(S.withDecodingDefaultType(Effect.succeed({}))),
  keys: KeysSchema.pipe(
    S.withDecodingDefaultType(
      Effect.succeed({
        prefix: DEFAULT_PREFIX,
        leader: DEFAULT_LEADER,
        bindings: {},
      }),
    ),
  ),
  plugins: softArray(PluginConfigEntrySchema).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
  permissions: softArray(PermissionRuleSchema).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
  layoutRules: softArray(LayoutRuleSchema).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
});

/** Config file ↔ {@link Config}: one Schema, decode on load and encode on save. */
export const ConfigFileSchema = S.fromJsonString(ConfigSchema, { space: 2 });

/**
 * Read a config file's JSON text into a Config.
 *
 * Option values are NOT judged against their kind Schema here. They are stored
 * as written and resolved against the table on read (resolveOptions), which is
 * what lets an entry belonging to a name this build does not know survive a
 * save instead of being dropped by the decoder that failed to recognise it.
 */
export function decodeConfig(contents: string): Config {
  return Option.getOrElse(Option.map(S.decodeOption(ConfigFileSchema)(contents), toConfig), () =>
    structuredClone(DEFAULT_CONFIG),
  );
}

function toConfig(decoded: typeof ConfigFileSchema.Type): Config {
  return {
    options: { ...decoded.options },
    keys: {
      prefix: decoded.keys.prefix,
      leader: decoded.keys.leader,
      bindings: Object.fromEntries(
        Object.entries(decoded.keys.bindings).map(([name, sequence]) => [name, [...sequence]]),
      ),
    },
    plugins: [...decoded.plugins],
    permissions: [...decoded.permissions],
    layoutRules: [...decoded.layoutRules],
  };
}

export const loadConfig = (path?: string): Effect.Effect<Config, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const resolved = path ?? (yield* configPath);
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(resolved);
      if (!exists) return structuredClone(DEFAULT_CONFIG);
      const contents = yield* fs.readFileString(resolved);
      return toConfig(yield* S.decodeEffect(ConfigFileSchema)(contents));
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
    // Config is already the Schema's Type; encode failure would be a bug in
    // ConfigSchema, not a platform I/O error callers can recover from.
    const encoded = yield* S.encodeEffect(ConfigFileSchema)(config).pipe(Effect.orDie);
    yield* fs.writeFileString(resolved, encoded.endsWith("\n") ? encoded : `${encoded}\n`);
  });
