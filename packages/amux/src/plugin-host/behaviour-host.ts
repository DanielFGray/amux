/**
 * Plugin-host process ownership of daemon command / tiling / adapter tables
 * and the PluginBehaviour built over them. The daemon reaches this only via
 * PluginHostRpcs (Load + behaviour methods).
 */
import { Config, Context, Deferred, Effect, Layer, Option } from "effect";
import type { PluginHostLoadInput } from "../config.ts";
import { DaemonSessions, type DaemonSessionsService } from "../daemon-sessions.ts";
import { errorMessage } from "../error-message.ts";
import {
  ForeignHarnessAdaptersTag,
  makeForeignHarnessAdapters,
  type ForeignHarnessAdapter,
} from "../foreign-harness.ts";
import {
  buildPluginBehaviour,
  type PluginBehaviourService,
  type PluginDeclarations,
} from "../plugin-behaviour.ts";
import { createPluginContributions } from "../plugin/contributions.ts";
import { createPluginHost } from "../plugin/host.ts";
import { loadDaemonPlugins } from "../plugin/loader.ts";
import {
  DaemonCommandsTag,
  scopedRegistry,
  TilingAlgorithmsTag,
  type DaemonCommandRecord,
  type DaemonCommandsService,
  type TilingAlgorithmRegistration,
  type TilingAlgorithmsService,
} from "../plugin/services.ts";
import type { PluginDefinition } from "../plugin/types.ts";
import { daemonSessionsFromCapabilitiesSocket } from "./daemon-sessions-layer.ts";
import { PluginHostError, PluginHostRpcs, type PluginHostHandlers } from "./rpc.ts";

const registryCoreEntries = (
  daemonCommands: DaemonCommandsService,
  tilingAlgorithms: TilingAlgorithmsService,
  foreignHarnessAdapters: ReturnType<typeof makeForeignHarnessAdapters>,
): readonly PluginDefinition[] => [
  {
    id: "amux.registry.daemon-commands",
    provide: [DaemonCommandsTag],
    activate: (ctx) => Effect.sync(() => void ctx.provide(DaemonCommandsTag, daemonCommands)),
  },
  {
    id: "amux.registry.tiling-algorithms",
    provide: [TilingAlgorithmsTag],
    activate: (ctx) => Effect.sync(() => void ctx.provide(TilingAlgorithmsTag, tilingAlgorithms)),
  },
  {
    id: "amux.registry.foreign-harness-adapters",
    provide: [ForeignHarnessAdaptersTag],
    activate: (ctx) =>
      Effect.sync(() => void ctx.provide(ForeignHarnessAdaptersTag, foreignHarnessAdapters)),
  },
];

export type BehaviourHostRuntime = {
  readonly behaviour: PluginBehaviourService;
  readonly load: (input: PluginHostLoadInput) => Effect.Effect<PluginDeclarations, PluginHostError>;
};

/**
 * Build the host-side tables, PluginHost, DaemonSessions, and behaviour once
 * per process. Missing AMUX_PLUGIN_CAPABILITIES_SOCKET fails as ConfigError.
 */
export const createBehaviourHostRuntime = Effect.gen(function* () {
  const socket = yield* Config.string("AMUX_PLUGIN_CAPABILITIES_SOCKET");
  const sessionsContext = yield* Layer.build(daemonSessionsFromCapabilitiesSocket(socket));
  const sessions: DaemonSessionsService = Context.get(sessionsContext, DaemonSessions);

  const pluginContributions = createPluginContributions();
  const daemonCommandTable = pluginContributions.table<DaemonCommandRecord>();
  const daemonCommands = scopedRegistry(
    { all: daemonCommandTable.all },
    (owner, record: DaemonCommandRecord) =>
      daemonCommandTable.add(owner, record.command.tag, record),
  );
  const tilingAlgorithmTable = pluginContributions.table<TilingAlgorithmRegistration>();
  const tilingAlgorithms = scopedRegistry(
    { all: tilingAlgorithmTable.all },
    (owner, registration: TilingAlgorithmRegistration) =>
      tilingAlgorithmTable.add(owner, registration.algorithm.id, registration),
  );
  const adapterTable = pluginContributions.table<ForeignHarnessAdapter>();
  const foreignHarnessAdapters = makeForeignHarnessAdapters(adapterTable);
  const coreEntries = registryCoreEntries(daemonCommands, tilingAlgorithms, foreignHarnessAdapters);
  const host = yield* createPluginHost({ contributions: pluginContributions });
  const behaviour = buildPluginBehaviour(
    daemonCommands,
    tilingAlgorithms,
    foreignHarnessAdapters,
    sessions,
  );

  const load = (input: PluginHostLoadInput): Effect.Effect<PluginDeclarations, PluginHostError> =>
    loadDaemonPlugins(input.plugins, host, input.configDirectory, coreEntries).pipe(
      Effect.mapError((error) => new PluginHostError({ message: errorMessage(error) })),
      Effect.andThen(behaviour.declarations),
    );

  return { behaviour, load };
});

/**
 * Default host handlers: Ping/Stop plus Load and the PluginBehaviour RPCs.
 * RunAction / RunSession use the process-scoped DaemonSessions from runtime.
 */
export const behaviourPluginHostHandlers = (
  stopped: Deferred.Deferred<void>,
  runtime: BehaviourHostRuntime,
): PluginHostHandlers =>
  PluginHostRpcs.toLayer({
    Ping: () => Effect.void,
    Stop: () => Effect.forkDetach(Deferred.succeed(stopped, undefined)).pipe(Effect.asVoid),
    Load: (input) => runtime.load(input),
    Reduce: ({ command, context, reads }) => runtime.behaviour.reduce(command, context, reads),
    CheckDescriptor: ({ type, descriptor }) => runtime.behaviour.checkDescriptor(type, descriptor),
    RunAction: (action) => runtime.behaviour.runAction(action),
    RunSession: ({ command, context }) =>
      runtime.behaviour
        .runSession(command, context)
        .pipe(Effect.map((result) => (result === undefined ? Option.none() : Option.some(result)))),
    RunTiling: ({ algorithmId, operation }) => runtime.behaviour.runTiling(algorithmId, operation),
    PlanResume: ({ adapterId, ref }) => runtime.behaviour.planResume(adapterId, ref),
  });
