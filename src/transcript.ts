import type { AgentFrame } from "./effect/AttachProtocol.ts";

export type TranscriptBlock =
  | { readonly kind: "user"; readonly turn: string; readonly text: string }
  | { readonly kind: "assistant"; readonly turn: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly turn: string;
      readonly call: string;
      readonly name: string;
      readonly input: unknown;
      readonly output?: unknown;
      readonly isError?: boolean;
    }
  | {
      readonly kind: "permission";
      readonly turn: string;
      readonly request: string;
      readonly tool: string;
      readonly description: string;
      readonly input: unknown;
      readonly approved?: boolean;
    }
  | {
      readonly kind: "status";
      readonly state: Extract<AgentFrame, { _tag: "agent.status" }>["state"];
    };

/** Reduce semantic agent frames into stable render blocks. */
export function appendTranscriptFrame(
  blocks: readonly TranscriptBlock[],
  frame: AgentFrame,
): readonly TranscriptBlock[] {
  switch (frame._tag) {
    case "turn.start":
      return [...blocks, { kind: "user", turn: frame.turn, text: frame.prompt }];
    case "text.delta": {
      const last = blocks.at(-1);
      if (last?.kind === "assistant" && last.turn === frame.turn) {
        return [...blocks.slice(0, -1), { ...last, text: last.text + frame.text }];
      }
      return [...blocks, { kind: "assistant", turn: frame.turn, text: frame.text }];
    }
    case "tool.start": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "tool" && block.turn === frame.turn && block.call === frame.call,
      );
      // Replace a block that was built from tool.params-delta (string input).
      if (index >= 0 && blocks[index]!.kind === "tool" && typeof blocks[index]!.input === "string") {
        const prev = blocks[index]!;
        if (prev.kind !== "tool") return blocks;
        return [
          ...blocks.slice(0, index),
          { ...prev, input: frame.input },
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
        { kind: "tool", turn: frame.turn, call: frame.call, name: frame.tool, input: "" },
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
        { kind: "tool", turn: frame.turn, call: frame.call, name: "", input: frame.delta },
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
      return [
        ...blocks,
        {
          kind: "permission",
          turn: frame.turn,
          request: frame.request,
          tool: frame.tool,
          description: frame.description,
          input: frame.input,
        },
      ];
    case "permission.response": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "permission" && block.request === frame.request,
      );
      if (index < 0) return blocks;
      const permission = blocks[index]!;
      if (permission.kind !== "permission") return blocks;
      return [
        ...blocks.slice(0, index),
        { ...permission, approved: frame.approved },
        ...blocks.slice(index + 1),
      ];
    }
    case "agent.status":
      return [...blocks, { kind: "status", state: frame.state }];
    case "turn.end":
      return blocks;
  }
}

/** Render blocks into plain lines using the same word-wrapping contract as the TUI. */
export function serializeTranscript(blocks: readonly TranscriptBlock[], width: number): string[] {
  if (!Number.isInteger(width) || width < 1) throw new Error("transcript width must be positive");
  return blocks.flatMap((block) => wrap(transcriptLine(block), width));
}

function transcriptLine(block: TranscriptBlock): string {
  switch (block.kind) {
    case "user":
      return `user> ${block.text}`;
    case "assistant":
      return `assistant> ${block.text}`;
    case "tool":
      return `tool> ${block.name} ${json(block.input)}${block.output === undefined ? "" : ` -> ${json(block.output)}`}`;
    case "permission":
      return `permission> ${block.tool}: ${block.description}${block.approved === undefined ? "" : block.approved ? " [approved]" : " [denied]"}`;
    case "status":
      return `status> ${block.state}`;
  }
}

function wrap(text: string, width: number): string[] {
  if (text.length === 0) return [""];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
}

function json(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
