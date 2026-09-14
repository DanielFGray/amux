/**
 * Typed RPC client for PluginHostRpcs — kept separate from the supervisor so
 * plugin-behaviour can depend on the client type without importing spawn logic.
 */
import type { Effect, Option } from "effect";
import type * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import type { AgentResumePlan } from "../agent-resume.ts";
import type { AgentSessionRef } from "../agent-session.ts";
import type { CommandError, RuntimeCommand } from "../commands.ts";
import type { PluginHostLoadInput } from "../config.ts";
import type { JsonValue } from "../effect/AttachProtocol.ts";
import type { ForeignHarnessPlanResumeError } from "../foreign-harness.ts";
import type {
  PluginBehaviourError,
  PluginDeclarations,
  PluginPublicationChanged,
  PluginPublicationRevision,
} from "../plugin-behaviour.ts";
import type { DaemonSessionCommandContext } from "../plugin/services.ts";
import type { TilingAlgorithmError } from "../tiling-algorithm.ts";
import type { TilingAnswer, TilingOperation } from "../tiling-operation.ts";
import type {
  PluginReducerError,
  QueuedPluginAction,
  WorkspaceReadPackage,
  WorkspaceReducerAnswer,
} from "../workspace-changes.ts";
import type { WorkspaceCommandContext } from "../workspace.ts";
import type { PluginHostError, PluginHostLoadResult, PluginHostRpcs } from "./rpc.ts";

export type PluginHostClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof PluginHostRpcs>,
  RpcClientError
>;

/**
 * Methods a publication binding and the daemon may invoke on the live host
 * client. Hand-written so plain test doubles satisfy it; the real RPC client
 * is assignable at call sites. Includes Load/Stop for reload and generation
 * teardown (supervisor).
 */
export type PluginHostBehaviourCalls = {
  readonly Reduce: (payload: {
    readonly revision: PluginPublicationRevision;
    readonly command: RuntimeCommand;
    readonly context: WorkspaceCommandContext;
    readonly reads: WorkspaceReadPackage;
  }) => Effect.Effect<
    WorkspaceReducerAnswer,
    PluginReducerError | PluginPublicationChanged | RpcClientError
  >;
  readonly CheckDescriptor: (payload: {
    readonly revision: PluginPublicationRevision;
    readonly type: string;
    readonly descriptor: JsonValue;
  }) => Effect.Effect<JsonValue, PluginReducerError | PluginPublicationChanged | RpcClientError>;
  readonly RunAction: (payload: {
    readonly revision: PluginPublicationRevision;
    readonly action: QueuedPluginAction;
  }) => Effect.Effect<void, PluginBehaviourError | PluginPublicationChanged | RpcClientError>;
  readonly RunSession: (payload: {
    readonly revision: PluginPublicationRevision;
    readonly command: RuntimeCommand;
    readonly context: DaemonSessionCommandContext;
  }) => Effect.Effect<
    Option.Option<JsonValue>,
    CommandError | PluginPublicationChanged | RpcClientError
  >;
  readonly RunTiling: (payload: {
    readonly revision: PluginPublicationRevision;
    readonly algorithmId: string;
    readonly operation: TilingOperation;
  }) => Effect.Effect<
    TilingAnswer,
    TilingAlgorithmError | PluginPublicationChanged | RpcClientError
  >;
  readonly PlanResume: (payload: {
    readonly revision: PluginPublicationRevision;
    readonly adapterId: string;
    readonly ref: AgentSessionRef;
  }) => Effect.Effect<
    Option.Option<AgentResumePlan>,
    ForeignHarnessPlanResumeError | PluginPublicationChanged | RpcClientError
  >;
  readonly Load: (
    input: PluginHostLoadInput,
  ) => Effect.Effect<PluginHostLoadResult, PluginHostError | RpcClientError>;
  readonly Stop: () => Effect.Effect<void, PluginHostError | RpcClientError>;
};

/**
 * One published host image. Default {@link Client} is the full RPC client;
 * bindings and tests may use a narrower {@link PluginHostBehaviourCalls}.
 */
export type PluginPublication<Client extends PluginHostBehaviourCalls = PluginHostClient> = {
  readonly client: Client;
  readonly revision: PluginPublicationRevision;
  readonly declarations: PluginDeclarations;
};
