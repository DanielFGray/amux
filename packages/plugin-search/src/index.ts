import { Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { definePlugin, PanelTag, type PluginDefinition } from "@danielfgray/amux";
import { POLL_MS } from "@danielfgray/amux";
import { scheduledPoll } from "@danielfgray/amux/effect/timer.ts";
import * as Path from "effect/Path";
import { SearchService, make } from "./file-search.ts";

export const SEARCH_PLUGIN_ID = "amux.search";

/**
 * The one owner of fff in amux. Consumers inject SearchService instead of
 * importing the SDK, so disabling this plugin removes its native index too.
 */
export const searchPlugin: PluginDefinition = definePlugin({
  id: SEARCH_PLUGIN_ID,
  inject: [PanelTag],
  provide: [SearchService],
  effect: (ctx) =>
    Effect.gen(function* () {
      const panel = yield* PanelTag;
      const workspace = panel.snapshot();
      const active = workspace.spaces.find((space) => space.id === workspace.state.activeSpace);
      if (!active) return;
      const search = yield* make({ root: active.dir }).pipe(
        Effect.tapError((error) => Effect.sync(() => panel.reportError(error.message))),
        Effect.orDie,
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, Path.layer)),
      );
      ctx.provide(SearchService, search);
      let indexedDirectory = active.dir;
      let reindexing = false;
      const runtime = yield* Effect.context();
      yield* Effect.forkScoped(
        scheduledPoll(POLL_MS, () => {
          const snapshot = panel.snapshot();
          const next = snapshot.spaces.find(
            (space) => space.id === snapshot.state.activeSpace,
          )?.dir;
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
