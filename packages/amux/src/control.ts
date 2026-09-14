/**
 * The daemon's control plane: a typed `@effect/rpc` group carried as NDJSON
 * over the session's Unix socket (`paths.socket`).
 *
 * The control plane is request/response only. Terminal bytes and workspace
 * pushes stay on the separate attach data plane (`paths.attach`), which has
 * its own framing and its own back-pressure story.
 *
 * Workspace snapshots cross this boundary as JSON text rather than as a
 * structured payload, the same way attach frames carry them: the snapshot is
 * revalidated by `parseWorkspace` on arrival, whose relational checks (panes
 * naming live agents) no structural schema can express.
 */
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { Layer, Schema as S } from "effect";
import { TextEdit } from "@danielfgray/amux-text-buffer";
import { WireCommand } from "./commands.ts";
import { DaemonEvent } from "./effect/EventBus.ts";
import { AgentEvent } from "./effect/AttachProtocol.ts";
import { MAX_RPC_BYTES } from "./limits.ts";
import { PluginDeclarationsSchema, PluginPublicationRevisionSchema } from "./plugin-behaviour.ts";
import { PluginPublicationAnnouncementSchema } from "./plugin/ui-announcement.ts";
import { PluginHostStatusSchema } from "./plugin-host/rpc.ts";
import { SessionStateSchema } from "./session.ts";
import { WorkspaceCommandContextSchema } from "./workspace.ts";

/** The single failure channel of every control procedure. */
export class ControlError extends S.TaggedError<ControlError>()("ControlError", {
  message: S.String,
}) {}

const WorkspaceJson = S.String;

const BufferEntrySchema = S.Struct({
  name: S.String,
  bytes: S.Int,
  preview: S.String,
});

const DocumentMetaSchema = S.Struct({
  uri: S.String,
  generation: S.Int,
  dirty: S.Boolean,
  lineCount: S.Int,
  byteLength: S.Int,
  charCount: S.Int,
  refs: S.Int,
});

const DocumentSnapshotSchema = S.Struct({
  ...DocumentMetaSchema.fields,
  text: S.String,
});

const AttachInfoSchema = S.Struct({
  attached: S.Boolean,
  attachedSince: S.optional(S.Finite),
  attachLastSeen: S.optional(S.Finite),
});

const StatusSchema = S.Struct({
  ...AttachInfoSchema.fields,
  session: SessionStateSchema,
  workspace: WorkspaceJson,
  /** Sessions the daemon owns for client adoption: running PTYs plus
   *  parked foreign-agent resumes. Not "has a PTY right now". */
  agents: S.Array(S.String),
  /** Supervised plugin-host child: state, restart count, last error. */
  pluginHost: PluginHostStatusSchema,
  /** Current host publication revision for humans / status CLI — not the load path. */
  pluginPublicationRevision: S.optional(PluginPublicationRevisionSchema),
  /**
   * Per control-connection UI readiness, keyed by Rpc.ServerClient.id.
   * One client attaches many sessions; readiness is not per SessionAttachment.
   */
  pluginUiByClient: S.optional(
    S.Record(
      S.String,
      S.Struct({
        revision: PluginPublicationRevisionSchema,
        plugins: S.Array(
          S.Struct({
            key: S.String,
            digest: S.String,
            ready: S.Boolean,
            error: S.optional(S.String),
          }),
        ),
      }),
    ),
  ),
  /** Set when the daemon is degraded but still serving: heartbeat or an
   *  outstanding durable obligation. Not a request failure. */
  degraded: S.optional(S.String),
});

export const PluginUiReadyReportSchema = S.Struct({
  revision: PluginPublicationRevisionSchema,
  plugins: S.Array(
    S.Struct({
      key: S.String,
      digest: S.String,
      ready: S.Boolean,
      error: S.optional(S.String),
    }),
  ),
});
export type PluginUiReadyReport = typeof PluginUiReadyReportSchema.Type;

/**
 * A command's result is defined by the command itself (`COMMAND_META[tag].result`),
 * so it cannot be narrowed at the group level; the caller decodes it with the
 * schema its own tag declares.
 */
const BatchOutputSchema = S.Struct({
  result: S.optional(S.Unknown),
  workspace: S.optional(WorkspaceJson),
});

const BatchResultSchema = S.Struct({ outputs: S.Array(BatchOutputSchema) });

