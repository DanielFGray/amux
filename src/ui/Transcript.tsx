/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Effect, Fiber, Schema as S, Stream, type Stream as StreamType } from "effect";
import type { Session } from "../agent.ts";
import { serializeTranscript, Transcript as TranscriptModel } from "../transcript.ts";
import { AgentFrame, type AttachFrame } from "../effect/AttachProtocol.ts";
import { theme } from "./theme.ts";

export interface TranscriptProps {
  agent: Session | null;
  frames: (session: string) => StreamType.Stream<AttachFrame, unknown>;
  sync: (session: string) => void;
  width: number;
}

/** A retained semantic view of the active native agent conversation. */
export function Transcript(props: TranscriptProps) {
  const transcript = new TranscriptModel();
  const [revision, setRevision] = createSignal(0);
  const agentId = createMemo(() => (props.agent?.kind === "agent" ? props.agent.id : null));
  const lines = createMemo(() => {
    revision();
    return serializeTranscript(transcript.snapshot(), Math.max(1, props.width - 2));
  });

  createEffect(() => {
    agentId();
    transcript.clear();
    if (agentId()) props.sync(agentId()!);
    setRevision((value) => value + 1);
  });

  const fiber = Effect.runFork(
    Stream.unwrap(
      Effect.gen(function* () {
        const id = agentId();
        if (id === null) return Stream.never;
        return props.frames(id);
      }),
    ).pipe(
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
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        padding: 1,
        backgroundColor: theme.base,
      }}
    >
      <text style={{ height: 1, flexShrink: 0, fg: theme.mauve }}>native transcript</text>
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
    </box>
  );
}
