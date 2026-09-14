/**
 * Daemon → plugin behaviour as one Effect service. Methods take and return
 * Schema data only so a later plugin-host RPC group can reuse the same
 * contracts. Declarations are derived on read from committed table entries
 * (fields documents were converted once at register).
 */
import { Context, Duration, Effect, Layer, Option, Schema as S, SubscriptionRef } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { AgentResumePlan } from "./agent-resume.ts";
import type { AgentSessionRef } from "./agent-session.ts";
import type { JsonSchemaObject } from "./command-cli.ts";
import { JsonSchemaObjectSchema } from "./command-cli.ts";
import { CommandError, COMMAND_TARGETS, type Meta, type RuntimeCommand } from "./commands.ts";
import type { DaemonSessionsService } from "./daemon-sessions.ts";
import { DaemonSessions } from "./daemon-sessions.ts";
import { errorMessage } from "./error-message.ts";
import { JsonValueSchema, type JsonValue } from "./effect/AttachProtocol.ts";
import {
  ForeignHarnessPlanResumeError,
  type ForeignHarnessAdapterLookup,
} from "./foreign-harness.ts";
import type {
  DaemonCommandsService,
  DaemonSessionCommandContext,
  TilingAlgorithmsService,
} from "./plugin/services.ts";
import type { PluginInstance } from "./plugin/contributions.ts";
import { TilingAlgorithmError } from "./tiling-algorithm.ts";
import { defaultTilingAlgorithm } from "./tiling-algorithm-default.ts";
import { TilingAnswerSchema, type TilingAnswer, type TilingOperation } from "./tiling-operation.ts";
import {
  PluginReducerError,
  WorkspaceReducerAnswerSchema,
  type QueuedPluginAction,
  type WorkspaceReadPackage,
  type WorkspaceReducerAnswer,
} from "./workspace-changes.ts";
import type { WorkspaceCommandContext } from "./workspace.ts";
import type { PluginHostGeneration } from "./plugin-host/client.ts";

/** Budget for one session-target plugin `run` (aligned with action execute). */
export const PLUGIN_SESSION_RUN_TIMEOUT_MS = 30_000;

export const QueuedPluginActionSchema = S.Struct({
  _tag: S.String,
  payload: JsonValueSchema,
});

export const PluginCommandMetaSchema = S.Struct({
  desc: S.String,
  group: S.String,
  target: S.Literals(COMMAND_TARGETS),
  exposure: S.Literals(["human", "agent"]),
});
export type PluginCommandMeta = typeof PluginCommandMetaSchema.Type;

/** Owner plugin id + generation — inspect, routing, and stale-generation checks. */
export const PluginDeclarationOwnerSchema = S.Struct({
  id: S.String,
  generation: S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(0))),
});
export type PluginDeclarationOwner = typeof PluginDeclarationOwnerSchema.Type;

export const PluginCommandDeclarationSchema = S.Struct({
  tag: S.String,
  meta: PluginCommandMetaSchema,
  fields: JsonSchemaObjectSchema,
  declaresResult: S.Boolean,
  actionTags: S.Array(S.String),
  paneTypes: S.Array(S.String),
  providers: S.Array(S.String),
  owner: PluginDeclarationOwnerSchema,
});
export type PluginCommandDeclaration = typeof PluginCommandDeclarationSchema.Type;

export const PluginAlgorithmDeclarationSchema = S.Struct({
  id: S.String,
  version: S.Finite,
  owner: PluginDeclarationOwnerSchema,
});
export type PluginAlgorithmDeclaration = typeof PluginAlgorithmDeclarationSchema.Type;

export const PluginAdapterDeclarationSchema = S.Struct({
  id: S.String,
  source: S.String,
  owner: PluginDeclarationOwnerSchema,
});
export type PluginAdapterDeclaration = typeof PluginAdapterDeclarationSchema.Type;

export const PluginDeclarationsSchema = S.Struct({
  commands: S.Array(PluginCommandDeclarationSchema),
  algorithms: S.Array(PluginAlgorithmDeclarationSchema),
  adapters: S.Array(PluginAdapterDeclarationSchema),
});
export type PluginDeclarations = typeof PluginDeclarationsSchema.Type;

/** Declarations when no plugin-host generation is live. */
export const emptyPluginDeclarations: PluginDeclarations = {
  commands: [],
  algorithms: [],
  adapters: [],
};

export class PluginBehaviourError extends S.TaggedError<PluginBehaviourError>()(
  "PluginBehaviourError",
  { message: S.String },
) {}

