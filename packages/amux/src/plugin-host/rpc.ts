/**
 * Daemon ↔ plugin-host control plane: typed Effect RPC over a Unix socket
 * beside the daemon's control socket (`SessionPaths.pluginHost`).
 *
 * Same machinery as ControlRpcs. Behaviour methods mirror PluginBehaviourService;
 * Prepare/Publish/Discard stage and commit user `./daemon` plugins. The host is
 * never the PTY owner — a host crash leaves sessions untouched.
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
import { OwnerJsonText } from "../layout.ts";
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
import { PluginUiHalfSchema } from "../plugin/ui-announcement.ts";
import { TilingAlgorithmError } from "../tiling-algorithm.ts";
import { TilingAnswerSchema, TilingOperationSchema } from "../tiling-operation.ts";
import {
  PluginReducerError,
  WorkspaceReadPackageSchema,
  WorkspaceReducerAnswerSchema,
} from "../workspace-changes.ts";
import { WorkspaceCommandContextSchema } from "../workspace-command-context.ts";

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

/** Failures from importing specs during Prepare. Declarations stay on Publish. */
export const PluginHostPrepareResultSchema = S.Struct({
  failures: S.Array(PluginLoadFailureSchema),
});
export type PluginHostPrepareResult = typeof PluginHostPrepareResultSchema.Type;

/** Committed publication after Publish. */
export const PluginHostPublishResultSchema = S.Struct({
  declarations: PluginDeclarationsSchema,
  /** Host-assigned publication id; increases on each successful Publish in that process. */
  revision: PluginPublicationRevisionSchema,
  /** UI halves clients should load for this revision. */
  plugins: S.Array(PluginUiHalfSchema),
});
export type PluginHostPublishResult = typeof PluginHostPublishResultSchema.Type;

export const PluginHostEvalResultSchema = S.Struct({
  plugin: S.String,
  path: S.String,
});
export type PluginHostEvalResult = typeof PluginHostEvalResultSchema.Type;

export const PluginHostPromoteResultSchema = S.Struct({
  plugin: S.String,
  path: S.String,
});
export type PluginHostPromoteResult = typeof PluginHostPromoteResultSchema.Type;

export class PluginHostRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: S.Void, error: PluginHostError }),
  Rpc.make("Stop", { success: S.Void, error: PluginHostError }),
  Rpc.make("Prepare", {
    payload: PluginHostLoadInputSchema,
    success: PluginHostPrepareResultSchema,
    error: PluginHostError,
  }),
  Rpc.make("Publish", {
    success: PluginHostPublishResultSchema,
    error: PluginHostError,
  }),
  Rpc.make("Discard", {
    success: S.Void,
    error: PluginHostError,
  }),
  /** Materialize scratch source only; daemon runs Prepare/Publish afterward. */
  Rpc.make("Eval", {
    payload: {
      id: S.String.pipe(S.check(S.isMinLength(1))),
      source: S.String.pipe(S.check(S.isMinLength(1))),
    },
    success: PluginHostEvalResultSchema,
    error: PluginHostError,
  }),
  /** Write managed file + config, drop scratch; daemon Prepare/Publish afterward. */
  Rpc.make("Promote", {
    payload: { id: S.String.pipe(S.check(S.isMinLength(1))) },
    success: PluginHostPromoteResultSchema,
    error: PluginHostError,
  }),
  /** Upsert config enabled; daemon Prepare/Publish afterward. */
  Rpc.make("SetEnabled", {
    payload: {
      id: S.String.pipe(S.check(S.isMinLength(1))),
      enabled: S.Boolean,
    },
    success: S.Void,
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
      descriptor: OwnerJsonText,
    },
    success: OwnerJsonText,
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
