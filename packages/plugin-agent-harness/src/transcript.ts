import type { AgentFrame } from "@danielfgray/amux/protocol";
import type { PermissionDecision, PermissionRule } from "@danielfgray/amux/permission.ts";
import { ProcessState } from "@danielfgray/amux";
import { Option, Schema as S } from "effect";
import { agentStateFromTopic } from "./state-topic.ts";
import {
  readDelta,
  readEvent,
  type HarnessDelta,
  type OpaqueJsonText,
  type SequencedHarnessEvent,
} from "./protocol.ts";
export type TranscriptBlock =
  | { readonly kind: "reasoning"; readonly turn: string; readonly text: string }
  | {
      readonly kind: "user";
      readonly turn: string;
      readonly text: string;
      readonly queued?: boolean;
      readonly delivery?: "steer" | "queue";
    }
  | { readonly kind: "assistant"; readonly turn: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly turn: string;
      readonly call: string;
      readonly name: string;
      /** Opaque JSON text (partial while streaming; complete after tool.start). */
      readonly input: OpaqueJsonText;
      /** Params are still arriving as partial JSON fragments. */
      readonly streaming?: boolean;
      readonly output?: OpaqueJsonText;
      readonly isError?: boolean;
    }
  | {
      readonly kind: "permission";
      readonly turn: string;
      readonly request: string;
      readonly tool: string;
      readonly action: string;
      readonly resources: readonly string[];
      /** What "always" would record, so the human approves a rule they can read. */
      readonly save: readonly PermissionRule[];
      readonly input: OpaqueJsonText;
      /** Provider tool-call id when the gate was told which call this is. */
      readonly call?: string;
      /** Unified diff preview when the tool computed one before asking. */
      readonly diff?: string;
      /** Absent while the request is still pending — the pane's cue to ask. */
      readonly decision?: PermissionDecision;
      readonly feedback?: string;
    }
  | {
      readonly kind: "status";
      readonly state: ProcessState;
    }
  /** Why a turn failed. The status block says that it did; this says what. */
  | { readonly kind: "error"; readonly turn?: string; readonly text: string };

/** Mutable retained transcript backed by the shared frame reducer. */
export class Transcript {
  #blocks: TranscriptBlock[] = [];

  append(frame: AgentFrame): void {
    this.#blocks = [...appendTranscriptFrame(this.#blocks, frame)];
  }

  clear(): void {
    this.#blocks = [];
  }

  snapshot(): readonly TranscriptBlock[] {
    return this.#blocks;
  }
}

type PermissionBlock = Extract<TranscriptBlock, { kind: "permission" }>;

const permissionBlock = (
  frame: Extract<SequencedHarnessEvent, { _tag: "permission.request" }>,
): PermissionBlock => {
  const block: PermissionBlock = {
    kind: "permission",
    turn: frame.turn,
    request: frame.request,
    tool: frame.tool,
    action: frame.action,
    resources: frame.resources,
    save: frame.save,
    input: frame.input,
  };
  if (frame.call !== undefined) Object.assign(block, { call: frame.call });
  if (frame.diff !== undefined) Object.assign(block, { diff: frame.diff });
  return block;
};

const decided = (
  block: PermissionBlock,
  frame: Extract<SequencedHarnessEvent, { _tag: "permission.response" }>,
): PermissionBlock =>
  frame.feedback === undefined
    ? { ...block, decision: frame.decision }
    : { ...block, decision: frame.decision, feedback: frame.feedback };

/**
 * The request the pane's keyboard shortcuts answer, if any.
 *
 * Prefer the earliest undecided ask: when two tools block in the same turn the
 * first one is what the user sees first in the transcript, and answering the
 * last one while leaving the earlier gate stuck is how a back-to-back bash pair
 * used to look unapprovable.
 */
export function pendingPermission(blocks: readonly TranscriptBlock[]): PermissionBlock | undefined {
  return blocks.find(
    (block): block is PermissionBlock =>
      block.kind === "permission" && block.decision === undefined,
  );
}

