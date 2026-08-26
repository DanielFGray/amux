import { Effect } from "effect";
import type { PluginDefinition } from "./types.ts";
import type { PluginHost } from "./host.ts";
import { hotImport } from "./hot.ts";
import type { HotPlugin } from "./loader.ts";

export interface PluginReloader {
  /** Load a plugin's source again and swap the running instance for it. */
  readonly reload: (id: string) => Effect.Effect<void, string>;
  /** Every plugin amux can reload, for a request that names none. */
  readonly reloadable: () => readonly string[];
  readonly enable: (id: string) => Effect.Effect<void, string>;
  readonly disable: (id: string) => Effect.Effect<void, string>;
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
export const createReloader = (host: PluginHost, plugins: readonly HotPlugin[]): PluginReloader => {
  const running = new Map<string, { source: URL; definition: PluginDefinition }>(
    plugins.map((plugin) => [plugin.id, { source: plugin.source, definition: plugin.definition }]),
  );

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

  const reload = (id: string): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const current = running.get(id);
      if (!current) return yield* Effect.fail(`no reloadable plugin '${id}'`);

      const next = yield* hotImport(current.source).pipe(
        Effect.mapError((error) => `plugin '${id}' was not reloaded: ${error}`),
      );
      yield* host.add(next);
      running.set(id, { source: current.source, definition: next });
    });

  return { reload, reloadable: () => [...running.keys()], enable, disable };
};
