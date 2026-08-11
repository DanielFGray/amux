import { expect, test } from "bun:test";
import {
  appendTranscriptFrame,
  serializeTranscript,
  type TranscriptBlock,
} from "./transcript.ts";

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
    frame({
      _tag: "tool.result",
      turn: "t1",
      call: "c1",
      output: "ok",
      isError: false,
    }),
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
    {
      kind: "assistant",
      turn: "t1",
      text: "The transcript remains readable when resized.",
    },
    {
      kind: "tool",
      turn: "t1",
      call: "c1",
      name: "grep",
      input: "src",
      output: "12 matches",
    },
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

test("tool.params-start creates a block that tool.params-delta appends to", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "tool.params-start", turn: "t1", call: "c1", tool: "grep" }),
  );
  expect(blocks).toEqual([
    { kind: "tool", turn: "t1", call: "c1", name: "grep", input: "" },
  ]);
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "tool.params-delta", turn: "t1", call: "c1", delta: "pat" }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "tool.params-delta", turn: "t1", call: "c1", delta: "tern" }),
  );
  expect(blocks).toEqual([
    { kind: "tool", turn: "t1", call: "c1", name: "grep", input: "pattern" },
  ]);
});

test("tool.start after partial streaming replaces the accumulated input", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "tool.params-start", turn: "t1", call: "c1", tool: "grep" }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "tool.params-delta",
      turn: "t1",
      call: "c1",
      delta: "ignore",
    }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "tool.start",
      turn: "t1",
      call: "c1",
      tool: "grep",
      input: { pattern: "real" },
    }),
  );
  expect(blocks).toEqual([
    {
      kind: "tool",
      turn: "t1",
      call: "c1",
      name: "grep",
      input: { pattern: "real" },
    },
  ]);
});

test("tool.params-delta without prior start creates a loose block", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "tool.params-delta",
      turn: "t1",
      call: "c1",
      delta: "orphan",
    }),
  );
  expect(blocks).toEqual([
    { kind: "tool", turn: "t1", call: "c1", name: "", input: "orphan" },
  ]);
});

test("tool.params-delta after tool.start does not corrupt the resolved input", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "tool.start",
      turn: "t1",
      call: "c1",
      tool: "grep",
      input: { ready: true },
    }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "tool.params-delta", turn: "t1", call: "c1", delta: "late" }),
  );
  expect(blocks).toEqual([
    {
      kind: "tool",
      turn: "t1",
      call: "c1",
      name: "grep",
      input: { ready: true },
    },
  ]);
});

test("tool lookups match on both turn and call to prevent cross-turn collisions", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "tool.start",
      turn: "t1",
      call: "c1",
      tool: "grep",
      input: { a: 1 },
    }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "tool.result",
      turn: "t1",
      call: "c1",
      output: "ok",
      isError: false,
    }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "tool.start",
      turn: "t2",
      call: "c1",
      tool: "shell",
      input: { cmd: "ls" },
    }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "tool.result",
      turn: "t2",
      call: "c1",
      output: "done",
      isError: false,
    }),
  );
  expect(blocks).toEqual([
    {
      kind: "tool",
      turn: "t1",
      call: "c1",
      name: "grep",
      input: { a: 1 },
      output: "ok",
      isError: false,
    },
    {
      kind: "tool",
      turn: "t2",
      call: "c1",
      name: "shell",
      input: { cmd: "ls" },
      output: "done",
      isError: false,
    },
  ]);
});
