/**
 * Shared OAuth dance types — provider adapters stay thin wrappers over these.
 * Borrow shape: oh-my-pi `packages/ai/src/registry/oauth/types.ts`.
 */
import { Schema as S, type Effect } from "effect";

export class OAuthCancelled extends S.TaggedError<OAuthCancelled>()("OAuthCancelled", {
  message: S.String,
}) {}

export class OAuthFailed extends S.TaggedError<OAuthFailed>()("OAuthFailed", {
  message: S.String,
  kind: S.optional(
    S.Literals([
      "validation",
      "token-exchange",
      "polling",
      "timeout",
      "csrf",
      "port",
      "device-auth",
    ]),
  ),
}) {}

export class OAuthTimeout extends S.TaggedError<OAuthTimeout>()("OAuthTimeout", {
  message: S.String,
}) {}

export class OAuthPortInUse extends S.TaggedError<OAuthPortInUse>()("OAuthPortInUse", {
  port: S.Finite,
  message: S.String,
}) {}

export type OAuthError = OAuthCancelled | OAuthFailed | OAuthTimeout | OAuthPortInUse;

/** What the UI should show / open when the authorize step is ready. */
export type AuthInfo = {
  readonly url: string;
  /**
   * Short loopback URL that 302s to `url`. Prefer as a copy target when present
   * so viewport truncation cannot corrupt OAuth query parameters.
   */
  readonly launchUrl?: string;
  readonly instructions?: string;
};

/**
 * UI/CLI implements this once; every provider login Effect talks through it.
 * Cancel is Scope interrupt / fiber interrupt — no separate AbortSignal.
 */
export type OAuthFlowController = {
  readonly onAuth: (info: AuthInfo) => Effect.Effect<void>;
  readonly onProgress: (message: string) => Effect.Effect<void>;
  /** Paste path (SSH / no loopback). Interrupt cancels as OAuthCancelled. */
  readonly onManualCodeInput: Effect.Effect<string, OAuthCancelled>;
};
