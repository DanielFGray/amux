/**
 * Test fixture: supervise a real plugin-host and print its pid once ready.
 *
 * The orphan test SIGKILLs this process so the supervisor release never runs;
 * the host must still exit via the stdin lifeline.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Option, Ref, SubscriptionRef } from "effect";
import type { PluginHostStatus } from "./rpc.ts";
import {
  awaitPluginHostClient,
  supervisePluginHost,
  type PluginHostClient,
} from "./supervisor.ts";

const program = Effect.gen(function* () {
  const socketPath = yield* Config.string("AMUX_PLUGIN_HOST_SOCKET");
  const status = yield* Ref.make<PluginHostStatus>({
    state: "starting",
    restarts: 0,
  });
  const client = yield* SubscriptionRef.make(Option.none<PluginHostClient>());

  yield* Effect.forkScoped(
    supervisePluginHost({
      socketPath,
      status,
      client,
    }),
  );

  yield* awaitPluginHostClient(client);
  const ready = yield* Ref.get(status);
  if (ready.pid === undefined) {
    return yield* Effect.die("plugin-host ready without a pid");
  }
  yield* Effect.sync(() => {
    process.stdout.write(`HOST_PID=${ready.pid}\n`);
  });

  return yield* Effect.never;
});

if (import.meta.main) {
  BunRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(BunServices.layer)));
}