/** The permission that gates this tool call, if the call needed human approval. */
export function toolPermission(
  blocks: readonly TranscriptBlock[],
  tool: Extract<TranscriptBlock, { kind: "tool" }>,
): PermissionBlock | undefined {
  const byCall = blocks.find(
    (block): block is PermissionBlock =>
      block.kind === "permission" &&
      block.turn === tool.turn &&
      block.call !== undefined &&
      block.call === tool.call,
  );
  if (byCall) return byCall;
  // Older events (and any gate that never saw a call id) join on tool+input.
  return blocks.find(
    (block): block is PermissionBlock =>
      block.kind === "permission" &&
      block.turn === tool.turn &&
      block.tool === tool.name &&
      block.call === undefined &&
      block.input === tool.input,
  );
}

/**
 * Reduce one wire frame into stable render blocks.
 *
 * `agent.message` and `agent.delta` are opaque at this level — this harness's
 * own vocabulary lives inside them, so `readEvent`/`readDelta` unwrap it and
 * hand back `undefined` for anything the harness did not write, which this
 * folds over unchanged rather than failing on. `topic` and `session.error`
 * carry meaning core itself assigns and are handled directly.
 */
export function appendTranscriptFrame(
  blocks: readonly TranscriptBlock[],
  frame: AgentFrame,
): readonly TranscriptBlock[] {
  switch (frame._tag) {
    case "topic": {
      const state = agentStateFromTopic(frame);
      return state === undefined ? blocks : [...blocks, { kind: "status", state }];
    }
    case "session.error":
      return [...blocks, { kind: "error", text: frame.message }];
    case "agent.delta": {
      const fragment = readDelta(frame);
      return fragment === undefined ? blocks : appendHarnessDelta(blocks, fragment);
    }
    case "agent.message": {
      const event = readEvent(frame);
      return event === undefined ? blocks : appendHarnessEvent(blocks, event);
    }
  }
}

/** Fold one durable harness event, committed to the log, into render blocks. */
function appendHarnessEvent(
  blocks: readonly TranscriptBlock[],
  frame: SequencedHarnessEvent,
): readonly TranscriptBlock[] {
  switch (frame._tag) {
    case "turn.queued": {
      const block = {
        kind: "user" as const,
        turn: frame.turn,
        text: frame.prompt,
        queued: true as const,
        delivery: frame.delivery,
      };
      const index = blocks.findIndex((entry) => entry.kind === "user" && entry.turn === frame.turn);
      return index < 0
        ? [...blocks, block]
        : [...blocks.slice(0, index), block, ...blocks.slice(index + 1)];
    }
    case "turn.start": {
      const queued = blocks.some((block) => block.kind === "user" && block.turn === frame.turn);
      return queued
        ? blocks.map((block) =>
            block.kind === "user" && block.turn === frame.turn
              ? { ...block, queued: undefined }
              : block,
          )
        : [...blocks, { kind: "user", turn: frame.turn, text: frame.prompt }];
    }
    case "reasoning.delta": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "reasoning" && block.turn === frame.turn,
      );
      if (index >= 0) {
        const reasoning = blocks[index]!;
        if (reasoning.kind !== "reasoning") return blocks;
        return [
          ...blocks.slice(0, index),
          { ...reasoning, text: reasoning.text + frame.text },
          ...blocks.slice(index + 1),
        ];
      }
      return [...blocks, { kind: "reasoning", turn: frame.turn, text: frame.text }];
    }
    case "tool.start": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "tool" && block.turn === frame.turn && block.call === frame.call,
      );
      // Replace a block that was built from tool.params-delta (still streaming).
      if (index >= 0 && blocks[index]!.kind === "tool" && blocks[index]!.streaming) {
        const prev = blocks[index]!;
        if (prev.kind !== "tool") return blocks;
        return [
          ...blocks.slice(0, index),
          { ...prev, name: frame.tool, input: frame.input, streaming: false },
          ...blocks.slice(index + 1),
        ];
      }
      return [
        ...blocks,
        { kind: "tool", turn: frame.turn, call: frame.call, name: frame.tool, input: frame.input },
      ];
    }
    case "tool.result": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "tool" && block.turn === frame.turn && block.call === frame.call,
      );
      if (index < 0) return blocks;
      const tool = blocks[index]!;
      if (tool.kind !== "tool") return blocks;
      return [
        ...blocks.slice(0, index),
        { ...tool, output: frame.output, isError: frame.isError },
        ...blocks.slice(index + 1),
      ];
    }
    case "permission.request":
      return [...blocks, permissionBlock(frame)];
    case "permission.response": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "permission" && block.request === frame.request,
      );
      if (index < 0) return blocks;
      const permission = blocks[index]!;
      if (permission.kind !== "permission") return blocks;
      return [...blocks.slice(0, index), decided(permission, frame), ...blocks.slice(index + 1)];
    }
    case "turn.end":
      return [
        ...blocks,
        ...(frame.text &&
        !blocks.some((block) => block.kind === "assistant" && block.turn === frame.turn)
          ? [{ kind: "assistant" as const, turn: frame.turn, text: frame.text }]
          : []),
        ...(frame.error ? [{ kind: "error" as const, turn: frame.turn, text: frame.error }] : []),
      ];
    case "agent.error":
      return [...blocks, { kind: "error", text: frame.message }];
  }
}

