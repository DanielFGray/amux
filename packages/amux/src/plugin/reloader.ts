import { Effect, Option } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import { fileURLToPath } from "node:url";
import type { PluginDefinition, PluginErrorEvent } from "./types.ts";
import type { PluginHost } from "./host.ts";
import { hotImportBatch, hotModuleClosure, importGraph } from "./hot.ts";
import { checkPluginCompat } from "./compat.ts";
import type { PluginEntry } from "./loader.ts";
import { staleEntries } from "./stale.ts";
import type { LastGoodStore } from "./last-good.ts";

export interface PluginReloader {
  /** Load a plugin's source again and swap the running instance for it. */
  readonly reload: (
    id: string,
    options?: { readonly disk?: boolean },
  ) => Effect.Effect<void, string>;
  /** Reload every active entry whose imports reach a changed source file. */
  readonly reloadStale: (changed: URL) => Effect.Effect<readonly string[], string>;
  /** Every plugin amux can reload, for a request that names none. */
  readonly reloadable: () => readonly string[];
  readonly enable: (id: string) => Effect.Effect<void, string>;
  readonly disable: (id: string) => Effect.Effect<void, string>;
  /** Observe the one shared host error stream; stale generations are ignored. */
  readonly observeError: (event: PluginErrorEvent) => Effect.Effect<void>;
  /** Persist the currently running source entries as the restart recovery floor. */
  readonly checkpoint: Effect.Effect<void, string>;
}

/**
 * Editing a plugin takes effect in the running client, when asked. The scope
 * replaced here contains registrations and UI work only; agent sessions are
 * daemon-owned and are deliberately not reachable from this lifecycle.
 *
 * The last version that worked is the floor. A source that will not import or
 * will not decode is rejected before anything is torn down, so a half-typed
 * file leaves the pane alone. Activation uses the host's generation flip, so a
 * version that dies while starting is closed without touching the running one.
 */
