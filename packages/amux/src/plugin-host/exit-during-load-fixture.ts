/**
 * Test fixture: answers Ping, then exits the process while Load is in flight.
 *
 * Spawned by plugin-host tests via `pluginHost.argv`; not a product CLI path.
 */
import { Deferred, Effect } from "effect";
import { CommandError } from "../commands.ts";
import { ForeignHarnessPlanResumeError } from "../foreign-harness.ts";
import { PluginBehaviourError } from "../plugin-behaviour.ts";
import { TilingAlgorithmError } from "../tiling-algorithm.ts";
import { PluginReducerError } from "../workspace-changes.ts";
import { runPluginHostMain, type PluginHostHandlerFactory } from "./main.ts";
import { PluginHostRpcs } from "./rpc.ts";

const exitDuringLoadHandlers: PluginHostHandlerFactory = (stopped) =>
  Effect.succeed(
    PluginHostRpcs.toLayer({
      Ping: () => Effect.void,
      Stop: () => Effect.forkDetach(Deferred.succeed(stopped, undefined)).pipe(Effect.asVoid),
      Load: () =>
        Effect.forkDetach(
          Effect.sync(() => {
            process.exit(1);
          }),
        ).pipe(Effect.andThen(Effect.never)),
      Reduce: () =>
        Effect.fail(
          new PluginReducerError({ message: "exit-during-load fixture has no reducers" }),
        ),
      CheckDescriptor: () =>
        Effect.fail(
          new PluginReducerError({ message: "exit-during-load fixture has no descriptors" }),
        ),
      RunAction: () =>
        Effect.fail(
          new PluginBehaviourError({ message: "exit-during-load fixture has no actions" }),
        ),
      RunSession: () =>
        Effect.fail(
          new CommandError({ message: "exit-during-load fixture has no session handlers" }),
        ),
      RunTiling: ({ algorithmId }) =>
        Effect.fail(
          new TilingAlgorithmError({
            algorithm: algorithmId,
            message: "exit-during-load fixture has no tiling",
          }),
        ),
      PlanResume: ({ adapterId }) =>
        Effect.fail(
          new ForeignHarnessPlanResumeError({
            adapter: adapterId,
            message: "exit-during-load fixture has no adapters",
          }),
        ),
    }),
  );

if (import.meta.main) {
  runPluginHostMain(exitDuringLoadHandlers);
}