/** Fold one live-only fragment — never appended to the durable log — into render blocks. */
function appendHarnessDelta(
  blocks: readonly TranscriptBlock[],
  frame: HarnessDelta,
): readonly TranscriptBlock[] {
  switch (frame._tag) {
    case "text.delta": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "assistant" && block.turn === frame.turn,
      );
      if (index >= 0) {
        const assistant = blocks[index]!;
        if (assistant.kind !== "assistant") return blocks;
        return [
          ...blocks.slice(0, index),
          { ...assistant, text: assistant.text + frame.text },
          ...blocks.slice(index + 1),
        ];
      }
      return [...blocks, { kind: "assistant", turn: frame.turn, text: frame.text }];
    }
    case "tool.params-start": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "tool" && block.turn === frame.turn && block.call === frame.call,
      );
      if (index >= 0 && blocks[index]!.kind === "tool") {
        // The final tool.start already resolved this call.
        return blocks;
      }
      return [
        ...blocks,
        {
          kind: "tool",
          turn: frame.turn,
          call: frame.call,
          name: frame.tool,
          input: "",
          streaming: true,
        },
      ];
    }
    case "tool.params-delta": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "tool" && block.turn === frame.turn && block.call === frame.call,
      );
      if (index >= 0 && blocks[index]!.kind === "tool") {
        const tool = blocks[index]!;
        if (tool.kind !== "tool") return blocks;
        // Append while still streaming; ignore after tool.start resolved the call.
        if (!tool.streaming) return blocks;
        return [
          ...blocks.slice(0, index),
          { ...tool, input: tool.input + frame.delta },
          ...blocks.slice(index + 1),
        ];
      }
      return [
        ...blocks,
        {
          kind: "tool",
          turn: frame.turn,
          call: frame.call,
          name: "",
          input: frame.delta,
          streaming: true,
        },
      ];
    }
    case "tool.params-end":
      return blocks;
  }
}

/** Render blocks into plain lines using the same word-wrapping contract as the TUI. */
export function serializeTranscript(blocks: readonly TranscriptBlock[], width: number): string[] {
  if (!Number.isInteger(width) || width < 1) throw new Error("transcript width must be positive");
  return blocks.flatMap((block) => wrapText(transcriptLine(block), width));
}

export function toolDetails(block: Extract<TranscriptBlock, { kind: "tool" }>): string {
  return `${displayJsonText(block.input)}${block.output === undefined ? "" : ` -> ${displayJsonText(block.output)}`}`;
}

/** Plain result text for a tool card. */
export function toolOutput(block: Extract<TranscriptBlock, { kind: "tool" }>): string | undefined {
  return block.output === undefined ? undefined : displayJsonText(block.output);
}

