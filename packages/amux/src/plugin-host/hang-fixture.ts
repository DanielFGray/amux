/**
 * Test fixture: answers the first Ping and Load, then never returns Pings.
 *
 * Spawned by plugin-host tests via `pluginHost.argv`; not a product CLI path.
 */
import { Deferred, Effect } from "effect";
import { CommandError } from "../commands.ts";
import { ForeignHarnessPlanResumeError } from "../foreign-harness.ts";
import { emptyPluginDeclarations, PluginBehaviourError } from "../plugin-behaviour.ts";
import { TilingAlgorithmError } from "../tiling-algorithm.ts";
import { PluginReducerError } from "../workspace-changes.ts";
import { runPluginHostMain, type PluginHostHandlerFactory } from "./main.ts";
import { PluginHostRpcs } from "./rpc.ts";

const hangHandlers: PluginHostHandlerFactory = (stopped) =>
  Effect.succeed(
    (() => {
      let answered = 0;
      return PluginHostRpcs.toLayer({
        Ping: () => {
          answered += 1;
          if (answered > 1) return Effect.never;
          return Effect.void;
        },
        Stop: () => Effect.forkDetach(Deferred.succeed(stopped, undefined)).pipe(Effect.asVoid),
        Load: () => Effect.succeed(emptyPluginDeclarations),
        Reduce: () =>
          Effect.fail(new PluginReducerError({ message: "hang fixture has no reducers" })),
        CheckDescriptor: () =>
          Effect.fail(new PluginReducerError({ message: "hang fixture has no descriptors" })),
        RunAction: () =>
          Effect.fail(new PluginBehaviourError({ message: "hang fixture has no actions" })),
        RunSession: () =>
          Effect.fail(new CommandError({ message: "hang fixture has no session handlers" })),
        RunTiling: ({ algorithmId }) =>
          Effect.fail(
            new TilingAlgorithmError({
              algorithm: algorithmId,
              message: "hang fixture has no tiling",
            }),
          ),
        PlanResume: ({ adapterId }) =>
          Effect.fail(
            new ForeignHarnessPlanResumeError({
              adapter: adapterId,
              message: "hang fixture has no adapters",
            }),
          ),
      });
    })(),
  );

if (import.meta.main) {
  runPluginHostMain(hangHandlers);
}
