import { AgentFrame } from "@danielfgray/amux/protocol"
import type { JsonValue } from "@danielfgray/amux/protocol"
import type { PermissionDecision, PermissionRule } from "@danielfgray/amux/permission.ts";
import { ProcessState } from "@danielfgray/amux"
import { agentStateFromTopic } from "./state-topic.ts";

export type TranscriptBlock =
  | { readonly kind: "reasoning"; readonly turn: string; readonly text: string }
  | {
      readonly kind: "user";
      readonly turn: string;
      readonly text: string;
      readonly queued?: boolean;
    }
  | { readonly kind: "assistant"; readonly turn: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly turn: string;
      readonly call: string;
      readonly name: string;
      readonly input: JsonValue;
      /** Params are still arriving as partial JSON fragments. A resolved input
       *  can legitimately be a bare string, so type alone cannot say pending. */
      readonly streaming?: boolean;
      readonly output?: JsonValue;
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
      readonly input: JsonValue;
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
  frame: Extract<AgentFrame, { _tag: "permission.request" }>,
): PermissionBlock => ({
  kind: "permission",
  turn: frame.turn,
  request: frame.request,
  tool: frame.tool,
  action: frame.action,
  resources: frame.resources,
  save: frame.save,
  input: frame.input,
});

const decided = (
  block: PermissionBlock,
  frame: Extract<AgentFrame, { _tag: "permission.response" }>,
): PermissionBlock =>
  frame.feedback === undefined
    ? { ...block, decision: frame.decision }
    : { ...block, decision: frame.decision, feedback: frame.feedback };

/**
 * The request the pane must answer before the agent can continue, if any.
 *
 * A pending request is one with no decision. Only the last matters: the agent
 * blocks on one question at a time, so an earlier undecided block can only be
 * a request whose answer was lost with the session that asked it.
 */
export function pendingPermission(blocks: readonly TranscriptBlock[]): PermissionBlock | undefined {
  const last = blocks.findLast((block) => block.kind === "permission");
  return last?.kind === "permission" && last.decision === undefined ? last : undefined;
}

/** The permission that gates this tool call, if the call needed human approval. */
export function toolPermission(
  blocks: readonly TranscriptBlock[],
  tool: Extract<TranscriptBlock, { kind: "tool" }>,
): PermissionBlock | undefined {
  return blocks.find(
    (block): block is PermissionBlock =>
      block.kind === "permission" &&
      block.turn === tool.turn &&
      block.tool === tool.name &&
      sameJson(block.input, tool.input),
  );
}

/** Reduce semantic agent frames into stable render blocks. */
export function appendTranscriptFrame(
  blocks: readonly TranscriptBlock[],
  frame: AgentFrame,
): readonly TranscriptBlock[] {
  switch (frame._tag) {
    case "turn.queued":
      return [...blocks, { kind: "user", turn: frame.turn, text: frame.prompt, queued: true }];
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
      // Replace a block that was built from tool.params-delta (string input).
      if (
        index >= 0 &&
        blocks[index]!.kind === "tool" &&
        typeof blocks[index]!.input === "string"
      ) {
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
        // Append if the input is still a string (partial streaming) but not if
        // a later tool.start already installed a parsed object.
        if (typeof tool.input !== "string") return blocks;
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
    case "topic": {
      const state = agentStateFromTopic(frame);
      return state === undefined ? blocks : [...blocks, { kind: "status", state }];
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

/** Render blocks into plain lines using the same word-wrapping contract as the TUI. */
export function serializeTranscript(blocks: readonly TranscriptBlock[], width: number): string[] {
  if (!Number.isInteger(width) || width < 1) throw new Error("transcript width must be positive");
  return blocks.flatMap((block) => wrapText(transcriptLine(block), width));
}

export function toolDetails(block: Extract<TranscriptBlock, { kind: "tool" }>): string {
  return `${json(block.input)}${block.output === undefined ? "" : ` -> ${json(block.output)}`}`;
}

/** Plain result text for a tool card. Non-string results retain their JSON form. */
export function toolOutput(block: Extract<TranscriptBlock, { kind: "tool" }>): string | undefined {
  return block.output === undefined ? undefined : json(block.output);
}

/**
 * One tool's "about to act" placeholder and how to reveal the resolved call,
 * mirroring opencode's pending=/complete= split: while params stream, the pane
 * shows what the agent is about to run; once they resolve, it shows the call.
 */
type ToolFace = {
  readonly pending: string;
  readonly reveal: (input: { readonly [key: string]: JsonValue }) => string;
};

const toolFaces = new Map<string, ToolFace>([
  [
    "bash",
    { pending: "Writing command...", reveal: (input) => `$ ${stringField(input, "command")}` },
  ],
  [
    "write",
    { pending: "Preparing write...", reveal: (input) => `\u2190 ${stringField(input, "path")}` },
  ],
  ["read", { pending: "Reading file...", reveal: (input) => stringField(input, "path") }],
  ["glob", { pending: "Finding files...", reveal: (input) => stringField(input, "pattern") }],
  ["grep", { pending: "Searching content...", reveal: (input) => stringField(input, "pattern") }],
]);

export function toolSummary(block: Extract<TranscriptBlock, { kind: "tool" }>): string {
  if (block.streaming) return `~ ${toolFaces.get(block.name)?.pending ?? "Running..."}`;
  const detail = describeCall(block.name, block.input);
  return block.output === undefined ? detail : `${detail} -> ${json(block.output)}`;
}

/**
 * What the agent is asking to be allowed to do, in the words the tool card uses.
 * The request carries no description of its own: the tool and its input are the
 * description, and the pane must not show the question differently from the call.
 */
export function permissionSummary(block: PermissionBlock): string {
  return `${block.tool}: ${describeCall(block.tool, block.input)}`;
}

function describeCall(tool: string, input: JsonValue): string {
  const face = toolFaces.get(tool);
  return isJsonObject(input) && face ? face.reveal(input) || json(input) : json(input);
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(input: { readonly [key: string]: JsonValue }, key: string): string {
  return typeof input[key] === "string" ? input[key] : "";
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
      return `tool> ${block.name} ${json(block.input)}${block.output === undefined ? "" : ` -> ${json(block.output)}`}`;
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

function json(value: JsonValue): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
