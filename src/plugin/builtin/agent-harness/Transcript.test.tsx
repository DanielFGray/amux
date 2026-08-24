/** @jsxImportSource @opentui/solid */
import { Stream } from "effect";
import { expect, test } from "bun:test";
import { createTestRenderer, createMockMouse } from "@opentui/core/testing";
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
  await render(
    () => <Transcript sessionId="native" frames={() => events} sync={() => {}} width={42} />,
    target.renderer,
  );
  await target.renderOnce();
  await Bun.sleep(10);
  expect(target.captureCharFrame()).toContain("I found it.");
  expect(target.captureCharFrame()).toContain("tool> grep");
  expect(target.captureCharFrame()).toContain("src -> 12 matches");
  target.renderer.destroy();
});

test("thinking traces are collapsed when enabled", async () => {
  const target = await createTestRenderer({ width: 42, height: 12 });
  const events = Stream.fromIterable([
    {
      _tag: "reasoning.delta" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      text: "checking files",
    },
  ]);
  await render(
    () => (
      <Transcript
        sessionId="native"
        frames={() => events}
        sync={() => {}}
        width={42}
        showThinking
      />
    ),
    target.renderer,
  );
  await target.renderOnce();
  await Bun.sleep(10);
  expect(target.captureCharFrame()).toContain("Thinking (click to expand)");
  expect(target.captureCharFrame()).not.toContain("checking files");
  target.renderer.destroy();
});

test("a tool whose params are still streaming shows the about-to-run placeholder", async () => {
  const target = await createTestRenderer({ width: 42, height: 12 });
  const events = Stream.fromIterable([
    {
      _tag: "tool.params-start" as const,
      session: "native",
      turn: "t1",
      call: "c1",
      tool: "bash",
    },
    {
      _tag: "tool.params-delta" as const,
      session: "native",
      turn: "t1",
      call: "c1",
      delta: '{"command": "bun tes',
    },
  ]);
  await render(
    () => <Transcript sessionId="native" frames={() => events} sync={() => {}} width={42} />,
    target.renderer,
  );
  await target.renderOnce();
  await Bun.sleep(10);
  expect(target.captureCharFrame()).toContain("~ Writing command...");
  expect(target.captureCharFrame()).not.toContain('{"command"');
  target.renderer.destroy();
});

test("raw transcript renders protocol events that chat presents elsewhere", async () => {
  const target = await createTestRenderer({ width: 60, height: 12 });
  const events = Stream.fromIterable([
    {
      _tag: "tool.start" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      call: "c1",
      tool: "bash",
      input: { command: "ls" },
    },
    {
      _tag: "permission.request" as const,
      session: "native",
      sequence: 2,
      turn: "t1",
      request: "r1",
      tool: "bash",
      action: "bash",
      resources: ["ls"],
      save: [],
      input: { command: "ls" },
    },
    {
      _tag: "topic" as const,
      session: "native",
      sequence: 3,
      topic: "session.state",
      payload: "blocked" as const,
    },
  ]);
  await render(
    () => (
      <Transcript sessionId="native" frames={() => events} sync={() => {}} width={60} view="raw" />
    ),
    target.renderer,
  );
  await target.renderOnce();
  await Bun.sleep(10);
  const frame = target.captureCharFrame();
  expect(frame).toContain('tool> bash {"command":"ls"}');
  expect(frame).toContain("permission> bash: $ ls");
  expect(frame).toContain("status> blocked");
  target.renderer.destroy();
});

test("clicking a collapsed bash card expands its full output", async () => {
  const target = await createTestRenderer({ width: 42, height: 40 });
  const longOutput = Array.from(
    { length: 30 },
    (_, i) => `line number ${i} with padding text`,
  ).join("\n");
  const events = Stream.fromIterable([
    {
      _tag: "tool.start" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      call: "c1",
      tool: "bash",
      input: { command: "printf lines" },
    },
    {
      _tag: "tool.result" as const,
      session: "native",
      sequence: 2,
      turn: "t1",
      call: "c1",
      output: longOutput,
      isError: false,
    },
  ]);
  await render(
    () => <Transcript sessionId="native" frames={() => events} sync={() => {}} width={42} />,
    target.renderer,
  );
  await target.renderOnce();
  await Bun.sleep(10);

  expect(target.captureCharFrame()).toContain("click to expand");
  expect(target.captureCharFrame()).toContain("$ printf lines");
  expect(target.captureCharFrame()).toContain("line number 0");
  expect(target.captureCharFrame()).not.toContain("line number 20");

  const mouse = createMockMouse(target.renderer);
  await mouse.click(5, 5);
  await target.renderOnce();
  await Bun.sleep(10);

  expect(target.captureCharFrame()).toContain("click to collapse");
  expect(target.captureCharFrame()).toContain("line number 20");
  target.renderer.destroy();
});

test("a tool whose params are still streaming shows the about-to-run placeholder", async () => {
  const target = await createTestRenderer({ width: 42, height: 12 });
  const events = Stream.fromIterable([
    {
      _tag: "tool.params-start" as const,
      session: "native",
      turn: "t1",
      call: "c1",
      tool: "bash",
    },
    {
      _tag: "tool.params-delta" as const,
      session: "native",
      turn: "t1",
      call: "c1",
      delta: '{"command": "bun tes',
    },
  ]);
  await render(
    () => <Transcript sessionId="native" frames={() => events} sync={() => {}} width={42} />,
    target.renderer,
  );
  await target.renderOnce();
  await Bun.sleep(10);
  expect(target.captureCharFrame()).toContain("~ Writing command...");
  expect(target.captureCharFrame()).not.toContain('{"command"');
  target.renderer.destroy();
});
