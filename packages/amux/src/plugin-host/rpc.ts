/**
 * Daemon ↔ plugin-host control plane: typed Effect RPC over a Unix socket
 * beside the daemon's control socket (`SessionPaths.pluginHost`).
 *
 * Same machinery as ControlRpcs. Behaviour methods mirror PluginBehaviourService;
 * Load reconciles user `./daemon` plugins. The host is never the PTY owner — a
 * host crash leaves sessions untouched.
 */
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { Layer, Schema as S } from "effect";
import { AgentResumePlanSchema } from "../agent-resume.ts";
import { AgentSessionRefSchema } from "../agent-session.ts";
import { CommandError, RuntimeCommandSchema } from "../commands.ts";
import { PluginHostLoadInputSchema } from "../config.ts";
import { JsonValueSchema } from "../effect/AttachProtocol.ts";
import { ForeignHarnessPlanResumeError } from "../foreign-harness.ts";
import { MAX_RPC_BYTES } from "../limits.ts";
import {
  PluginBehaviourError,
  PluginDeclarationsSchema,
  PluginLoadFailureSchema,
  PluginPublicationChanged,
  PluginPublicationRevisionSchema,
  QueuedPluginActionSchema,
} from "../plugin-behaviour.ts";
import { DaemonSessionCommandContextSchema } from "../plugin/services.ts";
import { TilingAlgorithmError } from "../tiling-algorithm.ts";
import { TilingAnswerSchema, TilingOperationSchema } from "../tiling-operation.ts";
import {
  PluginReducerError,
  WorkspaceReadPackageSchema,
  WorkspaceReducerAnswerSchema,
} from "../workspace-changes.ts";
import { WorkspaceCommandContextSchema } from "../workspace.ts";

export class PluginHostError extends S.TaggedError<PluginHostError>()("PluginHostError", {
  message: S.String,
}) {}

/** Lifecycle the daemon reports for its supervised plugin-host child. */
export const PluginHostState = S.Literals(["starting", "ready", "restarting", "failed"]);
export type PluginHostState = typeof PluginHostState.Type;

export const PluginHostStatusSchema = S.Struct({
  state: PluginHostState,
  restarts: S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(0))),
  lastError: S.optional(S.String),
  /** Set while a supervised child is running. */
  pid: S.optional(S.Int.pipe(S.check(S.isGreaterThan(0)))),
});
export type PluginHostStatus = typeof PluginHostStatusSchema.Type;

/** Declarations plus every enabled spec that failed to import or pass compat. */
export const PluginHostLoadResultSchema = S.Struct({
  declarations: PluginDeclarationsSchema,
  failures: S.Array(PluginLoadFailureSchema),
  /** Host-assigned publication id; increases on each successful Load in that process. */
  revision: PluginPublicationRevisionSchema,
});
export type PluginHostLoadResult = typeof PluginHostLoadResultSchema.Type;

export class PluginHostRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: S.Void, error: PluginHostError }),
  Rpc.make("Stop", { success: S.Void, error: PluginHostError }),
  Rpc.make("Load", {
    payload: PluginHostLoadInputSchema,
    success: PluginHostLoadResultSchema,
    error: PluginHostError,
  }),
  Rpc.make("Reduce", {
    payload: {
      revision: PluginPublicationRevisionSchema,
      command: RuntimeCommandSchema,
      context: WorkspaceCommandContextSchema,
      reads: WorkspaceReadPackageSchema,
    },
    success: WorkspaceReducerAnswerSchema,
    error: S.Union([PluginReducerError, PluginPublicationChanged]),
  }),
  Rpc.make("CheckDescriptor", {
    payload: {
      revision: PluginPublicationRevisionSchema,
      type: S.String,
      descriptor: JsonValueSchema,
    },
    success: JsonValueSchema,
    error: S.Union([PluginReducerError, PluginPublicationChanged]),
  }),
  Rpc.make("RunAction", {
    payload: {
      revision: PluginPublicationRevisionSchema,
      action: QueuedPluginActionSchema,
    },
    success: S.Void,
    error: S.Union([PluginBehaviourError, PluginPublicationChanged]),
  }),
  Rpc.make("RunSession", {
    payload: {
      revision: PluginPublicationRevisionSchema,
      command: RuntimeCommandSchema,
      context: DaemonSessionCommandContextSchema,
    },
    // Option: NDJSON cannot round-trip `undefined` (becomes JSON null).
    success: S.Option(JsonValueSchema),
    error: S.Union([CommandError, PluginPublicationChanged]),
  }),
  Rpc.make("RunTiling", {
    payload: {
      revision: PluginPublicationRevisionSchema,
      algorithmId: S.String,
      operation: TilingOperationSchema,
    },
    success: TilingAnswerSchema,
    error: S.Union([TilingAlgorithmError, PluginPublicationChanged]),
  }),
  Rpc.make("PlanResume", {
    payload: {
      revision: PluginPublicationRevisionSchema,
      adapterId: S.String,
      ref: AgentSessionRefSchema,
    },
    success: S.Option(AgentResumePlanSchema),
    error: S.Union([ForeignHarnessPlanResumeError, PluginPublicationChanged]),
  }),
) {}

export type PluginHostHandlers = Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof PluginHostRpcs>>>;

export const PluginHostSerialization: Layer.Layer<RpcSerialization.RpcSerialization> =
  Layer.succeed(
    RpcSerialization.RpcSerialization,
    RpcSerialization.makeNdjson({ maxBufferSize: MAX_RPC_BYTES }),
  );
