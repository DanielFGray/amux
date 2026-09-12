import { Effect, Logger } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { dirname } from "node:path";
import { configPath, loadConfig } from "../config.ts";
import { createPluginContributions } from "./contributions.ts";
import { createPluginHost } from "./host.ts";
import { loadDaemonPluginsFromConfig } from "./loader.ts";
import { definePlugin } from "./types.ts";
import { DaemonCommandsTag, scopedRegistry, type DaemonCommandRegistration } from "./services.ts";

/**
 * Read daemon-command declarations before a daemon starts. The CLI needs the
 * same field and target metadata to parse a plugin-owned command locally; it
 * does not execute the plugin's handlers here.
 */
export const daemonCommandRegistrations = (): Promise<readonly DaemonCommandRegistration[]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* loadConfig();
      const contributions = createPluginContributions();
      const table = contributions.table<DaemonCommandRegistration>();
      const commands = scopedRegistry(
        { all: table.all },
        (owner, registration: DaemonCommandRegistration) =>
          table.add(owner, registration.tag, registration),
      );
      const host = yield* createPluginHost({ contributions });
      yield* loadDaemonPluginsFromConfig(config, host, dirname(yield* configPath), [
        definePlugin({
          id: "amux.registry.daemon-commands",
          provide: [DaemonCommandsTag],
          effect: (ctx) => Effect.sync(() => void ctx.provide(DaemonCommandsTag, commands)),
        }),
      ]);
      return table.all().map(({ value }) => value);
    }).pipe(
      Effect.scoped,
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(Logger.LogToStderr, true),
    ),
  );
