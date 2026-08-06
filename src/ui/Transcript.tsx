/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Effect, Fiber, Schema as S, Stream, type Stream as StreamType } from "effect";
import type { Agent } from "../agent.ts";
import { appendTranscriptFrame, serializeTranscript, type TranscriptBlock } from "../transcript.ts";
import type { DaemonEventPayload } from "../effect/EventBus.ts";
import { AgentFrame } from "../effect/AttachProtocol.ts";
import { theme } from "./theme.ts";

export interface TranscriptProps {
  agent: Agent | null;
  events: StreamType.Stream<DaemonEventPayload, unknown>;
  width: number;
}

/** A retained semantic view of the active native agent conversation. */
export function Transcript(props: TranscriptProps) {
  const [blocks, setBlocks] = createSignal<readonly TranscriptBlock[]>([]);
  const agentId = createMemo(() => (props.agent?.kind === "agent" ? props.agent.id : null));
  const lines = createMemo(() => serializeTranscript(blocks(), Math.max(1, props.width - 2)));

  createEffect(() => {
    agentId();
    setBlocks([]);
  });

  const fiber = Effect.runFork(
    props.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          const id = agentId();
          if (id === null || event._tag !== "agent.frame" || event.session !== id) return;
          const frame = event.frame;
          if (!S.is(AgentFrame)(frame)) return;
          setBlocks((current) => appendTranscriptFrame(current, frame));
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
