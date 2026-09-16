// Path.Path-service adoption is a repo-wide policy decision tracked separately.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Config as EffectConfig, Effect, Option } from "effect";
import * as FileSystem from "effect/FileSystem";
import { command, CommandError, CurrentInvocation, type Commands } from "../commands.ts";
import { saveConfig, upsertPluginSpec, type Config, type PluginSpec } from "../config.ts";
import { processPluginPathComponent } from "../process-plugin/paths.ts";

/**
 * In-session authored plugins — the addendum's scratch → managed directory
 * probe before committing to a non-file source authority.
 *
 * Layout mirrors `pluginRoot` (hot.ts): entry `<stem>.ts`, companions under
 * `<stem>/`. State home, not the npm plugin store: these are experiments, not
 * installed packages.
 *
 *   $XDG_STATE_HOME/amux/scratch/<stem>.ts
 *   $XDG_STATE_HOME/amux/scratch/<stem>/…
 *
 * The scratch directory is the list: every `<stem>.ts` is an active scratch
 * plugin. No separate manifest — that would store what the directory already holds.
 */
const xdgStateHome = EffectConfig.String("XDG_STATE_HOME").pipe(
  EffectConfig.orElse(() =>
    EffectConfig.String("HOME").pipe(EffectConfig.map((home) => join(home, ".local", "state"))),
  ),
  EffectConfig.withDefault(join(".", ".local", "state")),
);

export const pluginScratchDir: Effect.Effect<string> = Effect.map(xdgStateHome, (home) =>
  join(home, "amux", "scratch"),
).pipe(Effect.orDie);

/** Filesystem stem for a scratch plugin id (same encoding as process plugins). */
export const scratchStem = (id: string): string => processPluginPathComponent(id);

/** Reverse {@link scratchStem} for stems that only used the safe charset + %XX. */
export const scratchIdFromStem = (stem: string): string => {
  let out = "";
  for (let i = 0; i < stem.length;) {
    if (stem[i] === "%" && i + 2 < stem.length) {
      const code = Number.parseInt(stem.slice(i + 1, i + 3), 16);
      if (!Number.isNaN(code)) {
        out += String.fromCharCode(code);
        i += 3;
        continue;
      }
    }
    const ch = stem[i];
    if (ch === undefined) break;
    out += ch;
    i += 1;
  }
  return out;
};

export const scratchEntryPath = (id: string, scratchDir: string): string =>
  join(scratchDir, `${scratchStem(id)}.ts`);

export const scratchCompanionDir = (id: string, scratchDir: string): string =>
  join(scratchDir, scratchStem(id));

/** Write source to the scratch entry. Does not import or activate. */
export const materializeScratch = (
  id: string,
  source: string,
  scratchDir: string,
): Effect.Effect<URL, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(scratchDir, { recursive: true })
      .pipe(Effect.mapError((error) => `cannot create scratch dir: ${String(error)}`));
    const entry = scratchEntryPath(id, scratchDir);
    yield* fs
      .writeFileString(entry, source)
      .pipe(Effect.mapError((error) => `cannot write scratch '${id}': ${String(error)}`));
    return pathToFileURL(entry);
  });

/** Every active scratch plugin as a path spec (enabled). The directory is the list. */
export const listScratchSpecs = (
  scratchDir: string,
): Effect.Effect<readonly PluginSpec[], never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs
      .readDirectory(scratchDir)
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    const specs: PluginSpec[] = [];
    for (const name of names) {
      if (!name.endsWith(".ts")) continue;
      const full = join(scratchDir, name);
      const info = yield* fs.stat(full).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(info) || info.value.type !== "File") continue;
      specs.push({ path: full, enabled: true });
    }
    return specs;
  });

/** Remove a scratch entry and its companion directory after promote. */
export const removeScratch = (
  id: string,
  scratchDir: string,
): Effect.Effect<void, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entry = scratchEntryPath(id, scratchDir);
    yield* fs.remove(entry).pipe(Effect.orElseSucceed(() => undefined));
    const companions = scratchCompanionDir(id, scratchDir);
    yield* fs.remove(companions, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
  });

/**
 * Paste the top paste buffer into a pane.
 * Yank already pushed the selection onto the daemon buffer stack; this is the
 * other half of "send selection to my review agent." Uses buffer.paste (not
 * send-keys) so arbitrary text — quotes, newlines — survives.
 */
export const sendTopBufferToPane = (
  run: Commands["run"],
  pane?: string,
): Effect.Effect<void, CommandError, CurrentInvocation> =>
  Effect.gen(function* () {
    const inv = yield* CurrentInvocation;
    if (pane !== undefined) yield* run(command("pane.select", { pane }), inv);
    yield* run(command("buffer.paste", {}), inv);
  });

/**
 * Source for the live-image demo plugin: registers `send-selection`, which
 * pastes the top buffer into an optional pane (default: focused).
 */
