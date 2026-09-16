/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { Stream } from "effect";
import { expect, test } from "bun:test";
import { createTestRenderer, createMockMouse } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { Transcript } from "./Transcript.tsx";
import {
  emit,
  delta,
  OpaqueJsonText,
  decodeOpaqueJsonText,
  type HarnessDelta,
  type HarnessEvent,
} from "./protocol.ts";
import { Effect, Option } from "effect";
const jp = (value: typeof OpaqueJsonText.Encoded) => Option.getOrThrow(decodeOpaqueJsonText(value));
import type { AgentFrame } from "@danielfgray/amux/protocol";
import { waitFor } from "@danielfgray/amux/testing";

/**
 * Renders until the screen shows `text`. Markdown highlighting settles
 * asynchronously inside MarkdownRenderable, so a fixed delay before capturing
 * only holds up on an idle machine.
 */
const frameShowing = async (
  target: Awaited<ReturnType<typeof createTestRenderer>>,
  what: string,
  settled: (frame: string) => boolean,
): Promise<string> => {
  let frame = "";
  await waitFor(async () => {
    await target.renderOnce();
    frame = target.captureCharFrame();
    return settled(frame);
  }, `the frame to show ${what}`);
  return frame;
};

/** Wrap a harness event/fragment the way core actually delivers it — this
 *  test used to hand `Transcript` the harness tags directly, which the wire
 *  protocol no longer carries at its top level. */
const DELTA_TAGS = new Set<string>([
  "text.delta",
  "tool.params-start",
  "tool.params-delta",
  "tool.params-end",
]);
type TopicPayload = {
  readonly _tag: "topic";
  readonly topic: string;
  readonly payload: typeof OpaqueJsonText.Encoded;
};
function wrap(
  value: (HarnessEvent | HarnessDelta | TopicPayload) & {
    readonly session: string;
    readonly sequence?: number;
  },
): AgentFrame {
  const { session, sequence, ...event } = value;
  if (event._tag === "topic")
    return {
      session,
      sequence: sequence ?? 0,
      _tag: "topic",
      topic: event.topic,
      payload: jp(event.payload),
    };
  return DELTA_TAGS.has(event._tag)
    ? Effect.runSync(delta(session, event as HarnessDelta))
    : ({
        ...Effect.runSync(emit(session, event as HarnessEvent)),
        sequence: sequence ?? 0,
      } as AgentFrame);
}

test("native transcript renders semantic text and tool results", async () => {
  const target = await createTestRenderer({ width: 42, height: 12 });
  const events = Stream.fromIterable([
    wrap({
      _tag: "text.delta" as const,
      session: "native",
      turn: "t1",
      text: "I found it.",
    }),
    wrap({
      _tag: "tool.start" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      call: "c1",
      tool: "grep",
      input: jp("src"),
    }),
    wrap({
      _tag: "tool.result" as const,
      session: "native",
      sequence: 2,
      turn: "t1",
      call: "c1",
      output: jp("12 matches"),
      isError: false,
    }),
  ]);
  await render(
    () => <Transcript sessionId="native" frames={() => events} sync={() => {}} width={42} />,
    target.renderer,
  );
  await target.renderOnce();
  await Bun.sleep(10);
  expect(target.captureCharFrame()).toContain("I found it.");
  expect(target.captureCharFrame()).toContain("grep src");
  expect(target.captureCharFrame()).not.toContain("tool> grep");
  expect(target.captureCharFrame()).not.toContain("src -> 12 matches");
  target.renderer.destroy();
});

