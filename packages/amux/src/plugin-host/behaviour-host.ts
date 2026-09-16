/**
 * Plugin-host process ownership of daemon command / tiling / adapter tables
 * and the PluginBehaviour built over them. The daemon reaches this only via
 * PluginHostRpcs (Prepare/Publish/Discard + Eval/Promote/SetEnabled + behaviour).
 */
import { BunServices } from "@effect/platform-bun";
import { Config, Context, Deferred, Effect, Layer, Option, Ref } from "effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- config paths from Effect Config env.
import { join } from "node:path";
import {
  loadConfig,
  pluginSpecKey,
  type Config as AmuxConfig,
  type PluginHostLoadInput,
} from "../config.ts";
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
import {
  checkpointLastGood,
  collectUiHalves,
  prepareDaemonPlugins,
  type LoadedPluginEntry,
} from "../plugin/loader.ts";
import {
  listScratchSpecs,
  materializeScratch,
  promoteScratch,
  setPluginEnabledInConfig,
  scratchEntryFilePath,
} from "../plugin/scratch.ts";
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
import type { PluginUiHalf } from "../plugin/ui-announcement.ts";
import { daemonSessionsFromCapabilitiesSocket } from "./daemon-sessions-layer.ts";
import {
  PluginHostError,
  PluginHostRpcs,
  type PluginHostHandlers,
  type PluginHostPrepareResult,
  type PluginHostPublishResult,
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
  readonly prepare: (
    input: PluginHostLoadInput,
  ) => Effect.Effect<PluginHostPrepareResult, PluginHostError>;
  readonly publish: () => Effect.Effect<PluginHostPublishResult, PluginHostError>;
  readonly discard: () => Effect.Effect<void, PluginHostError>;
  readonly eval: (payload: {
    readonly id: string;
    readonly source: string;
  }) => Effect.Effect<{ readonly plugin: string; readonly path: string }, PluginHostError>;
  readonly promote: (payload: {
    readonly id: string;
  }) => Effect.Effect<{ readonly plugin: string; readonly path: string }, PluginHostError>;
  readonly setEnabled: (payload: {
    readonly id: string;
    readonly enabled: boolean;
  }) => Effect.Effect<void, PluginHostError>;
  readonly revision: Ref.Ref<PluginPublicationRevision>;
};

/**
 * Build the host-side tables, PluginHost, DaemonSessions, and behaviour once
 * per process. Missing AMUX_PLUGIN_CAPABILITIES_SOCKET fails as ConfigError.
 * Owns the publication revision Ref: each successful Publish increments it.
 */
