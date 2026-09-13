/**
 * Test fixture: answers the first Ping, then never returns.
 *
 * Spawned by plugin-host tests via `pluginHost.argv`; not a product CLI path.
 */
import { Deferred, Effect } from "effect";
import { runPluginHostMain } from "./main.ts";
import { PluginHostRpcs, type PluginHostHandlers } from "./rpc.ts";

const hangHandlers = (stopped: Deferred.Deferred<void>): PluginHostHandlers => {
  let answered = 0;
  return PluginHostRpcs.toLayer({
    Ping: () => {
      answered += 1;
      if (answered > 1) return Effect.never;
      return Effect.void;
    },
    Stop: () => Effect.forkDetach(Deferred.succeed(stopped, undefined)).pipe(Effect.asVoid),
  });
};

if (import.meta.main) {
  runPluginHostMain(hangHandlers);
}
