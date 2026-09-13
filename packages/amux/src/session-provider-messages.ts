/**
 * Session-provider message codecs — validates `session.add` `firstMessage`
 * (and the same shape ResumeAgent delivers via `DaemonSessions.message`).
 *
 * Client {@link SpawnProvidersTag} only supplies argv/env. A provider's
 * message Schema is declared on the daemon plugin registration; the daemon
 * builds codecs into {@link WorkspaceTransactionPlugins}. No module-level map.
 */
import { Schema as S } from "effect";
import { ownerJsonCodec, type OwnerJsonCodec } from "./workspace-changes.ts";

export type ProviderMessageCodec = OwnerJsonCodec;

export type ProviderMessageRegistration = {
  readonly provider: string;
  readonly codec: ProviderMessageCodec;
};

/** Close over `provider`'s message Schema for firstMessage storage encoding. */
export function sessionProviderMessageCodec<A>(
  provider: string,
  schema: S.Codec<A>,
): ProviderMessageRegistration {
  return {
    provider,
    codec: ownerJsonCodec(schema, `session.add firstMessage for provider '${provider}'`),
  };
}
