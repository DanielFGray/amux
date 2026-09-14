/**
 * Test fixture: supervise a real plugin-host and print its pid once ready.
 *
 * The orphan test SIGKILLs this process so the supervisor release never runs;
 * the host must still exit via the stdin lifeline.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Option, SubscriptionRef } from "effect";
import type { PluginHostBehaviourCalls, PluginPublication } from "./client.ts";
import { PluginHostError, type PluginHostStatus } from "./rpc.ts";
import { awaitPluginHostClient, supervisePluginHost } from "./supervisor.ts";

const program = Effect.gen(function* () {
  const socketPath = yield* Config.string("AMUX_PLUGIN_HOST_SOCKET");
  const capabilitiesSocketPath = `${socketPath}.capabilities`;
  const status = yield* SubscriptionRef.make<PluginHostStatus>({
    state: "starting",
    restarts: 0,
  });
  const generation = yield* SubscriptionRef.make(
    Option.none<PluginPublication<PluginHostBehaviourCalls>>(),
  );
  const configDirectory = yield* Config.string("HOME").pipe(Effect.orElseSucceed(() => "/tmp"));

  yield* Effect.forkScoped(
    supervisePluginHost({
      socketPath,
      capabilitiesSocketPath,
      status,
      generation,
      loadGeneration: (client) =>
        Effect.gen(function* () {
          yield* client.Prepare({ plugins: [], configDirectory });
          return yield* client.Publish();
        }).pipe(Effect.mapError((error) => new PluginHostError({ message: error.message }))),
    }),
  );

  yield* awaitPluginHostClient(generation);
  const ready = yield* SubscriptionRef.get(status);
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