export interface PluginBehaviourService {
  /** Declarations derived from the current committed registries. */
  readonly declarations: Effect.Effect<PluginDeclarations>;

  readonly reduce: (
    command: RuntimeCommand,
    context: WorkspaceCommandContext,
    reads: WorkspaceReadPackage,
  ) => Effect.Effect<WorkspaceReducerAnswer, PluginReducerError>;

  readonly checkDescriptor: (
    type: string,
    descriptor: JsonValue,
  ) => Effect.Effect<JsonValue, PluginReducerError>;

  readonly runAction: (action: QueuedPluginAction) => Effect.Effect<void, PluginBehaviourError>;

  readonly runSession: (
    command: RuntimeCommand,
    context: DaemonSessionCommandContext,
  ) => Effect.Effect<JsonValue | undefined, CommandError>;

  readonly runTiling: (
    algorithmId: string,
    operation: TilingOperation,
  ) => Effect.Effect<TilingAnswer, TilingAlgorithmError>;

  readonly planResume: (
    adapterId: string,
    ref: AgentSessionRef,
  ) => Effect.Effect<Option.Option<AgentResumePlan>, ForeignHarnessPlanResumeError>;
}

export class PluginBehaviour extends Context.Service<PluginBehaviour, PluginBehaviourService>()(
  "amux/PluginBehaviour",
) {}

const ownerOf = (owner: PluginInstance): PluginDeclarationOwner => ({
  id: owner.id,
  generation: owner.generation,
});

const commandDeclarationFrom = (
  owner: PluginInstance,
  registration: {
    readonly tag: string;
    readonly meta: Meta;
    readonly result?: S.Top;
    readonly actions?: readonly { readonly tag: string }[];
    readonly paneTypes?: readonly { readonly type: string }[];
    readonly providers?: readonly { readonly provider: string }[];
  },
  fields: JsonSchemaObject,
): PluginCommandDeclaration => ({
  tag: registration.tag,
  meta: registration.meta,
  fields,
  declaresResult: registration.result !== undefined,
  actionTags: (registration.actions ?? []).map((action) => action.tag),
  paneTypes: (registration.paneTypes ?? []).map((entry) => entry.type),
  providers: (registration.providers ?? []).map((entry) => entry.provider),
  owner: ownerOf(owner),
});

/**
 * Build PluginBehaviour over the live command / algorithm / adapter tables.
 * Declarations are assembled on each read from committed entries. Sessions are
 * closed in once — host passes its process-scoped service; tests pass fakes.
 */
