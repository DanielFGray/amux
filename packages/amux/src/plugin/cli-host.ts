import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { dirname } from "node:path";
import { CONFIG_PATH, loadConfig } from "../config.ts";
import { createPluginContributions } from "./contributions.ts";
import { createPluginHost, type RefusedPlugin } from "./host.ts";
import { loadPluginsFromConfig } from "./loader.ts";
import { definePlugin } from "./types.ts";
import { CliCommandsTag, scopedRegistry, type CliCommandRegistration } from "./services.ts";

export interface CliCommandFound {
  readonly code: number;
}

/** No plugin registers `name`. `refused` is why one might be missing: every
 *  entry the host's reduced registry could not satisfy, reported the same way
 *  `reconcile` reports any other unsatisfiable injection. */
export interface CliCommandMissing {
  readonly refused: readonly RefusedPlugin[];
}

/**
 * A one-shot instance of the same plugin kernel the attached client runs,
 * built for a process that has no UI to offer: no `PanelTag`, no
 * `SessionStreamTag`, no `RegionsTag`. A plugin that injects one of those is
 * refused here exactly as it would be by any other host missing a provider —
 * there is no separate "headless" host kind. This is what lets a setup verb
 * like an agent-hook installer live in plugin code without amux ever having
 * started a daemon or a client.
 */
export const dispatchCliCommand = (
  name: string,
  argv: readonly string[],
): Promise<CliCommandFound | CliCommandMissing> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* loadConfig();
        const contributions = createPluginContributions();
        const table = contributions.table<CliCommandRegistration>();
        const cliCommands = scopedRegistry(
          { all: table.all },
          (owner, registration: CliCommandRegistration) =>
            table.add(owner, registration.name, registration),
        );
        const host = yield* createPluginHost({ contributions });
        const { refused } = yield* loadPluginsFromConfig(config, host, dirname(CONFIG_PATH), [
          definePlugin({
            id: "amux.registry.cli-commands",
            provide: [CliCommandsTag],
            effect: (ctx) => Effect.sync(() => void ctx.provide(CliCommandsTag, cliCommands)),
          }),
        ]);
        const match = table.all().find((entry) => entry.value.name === name);
        if (!match) return { refused };
        return { code: yield* match.value.handler(argv) };
      }),
    ).pipe(Effect.provide(BunFileSystem.layer)),
  );
