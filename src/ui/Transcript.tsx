/** @jsxImportSource @opentui/solid */
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { Effect, Fiber, Schema as S, Stream, type Stream as StreamType } from "effect";
import type { Session } from "../agent.ts";
import { serializeTranscript, Transcript as TranscriptModel } from "../transcript.ts";
import { AgentFrame, type AttachFrame } from "../effect/AttachProtocol.ts";
import { theme } from "./theme.ts";

export interface TranscriptProps {
  session: Session;
  frames: (session: string) => StreamType.Stream<AttachFrame, unknown>;
  sync: (session: string) => void;
  /** Columns to wrap at. Reactive: the pane it lives in is resizable. */
  width: number;
}

/**
 * The retained, semantic view of one agent conversation.
 *
 * One session for the component's whole life, because it is a pane's content
 * and a pane views one session — so the stream is opened once and the model is
 * never reset under a running subscription.
 *
 * Draws no frame of its own: the pane around it already has a border and a
 * title, and the composer below it is the other half of the same column.
 */
export function Transcript(props: TranscriptProps) {
  const transcript = new TranscriptModel();
  const [revision, setRevision] = createSignal(0);
  const lines = createMemo(() => {
    revision();
    return serializeTranscript(transcript.snapshot(), Math.max(1, props.width));
  });

  // Asking for the history before the stream fiber is running is safe: the
  // attach client creates a session's queue when a frame ARRIVES, not when the
  // stream is subscribed, and stream() then adopts that queue. So the replay
  // waits in it rather than being dropped on the floor.
  props.sync(props.session.id);
  const fiber = Effect.runFork(
    props.frames(props.session.id).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (!S.is(AgentFrame)(event)) return;
          transcript.append(event);
          setRevision((value) => value + 1);
        }),
      ),
    ),
  );
  onCleanup(() => void Effect.runFork(Fiber.interrupt(fiber)));

  return (
    <scrollbox
      stickyScroll
      stickyStart="bottom"
      style={{ flexGrow: 1, backgroundColor: theme.base }}
    >
      <Show
        when={lines().length > 0}
        fallback={<text style={{ fg: theme.overlay1 }}>waiting for agent events...</text>}
      >
        <For each={lines()}>
          {(line) => (
            <text wrapMode="word" style={{ width: "100%", flexShrink: 0, fg: theme.text }}>
              {line}
            </text>
          )}
        </For>
      </Show>
    </scrollbox>
  );
}
