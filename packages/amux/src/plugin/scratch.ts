// Path.Path-service adoption is a repo-wide policy decision tracked separately.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Config as EffectConfig, Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import { command, CommandError, CurrentInvocation, type Commands } from "../commands.ts";
import { saveConfig, upsertPluginSpec, type Config } from "../config.ts";
import { hotImport } from "./hot.ts";
import type { PluginEntry } from "./loader.ts";
import type { PluginReloader } from "./reloader.ts";
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
 * Paths are Effects, not module-level constants: reading XDG at import time
 * was an Effect.runSync side effect. Callers that need the default scratch
 * root yield it.
 */
const xdgStateHome = EffectConfig.string("XDG_STATE_HOME").pipe(
  EffectConfig.orElse(() =>
    EffectConfig.string("HOME").pipe(EffectConfig.map((home) => join(home, ".local", "state"))),
  ),
  EffectConfig.withDefault(join(".", ".local", "state")),
);

export const pluginScratchDir: Effect.Effect<string> = Effect.map(xdgStateHome, (home) =>
  join(home, "amux", "scratch"),
).pipe(Effect.orDie);

/** Filesystem stem for a scratch plugin id (same encoding as process plugins). */
export const scratchStem = (id: string): string => processPluginPathComponent(id);

export const scratchEntryPath = (id: string, scratchDir: string): string =>
  join(scratchDir, `${scratchStem(id)}.ts`);

/** Write source to the scratch entry. Does not import or activate. */
export const materializeScratch = (
  id: string,
  source: string,
  scratchDir?: string,
): Effect.Effect<URL, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const dir = scratchDir ?? (yield* pluginScratchDir);
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.mapError((error) => `cannot create scratch dir: ${String(error)}`));
    const entry = scratchEntryPath(id, dir);
    yield* fs
      .writeFileString(entry, source)
      .pipe(Effect.mapError((error) => `cannot write scratch '${id}': ${String(error)}`));
    return pathToFileURL(entry);
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
        (args) => sendTopBufferToPane(commands.run, args.pane ?? defaultPane),
      );
    }),
});
`;
};

/**
 * Materialize source and bring it into the running reloader.
 *
 * First eval adopts (host.add + reloader tracking). Later evals overwrite the
 * same entry path and reload — the existing commit-or-rollback transaction.
 * The `definePlugin` id inside the source must equal `id`.
 */
export const evalScratch = (
  reloader: PluginReloader,
  id: string,
  source: string,
  scratchDir?: string,
): Effect.Effect<PluginEntry, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const dir = scratchDir ?? (yield* pluginScratchDir);
    const entryUrl = yield* materializeScratch(id, source, dir);
    if (reloader.reloadable().includes(id)) {
      yield* reloader.reload(id, { disk: true }).pipe(
        Effect.mapError(
          (error) => `${error} (last good generation of '${id}' kept running)`,
        ),
      );
      const current = reloader.get(id);
      if (!current) return yield* Effect.fail(`plugin '${id}' vanished after reload`);
      return current;
    }
    const definition = yield* hotImport(entryUrl).pipe(
      Effect.mapError((error) => `scratch '${id}' did not import: ${error}`),
    );
    if (definition.id !== id) {
      return yield* Effect.fail(
        `scratch id '${id}' does not match definePlugin id '${definition.id}'`,
      );
    }
    const entry: PluginEntry = { id, source: entryUrl, definition };
    yield* reloader.adopt(entry).pipe(
      Effect.mapError((error) => `scratch '${id}' did not activate: ${error}`),
    );
    return entry;
  });

/** Path string for command results / agent-facing responses. */
export const scratchEntryFilePath = (entry: PluginEntry): string => fileURLToPath(entry.source);

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

/**
 * Persist a live scratch experiment into the managed plugin location and
 * config `plugins` array so a fresh start loads it through the ordinary
 * path loader — no special-cased scratch load on restart.
 *
 * Source comes from the reloader's tracked entry (or an explicit override).
 * Writes via {@link saveConfig} / {@link upsertPluginSpec} — same writer as
 * settings and `amux plugin add`.
 */
export const promoteScratch = (
  reloader: PluginReloader,
  id: string,
  options: {
    readonly config: Config;
    readonly configDir: string;
    readonly configPath: string;
    readonly source?: string;
  },
): Effect.Effect<PromoteScratchResult, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entry = reloader.get(id);
    if (!entry && options.source === undefined) {
      return yield* Effect.fail(`plugin '${id}' is not a live scratch entry to promote`);
    }
    const source =
      options.source ??
      (yield* fs.readFileString(fileURLToPath(entry!.source)).pipe(
        Effect.mapError((error) => `cannot read scratch '${id}': ${String(error)}`),
      ));
    const pluginsDir = join(options.configDir, "plugins");
    yield* fs
      .makeDirectory(pluginsDir, { recursive: true })
      .pipe(Effect.mapError((error) => `cannot create managed plugins dir: ${String(error)}`));
    const absolute = managedPluginEntryPath(id, options.configDir);
    const relative = managedPluginSpecPath(id);
    yield* fs
      .writeFileString(absolute, source)
      .pipe(Effect.mapError((error) => `cannot write managed plugin '${id}': ${String(error)}`));
    const next = upsertPluginSpec(options.config, { path: relative, enabled: true });
    yield* saveConfig(next, options.configPath).pipe(
      Effect.mapError((error) => `cannot save config: ${String(error)}`),
    );
    // Same bytes, new authority: subsequent reload/checkpoint follow config.
    if (reloader.get(id) !== undefined) {
      yield* reloader.retarget(id, pathToFileURL(absolute));
    }
    return { plugin: id, path: relative, config: next };
  });
