import { expect, test } from "vitest";
import { appendTranscriptFrame, serializeTranscript, type TranscriptBlock } from "./transcript.ts";

const frame = (value: any) => ({ session: "agent", sequence: 1, ...value });

test("transcript reduction joins text deltas and attaches tool results", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "turn.start", turn: "t1", prompt: "Fix it" }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "text.delta", turn: "t1", text: "I will " }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "text.delta", turn: "t1", text: "inspect." }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "tool.start",
      turn: "t1",
      call: "c1",
      tool: "shell",
      input: { command: "bun test" },
    }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "tool.result", turn: "t1", call: "c1", output: "ok", isError: false }),
  );

  expect(blocks).toEqual([
    { kind: "user", turn: "t1", text: "Fix it" },
    { kind: "assistant", turn: "t1", text: "I will inspect." },
    {
      kind: "tool",
      turn: "t1",
      call: "c1",
      name: "shell",
      input: { command: "bun test" },
      output: "ok",
      isError: false,
    },
  ]);
});

test("transcript serialization reflows semantic blocks at the requested width", () => {
  const blocks: readonly TranscriptBlock[] = [
    { kind: "assistant", turn: "t1", text: "The transcript remains readable when resized." },
    { kind: "tool", turn: "t1", call: "c1", name: "grep", input: "src", output: "12 matches" },
  ];
  expect(serializeTranscript(blocks, 20)).toEqual([
    "assistant> The",
    "transcript remains",
    "readable when",
    "resized.",
    "tool> grep src -> 12",
    "matches",
  ]);
});
