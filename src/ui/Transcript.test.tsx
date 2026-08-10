/** @jsxImportSource @opentui/solid */
import { Stream } from "effect";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { Transcript } from "./Transcript.tsx";

test("native transcript renders semantic text and tool results", async () => {
  const target = await createTestRenderer({ width: 42, height: 12 });
  const events = Stream.fromIterable([
    {
      _tag: "text.delta" as const,
      session: "native",
      turn: "t1",
      text: "I found it.",
    },
    {
      _tag: "tool.start" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      call: "c1",
      tool: "grep",
      input: "src",
    },
    {
      _tag: "tool.result" as const,
      session: "native",
      sequence: 2,
      turn: "t1",
      call: "c1",
      output: "12 matches",
      isError: false,
    },
  ]);
  const agent = { id: "native", kind: "agent" } as any;
  await render(() => <Transcript agent={agent} frames={() => events} sync={() => {}} width={42} />, target.renderer);
  await target.renderOnce();
  await Bun.sleep(10);
  expect(target.captureCharFrame()).toContain("assistant> I found it.");
  expect(target.captureCharFrame()).toContain("tool> grep src -> 12 matches");
  target.renderer.destroy();
});
