import { test, expect } from "bun:test";
import { Cause, Effect, Stream } from "effect";
import { makeAgentWorker, type AgentModelPart } from "./worker.ts";
import type { AgentFrame } from "../effect/AttachProtocol.ts";

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(5);
};

test("native worker drains a prompt and emits semantic frames", async () => {
  const frames: AgentFrame[] = [];
  const model = () =>
    Stream.fromIterable<AgentModelPart>([
      { _tag: "text", text: "hello" },
      { _tag: "tool", call: "call-1", tool: "pane.capture", input: {} },
      { _tag: "result", call: "call-1", output: "screen" },
    ]);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const value = yield* makeAgentWorker({
          session: "agent-1",
          model,
          emit: (frame) => Effect.sync(() => void frames.push(frame)),
        });
        yield* value.steer("inspect the pane");
        yield* Effect.promise(() =>
          waitFor(() => frames.some((frame) => frame._tag === "turn.end")),
        );
        return value;
      }),
    ),
  );

  expect(frames.map((frame) => frame._tag)).toEqual([
    "agent.status",
    "turn.start",
    "text.delta",
    "tool.start",
    "tool.result",
    "turn.end",
    "agent.status",
  ]);
  expect(frames.find((frame) => frame._tag === "turn.start")).toMatchObject({
    prompt: "inspect the pane",
  });
});

test("native worker settles a tool call through the injected executor", async () => {
  const frames: AgentFrame[] = [];
  const worker = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const value = yield* makeAgentWorker({
          session: "agent-tool",
           model: (() => {
             let calls = 0;
             return () =>
               calls++ === 0
                 ? Stream.succeed<AgentModelPart>({
                     _tag: "tool",
                     call: "call-1",
                     tool: "pane.capture",
                     input: { session: "target" },
                   })
                 : Stream.succeed<AgentModelPart>({ _tag: "text", text: "done" });
           })(),
          executeTool: (tool, input) => Effect.succeed({ tool, input, captured: "screen" }),
          emit: (frame) => Effect.sync(() => void frames.push(frame)),
        });
        yield* value.steer("capture it");
        yield* Effect.promise(() =>
          waitFor(() => frames.some((frame) => frame._tag === "tool.result")),
        );
      }),
    ),
  );

  expect(frames.find((frame) => frame._tag === "tool.result")).toMatchObject({
    call: "call-1",
    output: { tool: "pane.capture", input: { session: "target" }, captured: "screen" },
    isError: false,
  });
  void worker;
});

test("interrupt preserves partial output and ends the turn as interrupted", async () => {
  const frames: AgentFrame[] = [];
  const model = ({ signal }: { signal: AbortSignal }) =>
    Stream.concat(
      Stream.succeed<AgentModelPart>({ _tag: "text", text: "partial" }),
      Stream.fromEffect(
        Effect.promise(
          () =>
            new Promise<AgentModelPart>((resolve) =>
              signal.addEventListener("abort", () => resolve({ _tag: "text", text: "aborted" }), {
                once: true,
              }),
            ),
        ),
      ),
    );
  const worker = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const value = yield* makeAgentWorker({
          session: "agent-2",
          model,
          emit: (frame) => Effect.sync(() => void frames.push(frame)),
        });
        yield* value.steer("start");
        yield* Effect.promise(() =>
          waitFor(() => frames.some((frame) => frame._tag === "text.delta")),
        );
        yield* value.interrupt("human correction");
        yield* Effect.promise(() =>
          waitFor(() => frames.some((frame) => frame._tag === "turn.end")),
        );
        expect(
          frames.some((frame) => frame._tag === "text.delta" && frame.text === "partial"),
        ).toBe(true);
        expect(frames.find((frame) => frame._tag === "turn.end")).toMatchObject({
          outcome: "interrupted",
        });
      }),
    ),
  );
});