export const createBehaviourHostRuntime = Effect.gen(function* () {
  const socket = yield* Config.String("AMUX_PLUGIN_CAPABILITIES_SOCKET");
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

  // Fixed for this host generation — supervisor sets both in the child env.
  const configDirectory = yield* Config.String("AMUX_PLUGIN_CONFIG_DIRECTORY");
  const scratchDirectory = yield* Config.String("AMUX_PLUGIN_SCRATCH_DIRECTORY");

  // Last successful prepare's entries — a failed Prepare leaves this alone so the
  // next attempt can keep a working plugin when its edited source will not import.
  let previousEntries: readonly LoadedPluginEntry[] = [];
  let preparedEntries: readonly LoadedPluginEntry[] | undefined;
  let lastUiHalves: readonly PluginUiHalf[] = [];

  const readHostConfig = (): Effect.Effect<AmuxConfig> =>
    loadConfig(join(configDirectory, "config.json")).pipe(Effect.provide(BunServices.layer));

  const prepare = (
    input: PluginHostLoadInput,
  ): Effect.Effect<PluginHostPrepareResult, PluginHostError> =>
    Effect.gen(function* () {
      const scratch = yield* listScratchSpecs(scratchDirectory).pipe(
        Effect.provide(BunServices.layer),
      );
      const configured = new Map(input.plugins.map((spec) => [pluginSpecKey(spec), spec] as const));
      const plugins = [
        ...input.plugins,
        ...scratch.filter((spec) => !configured.has(pluginSpecKey(spec))),
      ];
      const loaded = yield* prepareDaemonPlugins(
        plugins,
        host,
        configDirectory,
        coreEntries,
        previousEntries,
      ).pipe(Effect.mapError((error) => new PluginHostError({ message: errorMessage(error) })));
      const ui = yield* collectUiHalves(loaded.specs, configDirectory).pipe(
        Effect.provide(BunServices.layer),
      );
      preparedEntries = loaded.entries;
      lastUiHalves = ui;
      return { failures: loaded.failures };
    });

  const publish = (): Effect.Effect<PluginHostPublishResult, PluginHostError> =>
    host.publish.pipe(
      Effect.mapError((error) => new PluginHostError({ message: errorMessage(error) })),
      Effect.flatMap(() =>
        Effect.gen(function* () {
          if (preparedEntries !== undefined) {
            previousEntries = preparedEntries;
            preparedEntries = undefined;
          }
          const declarations = yield* behaviour.declarations;
          const next = yield* Ref.updateAndGet(revision, (current) => current + 1);
          yield* checkpointLastGood(configDirectory, previousEntries).pipe(
            Effect.provide(BunServices.layer),
            Effect.catch((error) =>
              Effect.logWarning(`Could not checkpoint plugins: ${errorMessage(error)}`),
            ),
          );
          return { declarations, revision: next, plugins: lastUiHalves };
        }),
      ),
    );

  const discard = (): Effect.Effect<void, PluginHostError> =>
    host.discard.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          preparedEntries = undefined;
        }),
      ),
    );

  const evalScratch = (payload: {
    readonly id: string;
    readonly source: string;
  }): Effect.Effect<{ readonly plugin: string; readonly path: string }, PluginHostError> =>
    materializeScratch(payload.id, payload.source, scratchDirectory).pipe(
      Effect.provide(BunServices.layer),
      Effect.mapError((error) => new PluginHostError({ message: error })),
      Effect.map((url) => ({ plugin: payload.id, path: scratchEntryFilePath(url) })),
    );

  const promote = (payload: {
    readonly id: string;
  }): Effect.Effect<{ readonly plugin: string; readonly path: string }, PluginHostError> =>
    Effect.gen(function* () {
      const config = yield* readHostConfig();
      const result = yield* promoteScratch(payload.id, {
        config,
        configDir: configDirectory,
        configPath: join(configDirectory, "config.json"),
        scratchDir: scratchDirectory,
      }).pipe(
        Effect.provide(BunServices.layer),
        Effect.mapError((error) => new PluginHostError({ message: error })),
      );
      return { plugin: result.plugin, path: result.path };
    });

  const setEnabled = (payload: {
    readonly id: string;
    readonly enabled: boolean;
  }): Effect.Effect<void, PluginHostError> =>
    Effect.gen(function* () {
      const config = yield* readHostConfig();
      yield* setPluginEnabledInConfig(payload.id, payload.enabled, {
        config,
        configPath: join(configDirectory, "config.json"),
      }).pipe(
        Effect.provide(BunServices.layer),
        Effect.mapError((error) => new PluginHostError({ message: error })),
      );
    });

  return {
    behaviour,
    prepare,
    publish,
    discard,
    eval: evalScratch,
    promote,
    setEnabled,
    revision,
  };
});

/**
 * Default host handlers: Ping/Stop plus Prepare/Publish/Discard, file mutations,
 * and the PluginBehaviour RPCs. Each behaviour method checks the bound revision.
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
    Prepare: (input) => runtime.prepare(input),
    Publish: () => runtime.publish(),
    Discard: () => runtime.discard(),
    Eval: (payload) => runtime.eval(payload),
    Promote: (payload) => runtime.promote(payload),
    SetEnabled: (payload) => runtime.setEnabled(payload),
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
