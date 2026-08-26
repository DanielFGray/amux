import { expect, test } from "bun:test";
import {
  Transcript,
  appendTranscriptFrame,
  pendingPermission,
  permissionSummary,
  serializeTranscript,
  toolSummary,
  toolPermission,
  wrapText,
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

test("transcript reduction retains and joins reasoning deltas", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "reasoning.delta", turn: "t1", text: "I will " }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "reasoning.delta", turn: "t1", text: "inspect." }),
  );

  expect(blocks).toEqual([{ kind: "reasoning", turn: "t1", text: "I will inspect." }]);
  expect(serializeTranscript(blocks, 80)).toEqual(["thinking> I will inspect."]);
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

test("worker startup errors appear as actionable transcript errors", () => {
  const blocks = appendTranscriptFrame(
    [],
    frame({
      _tag: "agent.error",
      message: "Provider authentication failed. Check Settings > auth.",
    }),
  );
  expect(blocks).toEqual([
    { kind: "error", text: "Provider authentication failed. Check Settings > auth." },
  ]);
  expect(serializeTranscript(blocks, 80)).toEqual([
    "error> Provider authentication failed. Check Settings > auth.",
  ]);
});

test("tool.params-start creates a block that tool.params-delta appends to", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "tool.params-start", turn: "t1", call: "c1", tool: "grep" }),
  );
  expect(blocks).toEqual([
    { kind: "tool", turn: "t1", call: "c1", name: "grep", input: "", streaming: true },
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
    { kind: "tool", turn: "t1", call: "c1", name: "grep", input: "pattern", streaming: true },
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
      streaming: false,
    },
  ]);
});

test("tool.params-delta without prior start creates a loose streaming block", () => {
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
    { kind: "tool", turn: "t1", call: "c1", name: "", input: "orphan", streaming: true },
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

/**
 * The reason a turn failed reaches the pane.
 *
 * `turn.end` used to be a no-op here, so a failure rendered as a bare
 * `status> failed` with nothing to act on. `session.state` settles back to
 * the neutral "idle" once the turn ends — the failure is carried by the
 * `error` block instead, not by the status topic.
 */
test("a failed turn.end renders the cause, and status settles to idle", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "turn.start", turn: "t1", prompt: "hello" }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "turn.end",
      turn: "t1",
      outcome: "failed",
      error: "HttpResponseError: 400 invalid schema for function 'pane_next'",
    }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "topic", topic: "session.state", payload: "idle" }),
  );

  expect(serializeTranscript(blocks, 80)).toEqual([
    "user> hello",
    "error> HttpResponseError: 400 invalid schema for function 'pane_next'",
    "status> idle",
  ]);
});

test("a completed turn.end adds no error block", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(blocks, frame({ _tag: "text.delta", turn: "t1", text: "done" }));
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "turn.end", turn: "t1", outcome: "completed", text: "done" }),
  );

  expect(blocks).toEqual([{ kind: "assistant", turn: "t1", text: "done" }]);
});

/**
 * Live and replay both deliver the answer, and the class must not double it.
 *
 * Streaming sends the text twice — once as deltas, once as `turn.end.text` so
 * the turn survives the deltas expiring. A reattach sends only the latter.
 */
test("turn.end text rebuilds an answer on replay without duplicating a streamed one", () => {
  const live = new Transcript();
  live.append(frame({ _tag: "text.delta", turn: "t1", text: "answer" }));
  live.append(frame({ _tag: "turn.end", turn: "t1", outcome: "completed", text: "answer" }));
  expect(serializeTranscript(live.snapshot(), 80)).toEqual(["assistant> answer"]);

  const replayed = new Transcript();
  replayed.append(frame({ _tag: "turn.end", turn: "t1", outcome: "completed", text: "answer" }));
  expect(serializeTranscript(replayed.snapshot(), 80)).toEqual(["assistant> answer"]);
});

test("a retained transcript keeps the cause of a failed turn", () => {
  const transcript = new Transcript();
  transcript.append(frame({ _tag: "turn.start", turn: "t1", prompt: "go" }));
  transcript.append(
    frame({ _tag: "turn.end", turn: "t1", outcome: "failed", error: "400 bad schema" }),
  );
  transcript.append(frame({ _tag: "topic", topic: "session.state", payload: "idle" }));
  expect(serializeTranscript(transcript.snapshot(), 80)).toEqual([
    "user> go",
    "error> 400 bad schema",
    "status> idle",
  ]);
});

const toolBlock = (overrides: Partial<Extract<TranscriptBlock, { kind: "tool" }>>) => ({
  kind: "tool" as const,
  turn: "t1",
  call: "c1",
  name: "bash",
  input: {},
  ...overrides,
});

/**
 * The opencode-style reveal: while params stream the pane shows a placeholder
 * ("Writing command..." / "Preparing write..."), and once the input resolves it
 * shows the actual command or path instead of raw partial JSON.
 */
