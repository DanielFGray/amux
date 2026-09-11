/**
 * PKCE (RFC 7636) verifier + S256 challenge.
 * Borrow: oh-my-pi `packages/ai/src/registry/oauth/pkce.ts`.
 */
import { Effect, Encoding } from "effect";

export type PkceCodes = {
  readonly verifier: string;
  readonly challenge: string;
};

export const generatePkce: Effect.Effect<PkceCodes> = Effect.gen(function* () {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(96));
  const verifier = Encoding.encodeBase64Url(verifierBytes);
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge: Encoding.encodeBase64Url(new Uint8Array(digest)) };
});

/** CSRF state token for the authorize redirect. */
export const generateState: Effect.Effect<string> = Effect.sync(() =>
  Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
);