/**
 * One tool's "about to act" placeholder and how to reveal the resolved call,
 * mirroring opencode's pending=/complete= split (InlineTool): while params
 * stream, the pane shows what the agent is about to run; once they resolve, it
 * shows the call. Titles borrow pi's verb+arg form (`read path`, `$ cmd`) so
 * chat reads as actions, not as `tool> name` transcript lines. Raw view still
 * serializes through `transcriptLine`.
 */
type ToolFace = {
  readonly pending: string;
  readonly field?: "command" | "path" | "pattern";
  readonly prefix: string;
};

const toolFaces = new Map<string, ToolFace>([
  ["bash", { pending: "Writing command...", field: "command", prefix: "$ " }],
  ["write", { pending: "Preparing write...", field: "path", prefix: "write " }],
  ["edit", { pending: "Preparing edit...", field: "path", prefix: "edit " }],
  ["apply_patch", { pending: "Preparing patch...", prefix: "patch" }],
  ["read", { pending: "Reading file...", field: "path", prefix: "read " }],
  ["glob", { pending: "Finding files...", field: "pattern", prefix: "glob " }],
  ["grep", { pending: "Searching content...", field: "pattern", prefix: "grep " }],
]);

/** Fields tool faces may read from opaque JSON text. */
const ToolRevealFields = S.Struct({
  command: S.optional(S.String),
  path: S.optional(S.String),
  pattern: S.optional(S.String),
});
const decodeRevealFields = S.decodeOption(S.fromJsonString(ToolRevealFields));
const decodeJsonString = S.decodeOption(S.fromJsonString(S.String));

/** Chat headline for a tool — face only, never `-> output` (that is raw). */
export function toolSummary(block: Extract<TranscriptBlock, { kind: "tool" }>): string {
  if (block.streaming) return `~ ${toolFaces.get(block.name)?.pending ?? "Running..."}`;
  return describeCall(block.name, block.input);
}

/**
 * What the agent is asking to be allowed to do, in the words the tool card uses.
 * The request carries no description of its own: the tool and its input are the
 * description, and the pane must not show the question differently from the call.
 */
export function permissionSummary(block: PermissionBlock): string {
  return `${block.tool}: ${describeCall(block.tool, block.input)}`;
}

function describeCall(tool: string, input: OpaqueJsonText): string {
  const face = toolFaces.get(tool);
  if (face) {
    if (face.field === undefined) return face.prefix;
    const fields = decodeRevealFields(input);
    if (Option.isSome(fields)) {
      const value = fields.value[face.field] ?? "";
      return `${face.prefix}${value}`;
    }
  }
  const rendered = displayJsonText(input);
  return face ? `${tool} ${rendered}` : rendered;
}

function transcriptLine(block: TranscriptBlock): string {
  switch (block.kind) {
    case "user":
      return `user> ${block.text}`;
    case "assistant":
      return `assistant> ${block.text}`;
    case "reasoning":
      return `thinking> ${block.text}`;
    case "tool":
      return `tool> ${block.name} ${displayJsonText(block.input)}${block.output === undefined ? "" : ` -> ${displayJsonText(block.output)}`}`;
    case "permission":
      return `permission> ${permissionSummary(block)}${block.decision === undefined ? "" : ` [${block.decision}]`}`;
    case "status":
      return `status> ${block.state}`;
    case "error":
      return `error> ${block.text}`;
  }
}

/**
 * Split into display lines: each newline is a hard break, and each hard line
 * wraps at word boundaries. The renderer treats `\n` the same way, so the two
 * must agree or a model's markdown lists and blank lines reflow oddly.
 */
export function wrapText(text: string, width: number): string[] {
  if (text.length === 0) return [""];
  return text.split("\n").flatMap((line) => wrapLine(line, width));
}

function wrapLine(line: string, width: number): string[] {
  if (line.length === 0) return [""];
  const lines: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
}

/** Show JSON text: string primitives without quotes; otherwise the text itself. */
function displayJsonText(text: OpaqueJsonText): string {
  return Option.getOrElse(decodeJsonString(text), () => text);
}