test("a streaming bash tool renders the writing placeholder, then the command", () => {
  expect(toolSummary(toolBlock({ name: "bash", streaming: true, input: "" }))).toBe(
    "~ Writing command...",
  );
  expect(toolSummary(toolBlock({ name: "bash", input: { command: "bun test" } }))).toBe(
    "$ bun test",
  );
  expect(
    toolSummary(
      toolBlock({ name: "bash", input: { command: "bun test" }, output: "ok", isError: false }),
    ),
  ).toBe("$ bun test -> ok");
});

test("write and read tools reveal their paths, grep its pattern", () => {
  expect(toolSummary(toolBlock({ name: "write", streaming: true, input: "" }))).toBe(
    "~ Preparing write...",
  );
  expect(toolSummary(toolBlock({ name: "write", input: { path: "src/a.ts", content: "x" } }))).toBe(
    "\u2190 src/a.ts",
  );
  expect(toolSummary(toolBlock({ name: "read", input: { path: "ARCHITECTURE.md" } }))).toBe(
    "ARCHITECTURE.md",
  );
  expect(toolSummary(toolBlock({ name: "grep", input: { pattern: "createSignal" } }))).toBe(
    "createSignal",
  );
});

test("a resolved string input is not mistaken for streaming", () => {
  expect(toolSummary(toolBlock({ name: "grep", input: "src", output: "12 matches" }))).toBe(
    "src -> 12 matches",
  );
});

test("unknown tools fall back to the raw input while streaming", () => {
  expect(toolSummary(toolBlock({ name: "search", streaming: true, input: "" }))).toBe(
    "~ Running...",
  );
});

test("a permission request is pending until its answer arrives", () => {
  const request = frame({
    _tag: "permission.request",
    turn: "t1",
    request: "r1",
    tool: "bash",
    action: "bash",
    resources: ["rm -rf build"],
    save: [{ action: "bash", resource: "rm *", effect: "allow" }],
    input: { command: "rm -rf build" },
  });
  const asked = appendTranscriptFrame([], request);
  expect(pendingPermission(asked)).toMatchObject({ request: "r1", action: "bash" });
  expect(permissionSummary(pendingPermission(asked)!)).toBe("bash: $ rm -rf build");

  const answered = appendTranscriptFrame(
    asked,
    frame({ _tag: "permission.response", request: "r1", decision: "reject", feedback: "no" }),
  );
  expect(pendingPermission(answered)).toBeUndefined();
  expect(serializeTranscript(answered, 80)).toEqual(["permission> bash: $ rm -rf build [reject]"]);

  // The retained model reduces the same pair the same way.
  const transcript = new Transcript();
  transcript.append(request);
  transcript.append(frame({ _tag: "permission.response", request: "r1", decision: "always" }));
  expect(transcript.snapshot()).toMatchObject([{ kind: "permission", decision: "always" }]);
});

test("a permission joins the tool it gates without removing either raw event", () => {
  let blocks: readonly TranscriptBlock[] = [];
  blocks = appendTranscriptFrame(
    blocks,
    frame({ _tag: "tool.start", turn: "t1", call: "c1", tool: "bash", input: { command: "ls" } }),
  );
  blocks = appendTranscriptFrame(
    blocks,
    frame({
      _tag: "permission.request",
      turn: "t1",
      request: "r1",
      tool: "bash",
      action: "bash",
      resources: ["ls"],
      save: [],
      input: { command: "ls" },
    }),
  );

  expect(
    toolPermission(blocks, blocks[0] as Extract<TranscriptBlock, { kind: "tool" }>),
  ).toMatchObject({
    request: "r1",
  });
  expect(serializeTranscript(blocks, 80)).toEqual([
    'tool> bash {"command":"ls"}',
    "permission> bash: $ ls",
  ]);
});

test("wrapText preserves newlines as hard breaks and wraps each hard line", () => {
  expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  expect(
    wrapText(
      "Here's the plan:\n\n1. Update the daemon model queue\n2. Add a regression test\n3. Ship it",
      60,
    ),
  ).toEqual([
    "Here's the plan:",
    "",
    "1. Update the daemon model queue",
    "2. Add a regression test",
    "3. Ship it",
  ]);
  expect(
    wrapText(
      "I'll take a look.\n\nThe daemon owns the workspace state. Let me start there and see how generations are published.",
      60,
    ),
  ).toEqual([
    "I'll take a look.",
    "",
    "The daemon owns the workspace state. Let me start there and",
    "see how generations are published.",
  ]);
});

test("wrapText still word-wraps a single logical line as before", () => {
  expect(
    wrapText(
      "Single line that just keeps going with many words so it wraps at word boundaries like a normal sentence would in a narrow pane.",
      60,
    ),
  ).toEqual([
    "Single line that just keeps going with many words so it",
    "wraps at word boundaries like a normal sentence would in a",
    "narrow pane.",
  ]);
});
