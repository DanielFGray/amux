/**
 * Race loopback callback against a pasted code/URL.
 * Borrow: oh-my-pi OAuthCallbackFlow.#waitForCallback candidate race.
 */
import { Effect } from "effect";
import type { CallbackResult, LoopbackCallback } from "./callback.ts";
import { parseCallbackInput } from "./paste.ts";
import type { OAuthFlowController, OAuthTimeout } from "./types.ts";
import { OAuthCancelled, OAuthFailed } from "./types.ts";

export const awaitAuthorizationCode = (args: {
  readonly ctl: OAuthFlowController;
  readonly expectedState: string;
  readonly loopback?: LoopbackCallback;
}): Effect.Effect<CallbackResult, OAuthFailed | OAuthCancelled | OAuthTimeout> => {
  const fromPaste = args.ctl.onManualCodeInput.pipe(
    Effect.flatMap((input) => {
      const parsed = parseCallbackInput(input);
      if (!parsed.code) {
        return Effect.fail(
          new OAuthFailed({
            message: "Pasted input did not contain an authorization code",
            kind: "validation",
          }),
        );
      }
      if (parsed.state !== undefined && parsed.state !== args.expectedState) {
        return Effect.fail(
          new OAuthFailed({ message: "Invalid state — possible CSRF", kind: "csrf" }),
        );
      }
      return Effect.succeed({
        code: parsed.code,
        state: parsed.state ?? args.expectedState,
      } satisfies CallbackResult);
    }),
  );

  if (args.loopback === undefined) return fromPaste;
  return Effect.raceFirst(args.loopback.awaitCode, fromPaste);
};
