import type { AgentFrame } from "../../../effect/AttachProtocol.ts";

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
    }
  /** Why a turn failed. The status block says that it did; this says what. */
  | { readonly kind: "error"; readonly turn: string; readonly text: string };

/** Mutable retained transcript; streamed text is accumulated without copying the block list. */
export class Transcript {
  #blocks: TranscriptBlock[] = [];
  #assistant = new Map<string, number>();
  #assistantChunks = new Map<number, string[]>();
  #tools = new Map<string, number>();
  #permissions = new Map<string, number>();
  #dirty = true;
  #view: readonly TranscriptBlock[] = [];

  append(frame: AgentFrame): void {
    switch (frame._tag) {
      case "turn.start":
        this.#blocks.push({ kind: "user", turn: frame.turn, text: frame.prompt });
        break;
      case "text.delta": {
        const index = this.#assistant.get(frame.turn);
        if (index === undefined) {
          this.#assistant.set(frame.turn, this.#blocks.length);
          this.#assistantChunks.set(this.#blocks.length, [frame.text]);
          this.#blocks.push({ kind: "assistant", turn: frame.turn, text: frame.text });
        } else {
          this.#assistantChunks.get(index)?.push(frame.text);
        }
        break;
      }
      case "tool.params-start": {
        const key = `${frame.turn}\0${frame.call}`;
        if (!this.#tools.has(key)) {
          this.#tools.set(key, this.#blocks.length);
          this.#blocks.push({
            kind: "tool",
            turn: frame.turn,
            call: frame.call,
            name: frame.tool,
            input: "",
          });
        }
        break;
      }
      case "tool.params-delta": {
        const index = this.#tools.get(`${frame.turn}\0${frame.call}`);
        if (index === undefined) {
          this.#tools.set(`${frame.turn}\0${frame.call}`, this.#blocks.length);
          this.#blocks.push({
            kind: "tool",
            turn: frame.turn,
            call: frame.call,
            name: "",
            input: frame.delta,
          });
        } else {
          const block = this.#blocks[index];
          if (block?.kind === "tool" && typeof block.input === "string")
            this.#blocks[index] = { ...block, input: block.input + frame.delta };
        }
        break;
      }
      case "tool.params-end":
        break;
      case "tool.start": {
        const key = `${frame.turn}\0${frame.call}`;
        const index = this.#tools.get(key);
        if (index === undefined) {
          this.#tools.set(key, this.#blocks.length);
          this.#blocks.push({
            kind: "tool",
            turn: frame.turn,
            call: frame.call,
            name: frame.tool,
            input: frame.input,
          });
        } else {
          const block = this.#blocks[index];
          if (block?.kind === "tool" && typeof block.input === "string")
            this.#blocks[index] = { ...block, name: frame.tool, input: frame.input };
        }
        break;
      }
      case "tool.result": {
        const index = this.#tools.get(`${frame.turn}\0${frame.call}`);
        const block = index === undefined ? undefined : this.#blocks[index];
        if (index !== undefined && block?.kind === "tool")
          this.#blocks[index] = { ...block, output: frame.output, isError: frame.isError };
        break;
      }
      case "permission.request":
        this.#permissions.set(frame.request, this.#blocks.length);
        this.#blocks.push({
          kind: "permission",
          turn: frame.turn,
          request: frame.request,
          tool: frame.tool,
          description: frame.description,
          input: frame.input,
        });
        break;
      case "permission.response": {
        const index = this.#permissions.get(frame.request);
        const block = index === undefined ? undefined : this.#blocks[index];
        if (index !== undefined && block?.kind === "permission")
          this.#blocks[index] = { ...block, approved: frame.approved };
        break;
      }
      case "agent.status":
        this.#blocks.push({ kind: "status", state: frame.state });
        break;
      case "turn.end":
        if (frame.text && !this.#assistant.has(frame.turn)) {
          this.#assistant.set(frame.turn, this.#blocks.length);
          this.#assistantChunks.set(this.#blocks.length, [frame.text]);
          this.#blocks.push({ kind: "assistant", turn: frame.turn, text: frame.text });
        }
        if (frame.error) this.#blocks.push({ kind: "error", turn: frame.turn, text: frame.error });
        break;
    }
    this.#dirty = true;
  }

  clear(): void {
    this.#blocks = [];
    this.#assistant.clear();
    this.#assistantChunks.clear();
    this.#tools.clear();
    this.#permissions.clear();
    this.#dirty = true;
  }

  snapshot(): readonly TranscriptBlock[] {
    if (this.#dirty) {
      this.#view = this.#blocks.map((block, index) => {
        const chunks = this.#assistantChunks.get(index);
        return chunks && block.kind === "assistant" ? { ...block, text: chunks.join("") } : block;
      });
      this.#dirty = false;
    }
    return this.#view;
  }
}

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
      if (
        index >= 0 &&
        blocks[index]!.kind === "tool" &&
        typeof blocks[index]!.input === "string"
      ) {
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
      return frame.error
        ? [...blocks, { kind: "error", turn: frame.turn, text: frame.error }]
        : blocks;
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
    case "error":
      return `error> ${block.text}`;
  }
}

export function wrapText(text: string, width: number): string[] {
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
