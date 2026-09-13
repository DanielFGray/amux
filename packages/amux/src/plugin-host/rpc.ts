/**
 * Daemon ↔ plugin-host control plane: typed Effect RPC over a Unix socket
 * beside the daemon's control socket (`SessionPaths.pluginHost`).
 *
 * Same machinery as ControlRpcs. This group starts with Ping and Stop; later
 * tasks add plugin calls. The host is never the PTY owner — a host crash
 * leaves sessions untouched.
 */
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { Layer, Schema as S } from "effect";
import { MAX_RPC_BYTES } from "../limits.ts";

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

export class PluginHostRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: S.Void, error: PluginHostError }),
  Rpc.make("Stop", { success: S.Void, error: PluginHostError }),
) {}

export type PluginHostHandlers = Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof PluginHostRpcs>>>;

export const PluginHostSerialization: Layer.Layer<RpcSerialization.RpcSerialization> =
  Layer.succeed(
    RpcSerialization.RpcSerialization,
    RpcSerialization.makeNdjson({ maxBufferSize: MAX_RPC_BYTES }),
  );
