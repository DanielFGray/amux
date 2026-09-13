/**
 * Test helpers for {@link PluginBehaviour}. Not part of the production API.
 */
import { Effect } from "effect";
import { toJsonSchemaDocument } from "./command-cli.ts";
import { buildPluginBehaviour, type PluginBehaviourService } from "./plugin-behaviour.ts";
import type { ForeignHarnessAdapterLookup } from "./foreign-harness.ts";
import { PluginActivateError } from "./plugin/activate-error.ts";
import type {
  DaemonCommandRecord,
  DaemonCommandRegistration,
  DaemonCommandsService,
  TilingAlgorithmsService,
} from "./plugin/services.ts";

export const emptyAdapterLookup = (): ForeignHarnessAdapterLookup => ({
  bySource: () => undefined,
  byId: () => undefined,
  list: () => [],
});

export const emptyAlgorithms = (): TilingAlgorithmsService => ({
  all: () => [],
  register: () => Effect.void,
});

export const emptyCommands = (): DaemonCommandsService => ({
  all: () => [],
  register: () => Effect.void,
});

/** Empty behaviour for layers that require PluginBehaviour but register nothing. */
export const emptyPluginBehaviour: PluginBehaviourService = buildPluginBehaviour(
  emptyCommands(),
  emptyAlgorithms(),
  emptyAdapterLookup(),
);

/** Build PluginBehaviour from a static command list (converts fields once). */
export const pluginBehaviourFromRegistrations = (
  registrations: Iterable<DaemonCommandRegistration>,
  algorithms: TilingAlgorithmsService = emptyAlgorithms(),
  adapters: ForeignHarnessAdapterLookup = emptyAdapterLookup(),
): Effect.Effect<PluginBehaviourService, PluginActivateError> =>
  Effect.gen(function* () {
    const records: DaemonCommandRecord[] = yield* Effect.forEach([...registrations], (command) =>
      toJsonSchemaDocument(command.fields).pipe(
        Effect.map((fields) => ({ command, fields }) satisfies DaemonCommandRecord),
        Effect.mapError(
          (error) =>
            new PluginActivateError({
              message: `command '${command.tag}' fields are not publishable as JSON Schema: ${error.message}`,
            }),
        ),
      ),
    );
    const commands: DaemonCommandsService = {
      all: () =>
        records.map((value) => ({
          owner: { id: "test", generation: 0 },
          name: value.command.tag,
          value,
        })),
      register: () => Effect.void,
    };
    return buildPluginBehaviour(commands, algorithms, adapters);
  });
