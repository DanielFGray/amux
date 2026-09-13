/**
 * Session-provider handle: typed firstMessage builder. Apply only checks that
 * the provider id is registered.
 */
import { Effect, Schema as S } from "effect";
import {
  encodeOwner,
  encodedFirstMessage,
  type EncodedFirstMessage,
} from "./workspace-change-builders.ts";
import { PluginReducerError } from "./workspace-changes.ts";

export type SessionProviderHandle<M> = {
  readonly provider: string;
  readonly message: (value: M) => Effect.Effect<EncodedFirstMessage, PluginReducerError>;
};

/** Registration entry — provider id for apply; reducer closes over the typed handle. */
export type ProviderMessageRegistration = {
  readonly provider: string;
};

/** Declare a session provider's firstMessage Schema for plugin builders. */
export function defineSessionProvider<M>(
  provider: string,
  schema: S.Codec<M>,
): SessionProviderHandle<M> {
  const encode = encodeOwner(schema, `session.add firstMessage for provider '${provider}'`);
  return {
    provider,
    message: (value) =>
      Effect.gen(function* () {
        const wire = yield* encode(value);
        return encodedFirstMessage(wire);
      }),
  };
}
