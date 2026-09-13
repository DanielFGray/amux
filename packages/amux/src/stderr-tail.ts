/**
 * Bounded stderr capture for supervised children.
 *
 * A process that dies before it can speak its protocol says why on stderr.
 * Kept bounded so a child looping on a warning cannot grow the parent's memory.
 *
 * `makeStderrTail` creates the value synchronously; `tail.drain` fills it and
 * completes when the stream ends.
 */
import { Effect, Stream } from "effect";

export const STDERR_TAIL_CHARS = 8192;

export interface StderrTail {
  /** Most recent stderr bytes, truncated to {@link STDERR_TAIL_CHARS}. */
  readonly text: () => string;
  /** True when older bytes were dropped to stay within the bound. */
  readonly dropped: () => boolean;
  /**
   * Drain an async byte stream into this tail. Completes when the stream ends
   * or errors. Does not require Scope — fork or join as the caller needs.
   */
  readonly drain: (
    stream: AsyncIterable<Uint8Array>,
    onChunk?: (text: string) => void,
  ) => Effect.Effect<void>;
}

/** Create an empty tail whose {@link StderrTail.drain} fills it. */
export const makeStderrTail = (): StderrTail => {
  let stderrTail = "";
  let stderrDropped = false;
  const decoder = new TextDecoder();
  return {
    text: () => stderrTail,
    dropped: () => stderrDropped,
    drain: (stream, onChunk) =>
      Stream.fromAsyncIterable(stream, () => "stderr read failed").pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            const text = decoder.decode(chunk, { stream: true });
            if (!text) return;
            onChunk?.(text);
            stderrTail += text;
            if (stderrTail.length > STDERR_TAIL_CHARS) {
              stderrTail = stderrTail.slice(-STDERR_TAIL_CHARS);
              stderrDropped = true;
            }
          }),
        ),
        Effect.ignore,
      ),
  };
};

/** Format a tail for status / error surfaces, with an ellipsis when truncated. */
export const formatStderrTail = (tail: StderrTail): string => {
  const reason = tail.text().trim();
  if (!reason) return "";
  return `${tail.dropped() ? "…" : ""}${reason}`;
};
