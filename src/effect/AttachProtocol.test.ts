import { expect, test } from "bun:test";
import { Schema as S } from "effect";
import { DaemonEvent } from "./EventBus.ts";
import { decodeAttachFrames, encodeAttachFrame, type AttachFrame } from "./AttachProtocol.ts";

test("attach frames preserve binary payloads across the wire format", () => {
  const frame: AttachFrame = {
    _tag: "output",
    session: "agent-1",
    data: new Uint8Array([0, 1, 2, 255]),
  };
  const encoded = encodeAttachFrame(frame);
  const split = Math.floor(encoded.length / 2);

  const first = decodeAttachFrames(encoded.slice(0, split));
  expect(first.frames).toEqual([]);

  const second = decodeAttachFrames(first.rest + encoded.slice(split));
  expect(second.rest).toBe("");
  expect(second.frames).toEqual([frame]);
});

test("attach frame decoding rejects malformed or unknown frames", () => {
  expect(() => decodeAttachFrames('{"_tag":"wat"}\n')).toThrow();
  expect(() => decodeAttachFrames("not-json\n")).toThrow();
});

test("multiple frames and an incomplete tail are decoded independently", () => {
  const input =
    encodeAttachFrame({ _tag: "hello", client: "tui" }) +
    encodeAttachFrame({ _tag: "resize", session: "a", cols: 80, rows: 24 }) +
    '{"_tag":"hello","client":"later"';

  const result = decodeAttachFrames(input);
  expect(result.frames).toEqual([
    { _tag: "hello", client: "tui" },
    { _tag: "resize", session: "a", cols: 80, rows: 24 },
  ]);
  expect(result.rest).toBe('{"_tag":"hello","client":"later"');
});

test("heartbeat frames round-trip without special client state", () => {
  const encoded = encodeAttachFrame({ _tag: "ping", nonce: "17" });
  expect(decodeAttachFrames(encoded).frames).toEqual([{ _tag: "ping", nonce: "17" }]);
});

test("foreground frames carry a negative pgid and sid across the wire", () => {
  const encoded = encodeAttachFrame({ _tag: "foreground", session: "agent-1", pgid: -1, sid: -1 });
  expect(decodeAttachFrames(encoded).frames).toEqual([
    { _tag: "foreground", session: "agent-1", pgid: -1, sid: -1 },
  ]);
});

test("native agent lifecycle frames round-trip as semantic events", () => {
  const frames: AttachFrame[] = [
    {
      _tag: "turn.start",
      session: "agent-1",
      sequence: 1,
      turn: "turn-1",
      prompt: "Fix the failing test",
    },
    {
      _tag: "text.delta",
      session: "agent-1",
      sequence: 2,
      turn: "turn-1",
      text: "I will inspect the test.",
    },
    {
      _tag: "tool.start",
      session: "agent-1",
      sequence: 3,
      turn: "turn-1",
      call: "call-1",
      tool: "shell",
      input: { command: "bun test" },
    },
    {
      _tag: "permission.request",
      session: "agent-1",
      sequence: 4,
      turn: "turn-1",
      request: "permission-1",
      tool: "shell",
      description: "Run the test suite",
      input: { command: "bun test" },
    },
    {
      _tag: "permission.response",
      session: "agent-1",
      sequence: 5,
      turn: "turn-1",
      request: "permission-1",
      approved: true,
    },
    {
      _tag: "tool.result",
      session: "agent-1",
      sequence: 6,
      turn: "turn-1",
      call: "call-1",
      output: { passed: 42 },
      isError: false,
    },
    { _tag: "turn.end", session: "agent-1", sequence: 7, turn: "turn-1", outcome: "completed" },
    { _tag: "agent.status", session: "agent-1", sequence: 8, state: "idle" },
  ];

  const decoded = decodeAttachFrames(frames.map(encodeAttachFrame).join(""));
  expect(decoded.rest).toBe("");
  expect(decoded.frames).toEqual(frames);
});

test("native agent control frames round-trip without provider or transport details", () => {
  const frames: AttachFrame[] = [
    { _tag: "agent.steer", session: "agent-1", message: "Stop after the current command." },
    { _tag: "agent.interrupt", session: "agent-1", reason: "Human requested a pause" },
  ];

  expect(decodeAttachFrames(frames.map(encodeAttachFrame).join("")).frames).toEqual(frames);
});

test("daemon agent events reject malformed semantic frames", () => {
  expect(() =>
    S.decodeUnknownSync(DaemonEvent)({
      sequence: 1,
      event: {
        _tag: "agent.frame",
        session: "agent-1",
        frame: { _tag: "text.delta", session: "agent-1", sequence: "bad" },
      },
    }),
  ).toThrow();
});