export class ControlRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: AttachInfoSchema, error: ControlError }),
  Rpc.make("Status", { success: StatusSchema, error: ControlError }),
  Rpc.make("PluginDeclarations", {
    success: PluginDeclarationsSchema,
    error: ControlError,
  }),
  Rpc.make("Stop", { success: S.Void, error: ControlError }),
  Rpc.make("Batch", {
    payload: {
      values: S.Array(WireCommand),
      expectedRevision: S.optional(S.Int),
      context: S.optional(WorkspaceCommandContextSchema),
    },
    success: BatchResultSchema,
    error: ControlError,
  }),
  Rpc.make("ResumeAgent", {
    payload: {
      session: S.String,
      provider: S.String,
      argv: S.optional(S.Array(S.String).pipe(S.check(S.isMinLength(1)))),
      env: S.optional(S.Record(S.String, S.String)),
      stripEnv: S.optional(S.Array(S.String)),
    },
    success: S.Void,
    error: ControlError,
  }),
  Rpc.make("SetBuffer", {
    payload: { name: S.optional(S.String), data: S.String },
    success: S.String,
    error: ControlError,
  }),
  Rpc.make("PasteBuffer", {
    payload: {
      name: S.optional(S.String),
      target: S.String,
      deleteAfter: S.optional(S.Boolean),
    },
    success: S.Void,
    error: ControlError,
  }),
  Rpc.make("ListBuffers", {
    success: S.Array(BufferEntrySchema),
    error: ControlError,
  }),
  Rpc.make("DeleteBuffer", {
    payload: { name: S.optional(S.String) },
    success: S.Void,
    error: ControlError,
  }),
  Rpc.make("ShowBuffer", {
    payload: { name: S.optional(S.String) },
    success: S.String,
    error: ControlError,
  }),
  // Open documents — same ownership plane as paste buffers. Generation-checked
  // apply/write so editor and agent share one sequenced authority.
  Rpc.make("DocumentOpen", {
    payload: { uri: S.String, text: S.optional(S.String) },
    success: DocumentMetaSchema,
    error: ControlError,
  }),
  Rpc.make("DocumentApply", {
    payload: {
      uri: S.String,
      baseGeneration: S.Int,
      edits: S.Array(TextEdit),
    },
    success: DocumentMetaSchema,
    error: ControlError,
  }),
  Rpc.make("DocumentWrite", {
    payload: { uri: S.String, baseGeneration: S.Int, text: S.String },
    success: DocumentMetaSchema,
    error: ControlError,
  }),
  Rpc.make("DocumentSnapshot", {
    payload: { uri: S.String },
    success: DocumentSnapshotSchema,
    error: ControlError,
  }),
  Rpc.make("DocumentSlice", {
    payload: { uri: S.String, start: S.Int, end: S.Int },
    success: S.Array(S.String),
    error: ControlError,
  }),
  Rpc.make("DocumentSave", {
    payload: { uri: S.String },
    success: DocumentMetaSchema,
    error: ControlError,
  }),
  Rpc.make("DocumentClose", {
    payload: { uri: S.String, force: S.optional(S.Boolean) },
    success: S.Void,
    error: ControlError,
  }),
  Rpc.make("DocumentList", {
    success: S.Array(DocumentMetaSchema),
    error: ControlError,
  }),
  /** Live document snapshots. Optional `uri` filters; seed emits the current open set. */
  Rpc.make("DocumentWatch", {
    payload: { uri: S.optional(S.String) },
    success: DocumentSnapshotSchema,
    stream: true,
  }),
  Rpc.make("Events", { success: DaemonEvent, stream: true }),
  /**
   * Host publication announcements. Built from SubscriptionRef.changes so the
   * current value arrives first — late clients need no Status read for loading.
   */
  Rpc.make("PluginPublications", {
    success: PluginPublicationAnnouncementSchema,
    stream: true,
  }),
  /** Report this control connection's UI half readiness (keyed by ServerClient.id). */
  Rpc.make("ReportPluginUiReady", {
    payload: PluginUiReadyReportSchema,
    success: S.Void,
    error: ControlError,
  }),
  Rpc.make("AgentCursor", {
    payload: { session: S.String },
    success: S.Int,
    error: ControlError,
  }),
  Rpc.make("AgentWatch", {
    payload: {
      session: S.String,
      after: S.optional(S.Int.check(S.isGreaterThanOrEqualTo(0))),
    },
    success: AgentEvent,
    stream: true,
  }),
) {}

/**
 * NDJSON framing bounded by the same limit the old HTTP body reader enforced.
 * The serializer raises `RpcSerializationError` and tears the connection down
 * before an oversized line is ever parsed.
 */
export const ControlSerialization: Layer.Layer<RpcSerialization.RpcSerialization> = Layer.succeed(
  RpcSerialization.RpcSerialization,
  RpcSerialization.makeNdjson({ maxBufferSize: MAX_RPC_BYTES }),
);