export const buildPluginBehaviour = (
  commands: DaemonCommandsService,
  algorithms: TilingAlgorithmsService,
  adapters: ForeignHarnessAdapterLookup,
  sessions: DaemonSessionsService,
): PluginBehaviourService => {
  const commandByTag = (tag: string) =>
    Option.fromNullishOr(
      commands.all().find((entry) => entry.value.command.tag === tag)?.value.command,
    );

  const algorithmById = (id: string) =>
    Option.fromNullishOr(
      algorithms
        .all()
        .find(
          (entry) =>
            entry.value.algorithm.id === id &&
            entry.value.algorithm.id !== defaultTilingAlgorithm.id,
        )?.value.algorithm,
    );

  const withSessions = <A, E>(effect: Effect.Effect<A, E, DaemonSessions>): Effect.Effect<A, E> =>
    effect.pipe(Effect.provideService(DaemonSessions, sessions));

  return {
    declarations: Effect.sync(() => ({
      commands: commands
        .all()
        .map((entry) =>
          commandDeclarationFrom(entry.owner, entry.value.command, entry.value.fields),
        ),
      algorithms: algorithms
        .all()
        .filter((entry) => entry.value.algorithm.id !== defaultTilingAlgorithm.id)
        .map((entry) => ({
          id: entry.value.algorithm.id,
          version: entry.value.algorithm.version,
          owner: ownerOf(entry.owner),
        })),
      adapters: adapters.all().map((entry) => ({
        id: entry.value.id,
        source: entry.value.source,
        owner: ownerOf(entry.owner),
      })),
    })),

    reduce: (command, context, reads) =>
      Effect.gen(function* () {
        const registration = Option.getOrUndefined(commandByTag(command._tag));
        if (registration?.reduce === undefined) {
          return yield* new PluginReducerError({
            message: `no reducer for command '${command._tag}'`,
          });
        }
        const answer = yield* registration
          .reduce({ command, context, reads })
          .pipe(
            Effect.mapError((error) =>
              S.is(PluginReducerError)(error)
                ? error
                : new PluginReducerError({ message: errorMessage(error) }),
            ),
          );
        return yield* S.decodeEffect(WorkspaceReducerAnswerSchema)(answer).pipe(
          Effect.mapError(
            (error) =>
              new PluginReducerError({
                message: `reducer for '${command._tag}' returned undecodable data: ${errorMessage(error)}`,
              }),
          ),
        );
      }),

    checkDescriptor: (type, descriptor) =>
      Effect.gen(function* () {
        const check = yield* Option.fromNullishOr(
          commands
            .all()
            .flatMap((entry) => entry.value.command.paneTypes ?? [])
            .find((entry) => entry.type === type)?.check,
        ).pipe(
          Option.match({
            onNone: () =>
              Effect.fail(new PluginReducerError({ message: `unknown pane type '${type}'` })),
            onSome: (value) => Effect.succeed(value),
          }),
        );
        return yield* check(descriptor);
      }),

    runAction: (action) =>
      withSessions(
        Effect.gen(function* () {
          const run = yield* Option.fromNullishOr(
            commands
              .all()
              .flatMap((entry) => entry.value.command.actions ?? [])
              .find((entry) => entry.tag === action._tag)?.run,
          ).pipe(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new PluginBehaviourError({ message: `unknown action '${action._tag}'` }),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          );
          yield* run(action).pipe(
            Effect.mapError((error) => new PluginBehaviourError({ message: errorMessage(error) })),
          );
        }),
      ),

    runSession: (command, context) =>
      withSessions(
        Effect.gen(function* () {
          const registration = yield* commandByTag(command._tag).pipe(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new CommandError({ message: `unknown daemon command '${command._tag}'` }),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          );
          if (registration.run === undefined) {
            return yield* new CommandError({
              message: `daemon command '${command._tag}' has no session handler`,
            });
          }
          const result = yield* registration.run(command, context);
          if (result === undefined) return undefined;
          return yield* S.decodeUnknownEffect(JsonValueSchema)(result).pipe(
            Effect.mapError(
              (error) =>
                new CommandError({
                  message: `session command '${command._tag}' result: ${errorMessage(error)}`,
                }),
            ),
          );
        }),
      ),

    runTiling: (algorithmId, operation) =>
      Effect.gen(function* () {
        const algorithm = yield* algorithmById(algorithmId).pipe(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TilingAlgorithmError({
                  algorithm: algorithmId,
                  message: `unknown tiling algorithm '${algorithmId}'`,
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        );
        const answer = yield* algorithm.run(operation);
        return yield* S.decodeEffect(TilingAnswerSchema)(answer).pipe(
          Effect.mapError(
            (error) =>
              new TilingAlgorithmError({
                algorithm: algorithmId,
                message: errorMessage(error),
              }),
          ),
        );
      }),

    planResume: (adapterId, ref) =>
      Effect.gen(function* () {
        const adapter = adapters.byId(adapterId);
        if (adapter === undefined) {
          return yield* new ForeignHarnessPlanResumeError({
            adapter: adapterId,
            message: `unknown adapter '${adapterId}'`,
          });
        }
        return yield* adapter.planResume(ref);
      }),
  };
};

/**
 * Session-target plugin run under {@link PLUGIN_SESSION_RUN_TIMEOUT_MS}.
 * `runRemote` and tests share this one site.
 */
export const runPluginSessionCommand = (
  command: RuntimeCommand,
  context: DaemonSessionCommandContext,
): Effect.Effect<JsonValue | undefined, CommandError, PluginBehaviour> =>
  Effect.gen(function* () {
    const behaviour = yield* PluginBehaviour;
    return yield* behaviour.runSession(command, context).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(PLUGIN_SESSION_RUN_TIMEOUT_MS),
        orElse: () =>
          Effect.fail(
            new CommandError({
              message: `session command '${command._tag}' timed out after ${PLUGIN_SESSION_RUN_TIMEOUT_MS}ms`,
            }),
          ),
      }),
    );
  });

export const asHostFailure = <A, E extends { readonly message: string }>(
  guard: (error: E | RpcClientError) => error is E,
  toError: (message: string) => E,
  effect: Effect.Effect<A, E | RpcClientError>,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.mapError((error) => (guard(error) ? error : toError(errorMessage(error)))),
    Effect.catchDefect((defect) => Effect.fail(toError(errorMessage(defect)))),
  );

