import { expect, test } from "vitest";
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
