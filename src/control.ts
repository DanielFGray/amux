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
import * as Rpc from "@effect/rpc/Rpc";
import * as RpcGroup from "@effect/rpc/RpcGroup";
import * as RpcSerialization from "@effect/rpc/RpcSerialization";
import { Layer, Schema as S } from "effect";
import { Command } from "./commands.ts";
import { MAX_RPC_BYTES } from "./limits.ts";
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

const AttachInfoSchema = S.Struct({
  attached: S.Boolean,
  attachedSince: S.optional(S.Number),
  attachLastSeen: S.optional(S.Number),
});

const StatusSchema = S.Struct({
  ...AttachInfoSchema.fields,
  session: SessionStateSchema,
  workspace: WorkspaceJson,
  agents: S.Array(S.String),
  /** Set when the daemon is degraded but still serving: heartbeat or an
   *  outstanding durable obligation. Not a request failure. */
  degraded: S.optional(S.String),
});

/**
 * A command's result is defined by the command itself (`COMMAND_META[tag].result`),
 * so it cannot be narrowed at the group level; the caller decodes it with the
 * schema its own tag declares.
 */
const RunResultSchema = S.Struct({
  result: S.optional(S.Unknown),
  workspace: S.optional(WorkspaceJson),
});

export class ControlRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: AttachInfoSchema, error: ControlError }),
  Rpc.make("Status", { success: StatusSchema, error: ControlError }),
  Rpc.make("Stop", { success: S.Void, error: ControlError }),
  Rpc.make("WorkspaceCommand", {
    payload: {
      value: Command,
      expectedRevision: S.Int,
      context: WorkspaceCommandContextSchema,
    },
    success: WorkspaceJson,
    error: ControlError,
  }),
  Rpc.make("Run", {
    payload: {
      value: Command,
      expectedRevision: S.optional(S.Int),
      context: S.optional(WorkspaceCommandContextSchema),
    },
    success: RunResultSchema,
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
  Rpc.make("ListBuffers", { success: S.Array(BufferEntrySchema), error: ControlError }),
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
