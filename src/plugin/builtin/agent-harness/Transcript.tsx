/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { Effect, Fiber, Schema as S, Stream, type Stream as StreamType } from "effect";
import {
  pendingPermission,
  serializeTranscript,
  Transcript as TranscriptModel,
  toolOutput,
  toolPermission,
  toolSummary,
  wrapText,
  type TranscriptBlock,
} from "./transcript.ts";
import { AgentFrame, type AttachFrame } from "../../../effect/AttachProtocol.ts";
import { isReportedAgentState, type ReportedAgentState } from "../../../agent-state.ts";
import { theme } from "../../../ui/theme.ts";

export interface TranscriptProps {
  sessionId: string;
  frames: (session: string) => StreamType.Stream<AttachFrame, unknown>;
  sync: (session: string) => void;
  /** Columns to wrap at. Reactive: the pane it lives in is resizable. */
  width: number | Accessor<number>;
  model?: string;
  onStatus?: (state: ReportedAgentState) => void;
  /** The question the agent is blocked on, or undefined once it is answered. */
  onPending?: (request: PermissionBlock | undefined) => void;
  /** Chat is a compact presentation. Raw retains every semantic event. */
  view?: "chat" | "raw";
  showThinking?: boolean;
}

export type PermissionBlock = Extract<TranscriptBlock, { kind: "permission" }>;