const HOST_NOT_READY = "plugin host not ready";

/**
 * One slot read + Option match for host RPC methods. `notReady` runs when the
 * generation is empty; `call` receives the live generation.
 */
const withHostGeneration = <A, E>(
  slot: SubscriptionRef.SubscriptionRef<Option.Option<PluginHostGeneration>>,
  notReady: Effect.Effect<A, E>,
  call: (generation: PluginHostGeneration) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  SubscriptionRef.get(slot).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => notReady,
        onSome: call,
      }),
    ),
  );

/**
 * PluginBehaviour over the supervised host generation slot. Empty slot → empty
 * declarations / each method's typed "plugin host not ready" error.
 */
export const pluginBehaviourFromHostSlot = (
  slot: SubscriptionRef.SubscriptionRef<Option.Option<PluginHostGeneration>>,
): Layer.Layer<PluginBehaviour> =>
  Layer.succeed(PluginBehaviour, {
    declarations: SubscriptionRef.get(slot).pipe(
      Effect.map(
        Option.match({
          onNone: () => emptyPluginDeclarations,
          onSome: (generation) => generation.declarations,
        }),
      ),
    ),
    reduce: (command, context, reads) =>
      withHostGeneration(
        slot,
        Effect.fail(new PluginReducerError({ message: HOST_NOT_READY })),
        (generation) =>
          asHostFailure(
            S.is(PluginReducerError),
            (message) => new PluginReducerError({ message }),
            generation.client.Reduce({ command, context, reads }),
          ),
      ),
    checkDescriptor: (type, descriptor) =>
      withHostGeneration(
        slot,
        Effect.fail(new PluginReducerError({ message: HOST_NOT_READY })),
        (generation) =>
          asHostFailure(
            S.is(PluginReducerError),
            (message) => new PluginReducerError({ message }),
            generation.client.CheckDescriptor({ type, descriptor }),
          ),
      ),
    runAction: (action) =>
      withHostGeneration(
        slot,
        Effect.fail(new PluginBehaviourError({ message: HOST_NOT_READY })),
        (generation) =>
          asHostFailure(
            S.is(PluginBehaviourError),
            (message) => new PluginBehaviourError({ message }),
            generation.client.RunAction(action),
          ),
      ),
    runSession: (command, context) =>
      withHostGeneration(
        slot,
        Effect.fail(new CommandError({ message: HOST_NOT_READY })),
        (generation) =>
          asHostFailure(
            S.is(CommandError),
            (message) => new CommandError({ message }),
            generation.client.RunSession({ command, context }).pipe(
              // NDJSON collapses `undefined` to JSON null; Option restores absence.
              Effect.map(Option.getOrUndefined),
            ),
          ),
      ),
    runTiling: (algorithmId, operation) =>
      withHostGeneration(
        slot,
        Effect.fail(new TilingAlgorithmError({ algorithm: algorithmId, message: HOST_NOT_READY })),
        (generation) =>
          asHostFailure(
            S.is(TilingAlgorithmError),
            (message) => new TilingAlgorithmError({ algorithm: algorithmId, message }),
            generation.client.RunTiling({ algorithmId, operation }),
          ),
      ),
    planResume: (adapterId, ref) =>
      withHostGeneration(
        slot,
        Effect.fail(
          new ForeignHarnessPlanResumeError({ adapter: adapterId, message: HOST_NOT_READY }),
        ),
        (generation) =>
          asHostFailure(
            S.is(ForeignHarnessPlanResumeError),
            (message) => new ForeignHarnessPlanResumeError({ adapter: adapterId, message }),
            generation.client.PlanResume({ adapterId, ref }),
          ),
      ),
  });

/** Apply facts assembled from declarations for one command tag. */
export type PluginApplyFacts = {
  readonly declaresResult: boolean;
  readonly actionTags: ReadonlySet<string>;
  readonly paneTypes: ReadonlySet<string>;
  readonly providers: ReadonlySet<string>;
};

export const pluginApplyFromDeclarations = (
  declarations: PluginDeclarations,
  commandTag: string,
): PluginApplyFacts => {
  const command = declarations.commands.find((entry) => entry.tag === commandTag);
  return {
    declaresResult: command?.declaresResult ?? false,
    actionTags: new Set(command?.actionTags ?? []),
    paneTypes: new Set(declarations.commands.flatMap((entry) => entry.paneTypes)),
    providers: new Set(declarations.commands.flatMap((entry) => entry.providers)),
  } satisfies PluginApplyFacts;
};
