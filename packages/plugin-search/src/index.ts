import { Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { definePlugin, PanelTag, type PluginDefinition } from "@danielfgray/amux";
import { POLL_MS } from "@danielfgray/amux";
import { scheduledPoll } from "@danielfgray/amux/effect/timer.ts";
import * as Path from "effect/Path";
import { SearchService, make } from "./file-search.ts";

export const SEARCH_PLUGIN_ID = "amux.search";

const activeDir = (panel: {
  snapshot: () => {
    spaces: readonly { id: string; dir: string }[];
    state: { activeSpace: string | null };
  };
}): string | undefined => {
  const workspace = panel.snapshot();
  const active = workspace.state.activeSpace;
  if (active === null) return undefined;
  return workspace.spaces.find((space) => space.id === active)?.dir;
};

/**
 * The one owner of fff in amux. Consumers inject SearchService instead of
 * importing the SDK, so disabling this plugin removes its native index too.
 *
 * Boot can activate this plugin before the first space lands in the snapshot.
 * A one-shot `if (!active) return` left SearchService permanently absent —
 * wait for a root, then provide (lazy soft-gets in the editor pick it up).
 */
export const searchPlugin: PluginDefinition = definePlugin({
  id: SEARCH_PLUGIN_ID,
  inject: [PanelTag],
  provide: [SearchService],
  effect: (ctx) =>
    Effect.gen(function* () {
      const panel = yield* PanelTag;
      const layers = Layer.mergeAll(BunFileSystem.layer, Path.layer);

      // Prefer the live space; if activation raced the first workspace write,
      // poll until one exists rather than giving up forever.
      let root = activeDir(panel);
      while (root === undefined) {
        yield* Effect.sleep(`${POLL_MS} millis`);
        root = activeDir(panel);
      }

      const search = yield* make({ root }).pipe(
        Effect.tapError((error) => Effect.sync(() => panel.reportError(error.message))),
        Effect.orDie,
        Effect.provide(layers),
      );
      ctx.provide(SearchService, search);

      let indexedDirectory = root;
      let reindexing = false;
      const runtime = yield* Effect.context();
      yield* Effect.forkScoped(
        scheduledPoll(POLL_MS, () => {
          const next = activeDir(panel);
          if (!next || next === indexedDirectory || reindexing) return;
          reindexing = true;
          Effect.runForkWith(runtime)(
            search.reindex(next).pipe(
              Effect.tap(() => Effect.sync(() => void (indexedDirectory = next))),
              Effect.catch((error) => Effect.sync(() => panel.reportError(error.message))),
              Effect.ensuring(Effect.sync(() => void (reindexing = false))),
            ),
          );
        }),
      );
    }),
});

export { SearchService, type FileSearch, type FileSearchOptions } from "./file-search.ts";
export default searchPlugin;
