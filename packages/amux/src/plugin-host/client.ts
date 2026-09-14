/**
 * Typed RPC client for PluginHostRpcs — kept separate from the supervisor so
 * plugin-behaviour can depend on the client type without importing spawn logic.
 */
import type * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import type { PluginDeclarations } from "../plugin-behaviour.ts";
import type { PluginHostRpcs } from "./rpc.ts";

export type PluginHostClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof PluginHostRpcs>,
  RpcClientError
>;

/** One ready generation: live client plus the declarations Load returned. */
export type PluginHostGeneration = {
  readonly client: PluginHostClient;
  readonly declarations: PluginDeclarations;
};
