import { expect, test } from "bun:test";
import { Schema as S } from "effect";
import { DaemonEvent } from "./EventBus.ts";
import {
  AttachFrameAccumulator,
  decodeAttachFrames,
  encodeAttachFrame,
  encodeAttachFrameBytes,
  type AttachFrame,
} from "./AttachProtocol.ts";

test("attach framing splits at newline bytes before decoding UTF-8", () => {
  const accumulator = new AttachFrameAccumulator();
  const bytes = encodeAttachFrameBytes({ _tag: "hello", client: "café" });
  const newline = bytes.indexOf(0x0a);

  expect(accumulator.push(bytes.slice(0, newline))).toEqual([]);
  const frames = accumulator.push(bytes.slice(newline));
  expect(frames).toHaveLength(1);
  expect(decodeAttachFrames(new TextDecoder().decode(frames[0])).frames).toEqual([
    { _tag: "hello", client: "café" },
  ]);
  expect(accumulator.byteLength).toBe(0);
});

test("attach framing keeps a multibyte boundary intact across chunks", () => {
  const accumulator = new AttachFrameAccumulator();
  const bytes = encodeAttachFrameBytes({ _tag: "hello", client: "界" });
  const split = bytes.findIndex((byte) => byte >= 0x80) + 1;

  expect(accumulator.push(bytes.slice(0, split))).toEqual([]);
  const frames = accumulator.push(bytes.slice(split));
  expect(decodeAttachFrames(new TextDecoder().decode(frames[0])).frames).toEqual([
    { _tag: "hello", client: "界" },
  ]);
});

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
  const encoded = encodeAttachFrame({
    _tag: "foreground",
    session: "agent-1",
    pgid: -1,
    sid: -1,
    argv: [],
  });
  expect(decodeAttachFrames(encoded).frames).toEqual([
    { _tag: "foreground", session: "agent-1", pgid: -1, sid: -1, argv: [] },
  ]);
});

test("a session's durable log carries events core assigns no meaning to", () => {
  const frames: AttachFrame[] = [
    {
      _tag: "agent.message",
      session: "agent-1",
      sequence: 1,
      // Turn and tool vocabulary belongs to whatever wrote it. Core sees JSON.
      event: { _tag: "turn.start", turn: "turn-1", prompt: "Fix the failing test" },
    },
    {
      _tag: "agent.message",
      session: "agent-1",
      sequence: 2,
      event: { _tag: "tool.result", turn: "turn-1", call: "call-1", output: { passed: 42 } },
    },
    {
      // A component with no turns at all uses the same envelope.
      _tag: "agent.message",
      session: "agent-1",
      sequence: 3,
      event: ["anything", 1, null],
    },
    {
      _tag: "session.error",
      session: "agent-1",
      sequence: 4,
      message: "worker stderr: missing credential",
    },
    {
      _tag: "topic",
      session: "agent-1",
      sequence: 5,
      topic: "session.state",
      payload: "idle",
    },
  ];

  const decoded = decodeAttachFrames(frames.map(encodeAttachFrame).join(""));
  expect(decoded.rest).toBe("");
  expect(decoded.frames).toEqual(frames);
});

test("native agent control frames round-trip without provider or transport details", () => {
  const frames: AttachFrame[] = [
    {
      _tag: "session.message",
      session: "agent-1",
      message: { _tag: "agent.prompt", text: "Stop after the current command." },
    },
    {
      _tag: "session.message",
      session: "agent-1",
      message: { _tag: "agent.interrupt", reason: "Human requested a pause" },
    },
  ];

  expect(decodeAttachFrames(frames.map(encodeAttachFrame).join("")).frames).toEqual(frames);
});

test("plugin state crosses the attach protocol as an opaque named topic", () => {
  const frame = {
    _tag: "topic",
    session: "agent-1",
    sequence: 8,
    topic: "session.state",
    payload: "idle",
  } as const;

  expect(decodeAttachFrames(`${JSON.stringify(frame)}\n`).frames).toEqual([frame]);
  expect(() =>
    decodeAttachFrames(
      `${JSON.stringify({ _tag: "agent.status", session: "agent-1", sequence: 8, state: "idle" })}\n`,
    ),
  ).toThrow();
});

test("an arbitrary plugin-namespaced topic round-trips with an object payload", () => {
  const frame = {
    _tag: "topic",
    session: "agent-1",
    sequence: 8,
    topic: "amux.agent-awareness/identity-state",
    payload: { agent: "opencode", state: "working" },
  } as const;

  expect(decodeAttachFrames(`${JSON.stringify(frame)}\n`).frames).toEqual([frame]);
});

test("a component control message is an opaque JSON payload", () => {
  const frame: AttachFrame = {
    _tag: "session.message",
    session: "component-1",
    message: { _tag: "example.refresh", force: true },
  };

  const decoded = decodeAttachFrames(encodeAttachFrame(frame));
  expect(decoded.rest).toBe("");
  expect(decoded.frames).toEqual([frame]);
});

test("a live fragment round-trips without a place in the order", () => {
  const frame: AttachFrame = {
    _tag: "agent.delta",
    session: "agent-1",
    delta: { _tag: "tool.params-delta", turn: "turn-1", call: "call-1", delta: '{"path":' },
  };
  const decoded = decodeAttachFrames(encodeAttachFrame(frame));
  expect(decoded.rest).toBe("");
  expect(decoded.frames).toEqual([frame]);
  expect("sequence" in decoded.frames[0]!).toBe(false);
});

test("a worker proposes an event and cannot choose its sequence", () => {
  const emit: AttachFrame = {
    _tag: "agent.emit",
    event: { _tag: "agent.message", session: "agent-1", event: { _tag: "turn.end" } },
  };
  expect(decodeAttachFrames(encodeAttachFrame(emit)).frames).toEqual([emit]);

  // A worker that writes a `sequence` anyway does not get to keep it: the
  // request has no such field, so it is gone before the daemon assigns one.
  const forged = decodeAttachFrames(
    `${JSON.stringify({
      _tag: "agent.emit",
      event: { _tag: "agent.message", session: "agent-1", event: null, sequence: 7 },
    })}\n`,
  ).frames[0];
  expect(forged).toEqual({
    _tag: "agent.emit",
    event: { _tag: "agent.message", session: "agent-1", event: null },
  });
});

test("daemon agent events reject a committed event with no sequence", () => {
  expect(() =>
    S.decodeUnknownSync(DaemonEvent)({
      sequence: 1,
      event: {
        _tag: "agent.frame",
        session: "agent-1",
        frame: { _tag: "agent.message", session: "agent-1", event: null },
      },
    }),
  ).toThrow();
});

test("daemon agent events reject a non-JSON payload", () => {
  expect(() =>
    S.decodeUnknownSync(DaemonEvent)({
      sequence: 1,
      event: {
        _tag: "agent.frame",
        session: "agent-1",
        frame: {
          _tag: "agent.message",
          session: "agent-1",
          sequence: 1,
          event: { fn: () => 1 },
        },
      },
    }),
  ).toThrow();
});
