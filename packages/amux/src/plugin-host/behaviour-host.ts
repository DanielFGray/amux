/**
 * Plugin-host process ownership of daemon command / tiling / adapter tables
 * and the PluginBehaviour built over them. The daemon reaches this only via
 * PluginHostRpcs (Load + behaviour methods).
 */
import { Config, Context, Deferred, Effect, Layer, Option, Ref } from "effect";
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
  PluginPublicationChanged,
  type PluginBehaviourService,
  type PluginPublicationRevision,
} from "../plugin-behaviour.ts";
import { createPluginContributions } from "../plugin/contributions.ts";
import { createPluginHost } from "../plugin/host.ts";
import { loadDaemonPlugins, type PluginEntry } from "../plugin/loader.ts";
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
import {
  PluginHostError,
  PluginHostRpcs,
  type PluginHostHandlers,
  type PluginHostLoadResult,
} from "./rpc.ts";

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
  readonly load: (
    input: PluginHostLoadInput,
  ) => Effect.Effect<PluginHostLoadResult, PluginHostError>;
  readonly revision: Ref.Ref<PluginPublicationRevision>;
};

/**
 * Build the host-side tables, PluginHost, DaemonSessions, and behaviour once
 * per process. Missing AMUX_PLUGIN_CAPABILITIES_SOCKET fails as ConfigError.
 * Owns the publication revision Ref: each successful Load increments it.
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
  const revision = yield* Ref.make<PluginPublicationRevision>(0);

  // Last successful load's entries — a failed Load leaves this alone so the
  // next attempt can keep a working plugin when its edited source will not import.
  let previousEntries: readonly PluginEntry[] = [];

  const load = (input: PluginHostLoadInput): Effect.Effect<PluginHostLoadResult, PluginHostError> =>
    loadDaemonPlugins(
      input.plugins,
      host,
      input.configDirectory,
      coreEntries,
      previousEntries,
    ).pipe(
      Effect.mapError((error) => new PluginHostError({ message: errorMessage(error) })),
      Effect.flatMap((loaded) =>
        Effect.gen(function* () {
          previousEntries = loaded.entries;
          const declarations = yield* behaviour.declarations;
          const next = yield* Ref.updateAndGet(revision, (current) => current + 1);
          return { declarations, failures: loaded.failures, revision: next };
        }),
      ),
    );

  return { behaviour, load, revision };
});

/**
 * Default host handlers: Ping/Stop plus Load and the PluginBehaviour RPCs.
 * RunAction / RunSession use the process-scoped DaemonSessions from runtime.
 * Each behaviour method checks the bound revision against the host Ref.
 */
export const behaviourPluginHostHandlers = (
  stopped: Deferred.Deferred<void>,
  runtime: BehaviourHostRuntime,
): PluginHostHandlers => {
  const guardRevision = <A, E, R>(
    expected: PluginPublicationRevision,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PluginPublicationChanged, R> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(runtime.revision);
      if (expected !== current) {
        return yield* new PluginPublicationChanged({ expected, current });
      }
      return yield* effect;
    });

  return PluginHostRpcs.toLayer({
    Ping: () => Effect.void,
    Stop: () => Effect.forkDetach(Deferred.succeed(stopped, undefined)).pipe(Effect.asVoid),
    Load: (input) => runtime.load(input),
    Reduce: ({ revision: expected, command, context, reads }) =>
      guardRevision(expected, runtime.behaviour.reduce(command, context, reads)),
    CheckDescriptor: ({ revision: expected, type, descriptor }) =>
      guardRevision(expected, runtime.behaviour.checkDescriptor(type, descriptor)),
    RunAction: ({ revision: expected, action }) =>
      guardRevision(expected, runtime.behaviour.runAction(action)),
    RunSession: ({ revision: expected, command, context }) =>
      guardRevision(
        expected,
        runtime.behaviour
          .runSession(command, context)
          .pipe(
            Effect.map((result) => (result === undefined ? Option.none() : Option.some(result))),
          ),
      ),
    RunTiling: ({ revision: expected, algorithmId, operation }) =>
      guardRevision(expected, runtime.behaviour.runTiling(algorithmId, operation)),
    PlanResume: ({ revision: expected, adapterId, ref }) =>
      guardRevision(expected, runtime.behaviour.planResume(adapterId, ref)),
  });
};
