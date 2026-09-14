/**
 * Daemon → plugin-host capability plane: DaemonSessions over a Unix socket
 * that only the supervised host child may use (`SessionPaths.pluginCapabilities`).
 *
 * Separate from PluginHostRpcs (Ping/Stop lifecycle). Same ndjson framing and
 * byte cap as the other Effect RPC groups.
 */
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { Layer, Schema as S } from "effect";
import { DaemonSessionsError } from "../daemon-sessions.ts";
import { JsonValueSchema } from "../effect/AttachProtocol.ts";
import { PromptOptionsSchema } from "../effect/SessionRegistry.ts";
import { MAX_RPC_BYTES } from "../limits.ts";

export class DaemonSessionsRpcs extends RpcGroup.make(
  Rpc.make("Message", {
    payload: { id: S.String, message: JsonValueSchema },
    success: S.Void,
    error: DaemonSessionsError,
  }),
  Rpc.make("Prompt", {
    payload: {
      target: S.String,
      text: S.String,
      options: S.optional(PromptOptionsSchema),
    },
    success: S.Void,
    error: DaemonSessionsError,
  }),
  Rpc.make("Capture", {
    payload: { session: S.String },
    success: S.String,
    error: DaemonSessionsError,
  }),
) {}

export const DaemonSessionsSerialization: Layer.Layer<RpcSerialization.RpcSerialization> =
  Layer.succeed(
    RpcSerialization.RpcSerialization,
    RpcSerialization.makeNdjson({ maxBufferSize: MAX_RPC_BYTES }),
  );
