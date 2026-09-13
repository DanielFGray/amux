import { Effect, Logger } from "effect";

/** Capture Effect log lines into a sink for assertions. */
export const withCollectingLogger = <A, E>(effect: Effect.Effect<A, E>, sink: string[]) =>
  effect.pipe(
    Effect.withLogger(
      Logger.make(({ message }) => {
        const text = Array.isArray(message)
          ? message.map(String).join(" ")
          : typeof message === "string"
            ? message
            : String(message);
        sink.push(text);
      }),
    ),
  );
