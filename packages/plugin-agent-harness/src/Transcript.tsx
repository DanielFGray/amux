/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree event handlers and lifecycle control flow belong to OpenTUI/Solid, not the service Effect graph. */
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { Schema as S, type Stream as StreamType } from "effect";
import { fromStream } from "@danielfgray/amux/effect/SolidRuntime.ts";
import {
  pendingPermission,
  serializeTranscript,
  Transcript as TranscriptModel,
  toolPermission,
  wrapText,
  type TranscriptBlock,
} from "./transcript.ts";
import { AgentFrame, type AttachFrame } from "@danielfgray/amux/protocol";
import { ProcessState } from "@danielfgray/amux";
import { agentStateFromTopic } from "./state-topic.ts";
import { theme } from "@danielfgray/amux";
import { codeSyntaxStyle, type HighlightSnapshot } from "@danielfgray/amux-highlight";
import type { PermissionDecision } from "@danielfgray/amux/permission.ts";
import { splitFences } from "./fences.ts";
import { CodeBlock } from "./CodeBlock.tsx";
import { HarnessApprovalPrompt, ToolCard } from "./ToolCards.tsx";

/**
 * Stable list identity for Solid `<For>`.
 *
 * Every `text.delta` allocates a new assistant block object; For keys by
 * reference, so an unkeyed list destroyed+recreated the markdown card on each
 * character (blank frame between glyphs). Key by turn/call/request instead —
 * string primitives compare equal across snapshots, so the card stays mounted
 * and only `content` updates. Cite: solid-js mapArray referential equality;
 * opencode keeps part identity via createStore+reconcile.
 */
export function chatBlockKey(block: TranscriptBlock): string {
  switch (block.kind) {
    case "assistant":
      return `assistant:${block.turn}`;
    case "user":
      return `user:${block.turn}:${block.queued === true ? (block.delivery ?? "queue") : "done"}`;
    case "reasoning":
      return `reasoning:${block.turn}`;
    case "tool":
      return `tool:${block.turn}:${block.call}`;
    case "permission":
      return `permission:${block.request}`;
    case "error":
      return `error:${block.turn ?? "none"}`;
    case "status":
      return `status:${block.state}`;
  }
}

export interface TranscriptProps {
  sessionId: string;
  frames: (session: string) => StreamType.Stream<AttachFrame, never>;
  sync: (session: string) => void;
  /** Columns to wrap at. Reactive: the pane it lives in is resizable. */
  width: number | Accessor<number>;
  onStatus?: (state: ProcessState) => void;
  /** The question the agent is blocked on, or undefined once it is answered. */
  onPending?: (request: PermissionBlock | undefined) => void;
  /** Answer a permission ask from the tool card that owns it. */
  onPermission?: (request: string, decision: PermissionDecision, feedback?: string) => void;
  /** Switch the composer into "deny with a reason" for this request id. */
  onExplainPermission?: (request: string) => void;
  /** Durably admitted prompts that have not yet been promoted. */
  onQueued?: (entries: readonly QueuedPrompt[]) => void;
  /** Chat is a compact presentation. Raw retains every semantic event. */
  view?: "chat" | "raw";
  showThinking?: boolean;
  /** Highlight fenced code blocks. Absent in tests that mount views without
   *  a worker — fences then render plain. */
  highlight?: HighlightSnapshot;
  /** While set, hide the interactive choices for this request (composer owns it). */
  explaining?: string;
}

export type PermissionBlock = Extract<TranscriptBlock, { kind: "permission" }>;