export const createReloader = (
  host: PluginHost,
  plugins: readonly PluginEntry[],
  recoveryStore: Option.Option<LastGoodStore> = Option.none(),
): PluginReloader => {
  const running = new Map<string, { source: URL; definition: PluginDefinition }>(
    plugins.map((plugin) => [plugin.id, { source: plugin.source, definition: plugin.definition }]),
  );
  // A committed replacement remains on probation. Its predecessor is retained
  // until a later successful reload supersedes it, so repeated render faults
  // have a concrete generation to restore without re-reading a broken disk.
  const lastGood = new Map(running);
  const cohorts = new Map<string, readonly string[]>();
  const renderFaults = new Map<string, readonly number[]>();
  const rollingBack = new Set<string>();
  const quarantined = new Set<string>();
  const checkpoint: Effect.Effect<void, string> = Option.match(recoveryStore, {
    onNone: (): Effect.Effect<void, string> => Effect.void,
    onSome: (store): Effect.Effect<void, string, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sources = hotModuleClosure([...running.values()].map((plugin) => plugin.source));
        const modules = yield* Effect.forEach(sources, (source) =>
          fs.readFileString(fileURLToPath(source)).pipe(
            Effect.map((text) => ({ url: source.href, text })),
            Effect.mapError((error) => `could not checkpoint '${source}': ${error.message}`),
          ),
        );
        yield* store
          .write({
            version: 1,
            entries: [...running.values()].map((plugin) => plugin.source.href),
            modules,
            quarantined: quarantined.size > 0,
          })
          .pipe(Effect.mapError((error) => error.message));
      }),
  }).pipe(Effect.provide(BunFileSystem.layer));

  const isActive = (id: string) => host.status().some((status) => status.id === id);

  const enable = (id: string): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const current = running.get(id);
      if (!current) return yield* Effect.fail(`unknown plugin '${id}'`);
      if (isActive(id)) return;
      yield* host.add(current.definition);
      if (!isActive(id)) return yield* Effect.fail(`plugin '${id}' did not start`);
    });

  const disable = (id: string): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      if (!running.has(id)) return yield* Effect.fail(`unknown plugin '${id}'`);
      if (!isActive(id)) return;
      yield* host.remove(id);
    });

  const reloadEntries = (
    ids: readonly string[],
    changed?: URL,
    options?: { readonly disk?: boolean },
  ): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const held = ids.find((id) => quarantined.has(id));
      if (held && !options?.disk)
        return yield* Effect.fail(
          `plugin '${held}' is quarantined after repeated render failures; retry with disk: true`,
        );
      const current = ids.map((id) => [id, running.get(id)] as const);
      const missing = current.find(([, plugin]) => !plugin);
      if (missing) return yield* Effect.fail(`no reloadable plugin '${missing[0]}'`);
      const next = yield* hotImportBatch(
        current.map(([, plugin]) => plugin!.source),
        changed ? [changed] : [],
      );
      // Checked before the host replaces the generation: a reloaded
      // source that no longer satisfies its engines.amux range leaves the
      // last version that worked alone, the same as one that will not import.
      // Provided here, at the one filesystem touch, so `reload` stays
      // service-free for its callers the way the loader already is.
      yield* Effect.forEach(next, (definition, index) =>
        checkPluginCompat(current[index]![1]!.source, definition.id).pipe(
          Effect.provide(BunFileSystem.layer),
          Effect.mapError((error) => `classify: plugin '${ids[index]}' was not reloaded: ${error}`),
        ),
      );
      yield* host.replace(next).pipe(Effect.mapError((error) => `activate: ${error}`));
      for (const [index, definition] of next.entries()) {
        const [id, plugin] = current[index]!;
        lastGood.set(id, plugin!);
        running.set(id, { source: plugin!.source, definition });
        cohorts.set(id, ids);
        if (options?.disk) quarantined.delete(id);
      }
      if (options?.disk) yield* checkpoint;
    });

  const reload = (id: string, options?: { readonly disk?: boolean }) =>
    reloadEntries([id], undefined, options);
  const reloadStale = (changed: URL): Effect.Effect<readonly string[], string> => {
    const ids = staleEntries(
      importGraph(),
      changed.href,
      [...running.values()]
        .filter((plugin) => isActive(plugin.definition.id))
        .map((plugin) => plugin.source.href),
    )
      .map(
        (source) => [...running.entries()].find(([, plugin]) => plugin.source.href === source)?.[0],
      )
      .filter((id): id is string => id !== undefined);
    return ids.length === 0 ? Effect.succeed([]) : reloadEntries(ids, changed).pipe(Effect.as(ids));
  };

  const observeError = (event: PluginErrorEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (event.phase !== "render" || host.generation(event.pluginId) !== event.generation) return;
      const now = event.timestamp;
      const recent = [...(renderFaults.get(event.pluginId) ?? []), now].filter(
        (timestamp) => now - timestamp <= 5_000,
      );
      renderFaults.set(event.pluginId, recent);
      if (recent.length < 3 || rollingBack.has(event.pluginId)) return;

      const ids = cohorts.get(event.pluginId) ?? [event.pluginId];
      const previous = ids.map((id) => [id, lastGood.get(id)] as const);
      if (previous.some(([, plugin]) => !plugin)) return;
      rollingBack.add(event.pluginId);
      yield* host.replace(previous.map(([, plugin]) => plugin!.definition)).pipe(Effect.ignore);
      for (const [id, plugin] of previous) running.set(id, plugin!);
      for (const id of ids) {
        renderFaults.delete(id);
        quarantined.add(id);
      }
      yield* Option.match(recoveryStore, {
        onNone: () => Effect.void,
        onSome: (store) =>
          store.read.pipe(
            Effect.orElseSucceed(() => Option.none()),
            Effect.flatMap((saved) =>
              Option.match(saved, {
                onNone: () => Effect.void,
                onSome: (value) => store.write({ ...value, quarantined: true }).pipe(Effect.ignore),
              }),
            ),
          ),
      });
      rollingBack.delete(event.pluginId);
    });

  return {
    reload,
    reloadStale,
    reloadable: () => [...running.keys()],
    enable,
    disable,
    observeError,
    checkpoint,
  };
};
