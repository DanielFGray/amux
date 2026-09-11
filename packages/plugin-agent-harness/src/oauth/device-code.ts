/**
 * RFC 8628-style device-code poll loop.
 * Borrow: oh-my-pi `packages/ai/src/registry/oauth/device-code.ts`.
 *
 * Provider adapters supply `poll`; this module owns pending / slow_down /
 * complete / failed cadence and timeout. Cancel = fiber interrupt.
 *
 * Call sites must pass an explicit success type (`pollDeviceCodeFlow<T>(…)`)
 * when `poll` is a multi-branch `Effect.gen`: TS otherwise infers
 * `T | undefined` from the generator’s implicit undefined return.
 */
import { Duration, Effect, Match, Option } from "effect";
import { OAuthFailed, OAuthTimeout } from "./types.ts";

const MINIMUM_INTERVAL_MS = 1_000;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_MS = 5_000;

export type DeviceCodePollResult<T> =
  | { readonly status: "complete"; readonly value: T }
  | { readonly status: "pending" }
  | { readonly status: "slow_down" }
  | { readonly status: "failed"; readonly message: string };

export type DeviceCodeFlowOptions<T> = {
  readonly poll: Effect.Effect<DeviceCodePollResult<T>, OAuthFailed>;
  readonly intervalSeconds?: number;
  readonly expiresInSeconds?: number;
};

const timedOut = (slowDownResponses: number) =>
  new OAuthTimeout({
    message:
      slowDownResponses > 0
        ? "Device flow timed out after one or more slow_down responses"
        : "Device flow timed out",
  });

export const pollDeviceCodeFlow = <T>(
  options: DeviceCodeFlowOptions<T>,
): Effect.Effect<T, OAuthFailed | OAuthTimeout> => {
  const intervalMs0 = Math.max(
    MINIMUM_INTERVAL_MS,
    Math.floor((options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1_000),
  );

  const step = (
    intervalMs: number,
    slowDownResponses: number,
    deadline: number,
  ): Effect.Effect<T, OAuthFailed | OAuthTimeout> =>
    Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
      Effect.flatMap((now) => {
        if (now >= deadline) return timedOut(slowDownResponses);
        return options.poll.pipe(
          Effect.flatMap((result) =>
            Match.value(result).pipe(
              Match.discriminatorsExhaustive("status")({
                complete: ({ value }) => Effect.succeed(value),
                failed: ({ message }) => new OAuthFailed({ message, kind: "polling" }),
                pending: () => sleepThenStep(intervalMs, slowDownResponses, deadline),
                slow_down: () =>
                  sleepThenStep(
                    Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INCREMENT_MS),
                    slowDownResponses + 1,
                    deadline,
                  ),
              }),
            ),
          ),
        );
      }),
    );

  const sleepThenStep = (
    intervalMs: number,
    slowDownResponses: number,
    deadline: number,
  ): Effect.Effect<T, OAuthFailed | OAuthTimeout> =>
    Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
      Effect.flatMap((now) => {
        const remaining = deadline - now;
        if (remaining <= 0) return timedOut(slowDownResponses);
        return Effect.sleep(Duration.millis(Math.min(intervalMs, remaining))).pipe(
          Effect.flatMap(() => step(intervalMs, slowDownResponses, deadline)),
        );
      }),
    );

  return Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
    Effect.flatMap((started) => {
      const deadline = Option.match(Option.fromNullishOr(options.expiresInSeconds), {
        onNone: () => Number.POSITIVE_INFINITY,
        onSome: (seconds) => started + seconds * 1_000,
      });
      return step(intervalMs0, 0, deadline);
    }),
  );
};