/**
 * The retained source for both views of one agent conversation.
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
  const [expandedTools, setExpandedTools] = createSignal<ReadonlySet<string>>(new Set());
  const [expandedThinking, setExpandedThinking] = createSignal<ReadonlySet<string>>(new Set());
  const width = () => (typeof props.width === "function" ? props.width() : props.width);
  const blocks = createMemo(() => {
    revision();
    width();
    return transcript.snapshot();
  });
  // The pending question is a fact about the transcript, not a second stream to
  // keep in step with it: the pane above is told what the blocks already say.
  createEffect(() => props.onPending?.(pendingPermission(blocks())));

  // Asking for the history before the stream fiber is running is safe: the
  // attach client creates a session's queue when a frame ARRIVES, not when the
  // stream is subscribed, and stream() then adopts that queue. So the replay
  // waits in it rather than being dropped on the floor.
  props.sync(props.sessionId);
  const fiber = Effect.runFork(
    props.frames(props.sessionId).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (!S.is(AgentFrame)(event)) return;
          if (event._tag === "agent.status" && isReportedAgentState(event.state)) {
            props.onStatus?.(event.state);
          }
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
      style={{ height: 0, flexGrow: 1, flexShrink: 1, backgroundColor: theme.base }}
    >
      <Show
        when={blocks().length > 0}
        fallback={<text style={{ fg: theme.overlay1 }}>waiting for agent events...</text>}
      >
        <Show
          when={props.view === "raw"}
          fallback={
            <For
              each={blocks().filter(
                (block) =>
                  block.kind !== "status" &&
                  block.kind !== "permission" &&
                  (props.showThinking || block.kind !== "reasoning"),
              )}
            >
              {(block) => (
                <ChatCard
                  block={block}
                  permission={block.kind === "tool" ? toolPermission(blocks(), block) : undefined}
                  width={() => Math.max(1, width())}
                  model={props.model}
                  expanded={block.kind === "tool" && expandedTools().has(block.call)}
                  onToggle={
                    block.kind === "tool"
                      ? () =>
                          setExpandedTools((previous) => {
                            const next = new Set(previous);
                            if (next.has(block.call)) next.delete(block.call);
                            else next.add(block.call);
                            return next;
                          })
                      : undefined
                  }
                  thinkingExpanded={
                    block.kind === "reasoning" && expandedThinking().has(block.turn)
                  }
                  onThinkingToggle={
                    block.kind === "reasoning"
                      ? () =>
                          setExpandedThinking((previous) => {
                            const next = new Set(previous);
                            if (next.has(block.turn)) next.delete(block.turn);
                            else next.add(block.turn);
                            return next;
                          })
                      : undefined
                  }
                />
              )}
            </For>
          }
        >
          <For each={blocks()}>
            {(block) => <RawTranscriptLine block={block} width={() => Math.max(1, width())} />}
          </For>
        </Show>
      </Show>
    </scrollbox>
  );
}

function RawTranscriptLine(props: { block: TranscriptBlock; width: Accessor<number> }) {
  const lines = createMemo(() => serializeTranscript([props.block], props.width()));
  return (
    <box style={{ width: "100%", flexShrink: 0, flexDirection: "column", marginTop: 1 }}>
      <For each={lines()}>
        {(line) => (
          <text style={{ wrapMode: "word", width: "100%", fg: theme.subtext0 }}>{line}</text>
        )}
      </For>
    </box>
  );
}

function ChatCard(props: {
  block: TranscriptBlock;
  permission?: PermissionBlock;
  width: Accessor<number>;
  model?: string;
  expanded: boolean;
  onToggle?: () => void;
  thinkingExpanded: boolean;
  onThinkingToggle?: () => void;
}) {
  const [hovered, setHovered] = createSignal(false);
  const cardStyle = {
    width: "100%" as const,
    flexShrink: 0,
    flexDirection: "column" as const,
    marginTop: 1,
    marginBottom: 1,
  };

  if (props.block.kind === "tool") {
    const block = props.block;
    const output = () => (block.name === "bash" ? toolOutput(block)?.trim() : undefined);
    const collapsedOutput = createMemo(() => collapseOutput(output() ?? "", 10));
    // Memoized, not computed once: the expand toggle and the pane resize must
    // both re-wrap and re-slice this card's lines.
    const lines = createMemo(() =>
      wrapText(
        output() === undefined ? toolSummary(block) : toolSummary({ ...block, output: undefined }),
        Math.max(1, props.width() - 2),
      ),
    );
    const overflow = createMemo(() => lines().length > 10);
    const visible = createMemo(() =>
      props.expanded || !overflow() ? lines() : lines().slice(0, 10),
    );
    const expandable = createMemo(() => overflow() || collapsedOutput().overflow);
    const visibleOutput = createMemo(() =>
      props.expanded || !collapsedOutput().overflow ? output() : collapsedOutput().text,
    );
    return (
      <box
        style={{ ...cardStyle, backgroundColor: hovered() ? undefined : theme.surface0 }}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={expandable() ? props.onToggle : undefined}
      >
        <text style={{ height: 1, fg: theme.text }}>{`tool> ${block.name}`}</text>
        <For each={visible()}>
          {(line) => (
            <text
              style={{
                wrapMode: "word",
                width: "100%",
                fg: block.streaming ? theme.overlay1 : theme.subtext0,
              }}
            >
              {line}
            </text>
          )}
        </For>
        <Show when={output()}>
          <text
            style={{
              wrapMode: "word",
              width: "100%",
              fg: block.isError ? theme.red : theme.subtext0,
            }}
          >
            {visibleOutput()}
          </text>
        </Show>
        <Show when={props.permission}>
          {(permission: () => PermissionBlock) => (
            <text
              style={{
                height: 1,
                fg: permission().decision === undefined ? theme.yellow : theme.overlay1,
              }}
            >
              {permission().decision === undefined
                ? "awaiting approval"
                : `approved ${permission().decision}`}
            </text>
          )}
        </Show>
        <Show when={expandable()}>
          <text style={{ height: 1, fg: theme.overlay1 }}>
            {props.expanded ? "click to collapse" : "click to expand"}
          </text>
        </Show>
      </box>
    );
  }

  if (props.block.kind === "reasoning") {
    const block = props.block;
    const lines = createMemo(() => wrapText(block.text, Math.max(1, props.width() - 2)));
    return (
      <box
        style={{ ...cardStyle, backgroundColor: theme.surface0 }}
        onMouseUp={props.onThinkingToggle}
      >
        <text style={{ height: 1, fg: theme.overlay1 }}>
          {props.thinkingExpanded ? "Thinking" : "Thinking (click to expand)"}
        </text>
        <Show when={props.thinkingExpanded}>
          <For each={lines()}>
            {(line) => (
              <text style={{ wrapMode: "word", width: "100%", fg: theme.subtext0 }}>{line}</text>
            )}
          </For>
        </Show>
      </box>
    );
  }

  const isUser = props.block.kind === "user";
  const isAssistant = props.block.kind === "assistant";
  const queued = props.block.kind === "user" && props.block.queued === true;
  const content = isUser || isAssistant ? (props.block as { text: string }).text : undefined;
  const lines =
    content === undefined
      ? serializeTranscript([props.block], props.width())
      : wrapText(content, isUser ? Math.max(1, Math.floor(props.width() * 0.85)) : props.width());
  return (
    <box
      style={{
        ...cardStyle,
        alignItems: isUser ? "flex-end" : "flex-start",
        backgroundColor: hovered() ? undefined : theme.surface0,
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <For each={lines}>
        {(line) => (
          <text
            style={{
              width: "100%",
              fg: theme.text,
            }}
          >
            {isUser ? line.padStart(props.width()) : line}
          </text>
        )}
      </For>
      <Show when={isUser}>
        <text style={{ height: 1, fg: theme.overlay1 }}>
          {(queued ? "queued" : "user").padStart(props.width())}
        </text>
      </Show>
      <Show when={isAssistant && props.model}>
        <text style={{ height: 1, fg: theme.overlay1 }}>{props.model}</text>
      </Show>
    </box>
  );
}

function collapseOutput(output: string, maxLines: number): { text: string; overflow: boolean } {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return { text: output, overflow: false };
  return { text: `${lines.slice(0, maxLines).join("\n")}\n...`, overflow: true };
}