export const sendSelectionScratchSource = (id: string, defaultPane?: string): string => {
  const paneLiteral = defaultPane === undefined ? "undefined" : JSON.stringify(defaultPane);
  return `import { Effect, Schema as S } from "effect";
import { definePlugin, CommandsTag, registerCommand, sendTopBufferToPane } from "amux";

export default definePlugin({
  id: ${JSON.stringify(id)},
  inject: [CommandsTag],
  effect: () =>
    Effect.gen(function* () {
      const commands = yield* CommandsTag;
      const defaultPane = ${paneLiteral} as string | undefined;
      yield* registerCommand(
        "send-selection",
        { pane: S.optional(S.String) },
        {
          desc: "send the top paste buffer to a pane",
          group: "scratch",
          target: "server",
          exposure: "human",
        },
        (args) => (args.pane !== undefined ? [args.pane] : []),
        (args) => sendTopBufferToPane(commands.run, args.pane ?? defaultPane),
      );
    }),
});
`;
};

/** Path string for command results / agent-facing responses. */
export const scratchEntryFilePath = (entryUrl: URL): string => fileURLToPath(entryUrl);

/**
 * Relative config path for a promoted plugin (`plugins/<stem>.ts`).
 * Resolves against the config directory — the same discovery root
 * `loader.discoveredPlugins` already scans.
 */
export const managedPluginSpecPath = (id: string): string => `plugins/${scratchStem(id)}.ts`;

export const managedPluginEntryPath = (id: string, configDir: string): string =>
  join(configDir, managedPluginSpecPath(id));

export interface PromoteScratchResult {
  readonly plugin: string;
  readonly path: string;
  readonly config: Config;
}

/** Managed companion directory for a promoted plugin (`plugins/<stem>/`). */
export const managedPluginCompanionDir = (id: string, configDir: string): string =>
  join(configDir, "plugins", scratchStem(id));

/**
 * Persist a scratch experiment into the managed plugin location and config
 * `plugins` array, then delete the scratch entry. Moves `<stem>/` companions
 * beside the managed entry so both halves stay under the file-spec rule.
 * Host Prepare loads it through the ordinary path loader afterward.
 */
export const promoteScratch = (
  id: string,
  options: {
    readonly config: Config;
    readonly configDir: string;
    readonly configPath: string;
    readonly scratchDir: string;
    readonly source?: string;
  },
): Effect.Effect<PromoteScratchResult, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratchPath = scratchEntryPath(id, options.scratchDir);
    const source =
      options.source ??
      (yield* fs
        .readFileString(scratchPath)
        .pipe(Effect.mapError((error) => `cannot read scratch '${id}': ${String(error)}`)));
    const pluginsDir = join(options.configDir, "plugins");
    yield* fs
      .makeDirectory(pluginsDir, { recursive: true })
      .pipe(Effect.mapError((error) => `cannot create managed plugins dir: ${String(error)}`));
    const absolute = managedPluginEntryPath(id, options.configDir);
    const relative = managedPluginSpecPath(id);
    yield* fs
      .writeFileString(absolute, source)
      .pipe(Effect.mapError((error) => `cannot write managed plugin '${id}': ${String(error)}`));
    const scratchCompanions = scratchCompanionDir(id, options.scratchDir);
    const managedCompanions = managedPluginCompanionDir(id, options.configDir);
    const hasCompanions = yield* fs
      .exists(scratchCompanions)
      .pipe(Effect.orElseSucceed(() => false));
    if (hasCompanions) {
      yield* fs
        .remove(managedCompanions, { recursive: true })
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* fs
        .rename(scratchCompanions, managedCompanions)
        .pipe(
          Effect.mapError(
            (error) => `cannot move scratch companions for '${id}': ${String(error)}`,
          ),
        );
    }
    const next = upsertPluginSpec(options.config, { path: relative, enabled: true });
    yield* saveConfig(next, options.configPath).pipe(
      Effect.mapError((error) => `cannot save config: ${String(error)}`),
    );
    yield* removeScratch(id, options.scratchDir);
    return { plugin: id, path: relative, config: next };
  });

/**
 * Upsert `enabled` on a config plugin spec by path or package key and save.
 * Scratch-only plugins with no config row fail — no `.disabled` dir or config special case.
 */
export const setPluginEnabledInConfig = (
  idOrKey: string,
  enabled: boolean,
  options: {
    readonly config: Config;
    readonly configPath: string;
  },
): Effect.Effect<Config, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const current = options.config.plugins.find((entry) => {
      if ("package" in entry) return entry.package === idOrKey;
      return entry.path === idOrKey || entry.path.endsWith(`/${idOrKey}`);
    });
    if (current === undefined) {
      return yield* Effect.fail(`plugin '${idOrKey}' has no config entry`);
    }
    const nextSpec = { ...current, enabled };
    const key = "package" in current ? current.package : current.path;
    const plugins = options.config.plugins.map((entry) =>
      ("package" in entry ? entry.package : entry.path) === key ? nextSpec : entry,
    );
    const next = { ...options.config, plugins };
    yield* saveConfig(next, options.configPath).pipe(
      Effect.mapError((error) => `cannot save config: ${String(error)}`),
    );
    return next;
  });