test("thinking traces are collapsed when enabled", async () => {
  const target = await createTestRenderer({ width: 42, height: 12 });
  const events = Stream.fromIterable([
    wrap({
      _tag: "reasoning.delta" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      text: "checking files",
    }),
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
  expect(target.captureCharFrame()).toContain("Thinking...");
  expect(target.captureCharFrame()).not.toContain("checking files");
  target.renderer.destroy();
});

test("assistant markdown renders prose and fenced code without fence markers", async () => {
  const target = await createTestRenderer({ width: 60, height: 20 });
  const events = Stream.fromIterable([
    wrap({
      _tag: "text.delta" as const,
      session: "native",
      turn: "t1",
      text: "try this:\n```ts\nconst x = 1;\n```\ndone",
    }),
  ]);
  await render(
    () => <Transcript sessionId="native" frames={() => events} sync={() => {}} width={60} />,
    target.renderer,
  );
  const frame = await frameShowing(
    target,
    "the fenced code with its markers concealed",
    (f) => f.includes("const x = 1;") && !f.includes("```"),
  );
  expect(frame).toContain("try this:");
  expect(frame).toContain("const x = 1;");
  expect(frame).toContain("done");
  // conceal=true hides the fence markers (opentui MarkdownOptions).
  expect(frame).not.toContain("```");
  target.renderer.destroy();
});

test("assistant markdown conceals emphasis markers", async () => {
  const target = await createTestRenderer({ width: 40, height: 10 });
  const events = Stream.fromIterable([
    wrap({
      _tag: "text.delta" as const,
      session: "native",
      turn: "t1",
      text: "use **bold** and a list:\n- one\n- two",
    }),
  ]);
  await render(
    () => <Transcript sessionId="native" frames={() => events} sync={() => {}} width={40} />,
    target.renderer,
  );
  const frame = await frameShowing(
    target,
    "the emphasis markers concealed",
    (f) => f.includes("bold") && !f.includes("**"),
  );
  expect(frame).not.toContain("**");
  expect(frame).toContain("one");
  expect(frame).toContain("two");
  target.renderer.destroy();
});

test("a tool whose params are still streaming shows the about-to-run placeholder", async () => {
  const target = await createTestRenderer({ width: 42, height: 12 });
  const events = Stream.fromIterable([
    wrap({
      _tag: "tool.params-start" as const,
      session: "native",
      turn: "t1",
      call: "c1",
      tool: "bash",
    }),
    wrap({
      _tag: "tool.params-delta" as const,
      session: "native",
      turn: "t1",
      call: "c1",
      delta: '{"command": "bun tes',
    }),
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
    wrap({
      _tag: "tool.start" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      call: "c1",
      tool: "bash",
      input: jp({ command: "ls" }),
    }),
    wrap({
      _tag: "permission.request" as const,
      session: "native",
      sequence: 2,
      turn: "t1",
      request: "r1",
      tool: "bash",
      action: "bash",
      resources: ["ls"],
      save: [],
      input: jp({ command: "ls" }),
    }),
    wrap({
      _tag: "topic" as const,
      session: "native",
      sequence: 3,
      topic: "session.state",
      payload: "blocked" as const,
    }),
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
    wrap({
      _tag: "tool.start" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      call: "c1",
      tool: "bash",
      input: jp({ command: "printf lines" }),
    }),
    wrap({
      _tag: "tool.result" as const,
      session: "native",
      sequence: 2,
      turn: "t1",
      call: "c1",
      output: jp(longOutput),
      isError: false,
    }),
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

test("read tool card is headline-only (no output body dump)", async () => {
  const target = await createTestRenderer({ width: 48, height: 12 });
  const events = Stream.fromIterable([
    wrap({
      _tag: "tool.start" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      call: "c1",
      tool: "read",
      input: jp({ path: "ARCHITECTURE.md" }),
    }),
    wrap({
      _tag: "tool.result" as const,
      session: "native",
      sequence: 2,
      turn: "t1",
      call: "c1",
      output: jp("# Architecture\n\nLots of prose the chat must not dump."),
      isError: false,
    }),
  ]);
  await render(
    () => <Transcript sessionId="native" frames={() => events} sync={() => {}} width={48} />,
    target.renderer,
  );
  await target.renderOnce();
  await Bun.sleep(10);
  const frame = target.captureCharFrame();
  expect(frame).toContain("read ARCHITECTURE.md");
  expect(frame).not.toContain("Lots of prose");
  expect(frame).not.toContain("tool> read");
  target.renderer.destroy();
});

test("edit tool card shows path title and diff body", async () => {
  const { conciseDiff } = await import("./edit-core.ts");
  const diff = conciseDiff("src/foo.ts", "old\n", "new\n");
  const target = await createTestRenderer({ width: 60, height: 24 });
  const events = Stream.fromIterable([
    wrap({
      _tag: "tool.start" as const,
      session: "native",
      sequence: 1,
      turn: "t1",
      call: "c1",
      tool: "edit",
      input: jp({ path: "src/foo.ts" }),
    }),
    wrap({
      _tag: "tool.result" as const,
      session: "native",
      sequence: 2,
      turn: "t1",
      call: "c1",
      output: jp(`Successfully replaced 1 block(s) in src/foo.ts.\n\n${diff}`),
      isError: false,
    }),
  ]);
  await render(
    () => <Transcript sessionId="native" frames={() => events} sync={() => {}} width={60} />,
    target.renderer,
  );
  await target.renderOnce();
  await Bun.sleep(10);
  const frame = target.captureCharFrame();
  expect(frame).toContain("edit src/foo.ts");
  expect(frame).toContain("foo.ts");
  expect(frame).not.toContain("tool> edit");
  // Prose summary stays out of the chat body — diffs only.
  expect(frame).not.toContain("Successfully replaced");
  target.renderer.destroy();
});