export type QueuedPrompt = {
  readonly turn: string;
  readonly text: string;
  readonly delivery: "steer" | "queue";
};

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
  const [expandedTools, setExpandedTools] = createSignal<ReadonlySet<string>>(new Set());
  const [expandedThinking, setExpandedThinking] = createSignal<ReadonlySet<string>>(new Set());
  const width = () => (typeof props.width === "function" ? props.width() : props.width);

  // Asking for the history before the stream is subscribed is safe: the
  // attach client creates a session's queue when a frame ARRIVES, not when the
  // stream is subscribed, and stream() then adopts that queue. So the replay
  // waits in it rather than being dropped on the floor.
  props.sync(props.sessionId);
  const revision = fromStream(props.frames(props.sessionId), 0, (rev, event) => {
    if (!S.is(AgentFrame)(event)) return rev;
    if (event._tag === "topic") {
      const state = agentStateFromTopic(event);
      if (state !== undefined) props.onStatus?.(state);
    }
    transcript.append(event);
    return rev + 1;
  });
  const blocks = createMemo(() => {
    revision();
    width();
    return transcript.snapshot();
  });
  const chatBlocks = createMemo(() =>
    blocks().filter((block) => {
      if (block.kind === "status") return false;
      if (block.kind === "reasoning" && !props.showThinking) return false;
      // Joined permissions render inside their tool card; only orphans
      // (no matching tool yet / matching failed) stay as their own row.
      if (block.kind === "permission") {
        if (block.decision !== undefined) return false;
        return !blocks().some(
          (candidate) =>
            candidate.kind === "tool" &&
            toolPermission(blocks(), candidate)?.request === block.request,
        );
      }
      return true;
    }),
  );
  // Key strings, not block objects — see chatBlockKey.
  const chatKeys = createMemo(() => chatBlocks().map(chatBlockKey));
  // The pending question is a fact about the transcript, not a second stream to
  // keep in step with it: the pane above is told what the blocks already say.
  createEffect(() => props.onPending?.(pendingPermission(blocks())));
  createEffect(() =>
    props.onQueued?.(
      blocks()
        .filter(
          (block): block is Extract<TranscriptBlock, { kind: "user" }> =>
            block.kind === "user" && block.queued === true,
        )
        .map((block) => ({
          turn: block.turn,
          text: block.text,
          delivery: block.delivery ?? "queue",
        })),
    ),
  );

  // Scrollboxes are focusable by default; keep keyboard focus on the composer.
  // paddingRight: 1 — OpenTUI's vertical scrollbar overlays the content's
  // right column (../opentui ScrollBox); keep a gutter so wrapped text and
  // markdown aren't covered. Cite: opentui keymap-demo contentOptions.
  return (
    <scrollbox
      stickyScroll
      stickyStart="bottom"
      focusable={false}
      contentOptions={{ paddingRight: 1 }}
      style={{ height: 0, flexGrow: 1, flexShrink: 1, backgroundColor: theme.base }}
    >
      <Show
        when={blocks().length > 0}
        fallback={<text style={{ fg: theme.overlay1 }}>…</text>}
      >
        <Show
          when={props.view === "raw"}
          fallback={
            <For each={chatKeys()}>
              {(key) => {
                const block = () => chatBlocks().find((row) => chatBlockKey(row) === key)!;
                const tool = () => {
                  const row = block();
                  return row.kind === "tool" ? row : undefined;
                };
                const reasoning = () => {
                  const row = block();
                  return row.kind === "reasoning" ? row : undefined;
                };
                const permission = () => {
                  const row = block();
                  return row.kind === "permission" ? row : undefined;
                };
                return (
                  <Show
                    when={block().kind !== "permission"}
                    fallback={
                      <HarnessApprovalPrompt
                        request={permission()!}
                        framed
                        explaining={props.explaining === permission()!.request}
                        width={() => Math.max(1, width())}
                        onDecide={(decision) =>
                          props.onPermission?.(permission()!.request, decision)
                        }
                        onExplain={() => props.onExplainPermission?.(permission()!.request)}
                      />
                    }
                  >
                    <ChatCard
                      block={block()}
                      permission={
                        tool() !== undefined ? toolPermission(blocks(), tool()!) : undefined
                      }
                      explaining={
                        tool() !== undefined
                          ? props.explaining === toolPermission(blocks(), tool()!)?.request
                          : false
                      }
                      onDecide={
                        tool() !== undefined
                          ? (decision) => {
                              const ask = toolPermission(blocks(), tool()!);
                              if (ask) props.onPermission?.(ask.request, decision);
                            }
                          : undefined
                      }
                      onExplain={
                        tool() !== undefined
                          ? () => {
                              const ask = toolPermission(blocks(), tool()!);
                              if (ask) props.onExplainPermission?.(ask.request);
                            }
                          : undefined
                      }
                      width={() => Math.max(1, width())}
                      highlight={props.highlight}
                      expanded={tool() !== undefined && expandedTools().has(tool()!.call)}
                      onToggle={
                        tool() !== undefined
                          ? () => {
                              const call = tool()!.call;
                              setExpandedTools((previous) => {
                                const next = new Set(previous);
                                if (next.has(call)) next.delete(call);
                                else next.add(call);
                                return next;
                              });
                            }
                          : undefined
                      }
                      thinkingExpanded={
                        reasoning() !== undefined && expandedThinking().has(reasoning()!.turn)
                      }
                      onThinkingToggle={
                        reasoning() !== undefined
                          ? () => {
                              const turn = reasoning()!.turn;
                              setExpandedThinking((previous) => {
                                const next = new Set(previous);
                                if (next.has(turn)) next.delete(turn);
                                else next.add(turn);
                                return next;
                              });
                            }
                          : undefined
                      }
                    />
                  </Show>
                );
              }}
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
  explaining?: boolean;
  onDecide?: (decision: PermissionDecision) => void;
  onExplain?: () => void;
  width: Accessor<number>;
  highlight?: HighlightSnapshot;
  expanded: boolean;
  onToggle?: () => void;
  thinkingExpanded: boolean;
  onThinkingToggle?: () => void;
}) {
  const [hovered, setHovered] = createSignal(false);

  // Tools: per-name cards (opencode ToolPart Switch / pi renderers/*).
  if (props.block.kind === "tool") {
    return (
      <ToolCard
        block={props.block}
        permission={props.permission}
        explaining={props.explaining}
        onDecide={props.onDecide}
        onExplain={props.onExplain}
        width={props.width}
        expanded={props.expanded}
        onToggle={props.onToggle}
      />
    );
  }

  if (props.block.kind === "reasoning") {
    const block = props.block;
    const lines = createMemo(() => wrapText(block.text, Math.max(1, props.width() - 2)));
    return (
      <box
        style={{ width: "100%", flexShrink: 0, flexDirection: "column", marginTop: 1 }}
        onMouseUp={props.onThinkingToggle}
      >
        <text style={{ height: 1, fg: theme.overlay1 }}>
          {props.thinkingExpanded ? "Thinking" : "Thinking..."}
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

  if (props.block.kind === "error") {
    const text = props.block.text;
    const lines = createMemo(() => wrapText(text, Math.max(1, props.width())));
    return (
      <box style={{ width: "100%", flexShrink: 0, flexDirection: "column", marginTop: 1 }}>
        <For each={lines()}>
          {(line) => (
            <text style={{ wrapMode: "word", width: "100%", fg: theme.red }}>{line}</text>
          )}
        </For>
      </box>
    );
  }

  const isUser = props.block.kind === "user";
  const isAssistant = props.block.kind === "assistant";
  const queued = props.block.kind === "user" && props.block.queued === true;
  const queuedLabel =
    props.block.kind === "user" && props.block.delivery === "steer" ? "steer" : "queued";
  const content = isUser || isAssistant ? (props.block as { text: string }).text : undefined;

  // Assistant: OpenTUI <markdown> (opencode TextPart / ../opentui MarkdownRenderable).
  // Prose structure + fenced highlighting live in one renderable; plain-text
  // capture still goes through serializeTranscript, not this view.
  // Explicit width follows the pane signal (not yoga's terminal box): Chat
  // resizes the logical wrap width before the test renderer can change cols.
  // Minus one for the scrollbox scrollbar gutter (see contentOptions above).
  // Keyed remount on wrap width: MarkdownRenderable rebuilds blocks from
  // content/streaming, not from width alone (../opentui Markdown.ts).
  // Read `props.block.text` in JSX (not a frozen const): the card stays mounted
  // across deltas via chatBlockKey, and content must update in place.
  if (isAssistant) {
    const wrapWidth = createMemo(() => Math.max(1, props.width() - 1));
    const text = () => (props.block as Extract<TranscriptBlock, { kind: "assistant" }>).text;
    return (
      <box style={{ width: "100%", flexShrink: 0, flexDirection: "column", marginTop: 1 }}>
        <Show when={text().trim() !== "" ? wrapWidth() : false} keyed>
          {(w: number) => (
            <markdown
              content={text()}
              syntaxStyle={codeSyntaxStyle()}
              streaming={true}
              conceal={true}
              fg={theme.text}
              width={w}
              style={{ width: w, flexShrink: 0 }}
            />
          )}
        </Show>
      </box>
    );
  }

  // Content column is pane width minus the scrollbar gutter.
  const column = () => Math.max(1, props.width() - 1);
  const textWidth = () => (isUser ? Math.max(1, Math.floor(column() * 0.85)) : column());
  // Memoized, not computed once: on a restored session the block can land on
  // the very first render, before yoga has run a frame — the pane's width is
  // still its pre-layout placeholder then, and only a memo picks up the real
  // value once layout settles a moment later.
  const lines = createMemo(() =>
    content === undefined
      ? serializeTranscript([props.block], column())
      : wrapText(content, textWidth()),
  );
  // User messages keep the fence split + CodeBlock path (HighlightSnapshot).
  // Assistant no longer shares it — <markdown> owns fences there.
  const fenced = createMemo(() => {
    if (content === undefined || !isUser) return undefined;
    const parts = splitFences(content);
    return parts.some((part) => part.kind === "code") ? parts : undefined;
  });
  // Role by treatment (pi): user keeps a tinted band; assistant sits on the
  // pane base with no card chrome and no "assistant>" / model footer noise.
  // Queued/steer keep a caption — those are delivery state, not a role label.
  // padStart uses `column`, not full pane width: padding a line to the
  // scrollbar column and laying it into the padded content box re-wraps mid-phrase.
  return (
    <box
      style={{
        width: "100%",
        flexShrink: 0,
        flexDirection: "column",
        marginTop: 1,
        alignItems: isUser ? "flex-end" : "flex-start",
        backgroundColor: isUser && !hovered() ? theme.surface0 : undefined,
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <Show
        when={fenced() !== undefined}
        fallback={
          <For each={lines()}>
            {(line) => (
              <text
                style={{
                  width: "100%",
                  fg: theme.text,
                }}
              >
                {isUser ? line.padStart(column()) : line}
              </text>
            )}
          </For>
        }
      >
        <For each={fenced() ?? []}>
          {(segment) =>
            segment.kind === "code" ? (
              <CodeBlock
                code={segment.code}
                language={segment.language}
                highlight={props.highlight}
              />
            ) : (
              <For each={wrapText(segment.text, textWidth())}>
                {(line) => (
                  <text
                    style={{
                      width: "100%",
                      fg: theme.text,
                    }}
                  >
                    {isUser ? line.padStart(column()) : line}
                  </text>
                )}
              </For>
            )
          }
        </For>
      </Show>
      <Show when={queued}>
        <text style={{ height: 1, fg: theme.overlay1 }}>{queuedLabel.padStart(column())}</text>
      </Show>
    </box>
  );
}
