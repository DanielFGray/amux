import { test, expect } from "bun:test";
import { Cause, Effect, Stream } from "effect";
import { makeAgentWorker, buildConversationPrompt, type AgentModelPart } from "./worker.ts";
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

test("second steer includes prior conversation as context", async () => {
  const prompts: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* makeAgentWorker({
          session: "agent-history",
          model: ({ prompt }) => {
            prompts.push(prompt);
            return Stream.succeed<AgentModelPart>({ _tag: "text", text: "ok" });
          },
          emit: () => Effect.void,
        });
        yield* worker.steer("check the logs");
        yield* Effect.promise(() => waitFor(() => prompts.length > 0));
        yield* worker.steer("now check the error");
        yield* Effect.promise(() => waitFor(() => prompts.length > 1));
      }),
    ),
  );

  expect(prompts.length).toBeGreaterThanOrEqual(2);
  expect(prompts[0]!).toBe("check the logs");
  expect(prompts[1]!).toContain("check the logs");
  expect(prompts[1]!).toContain("now check the error");
});

test("buildConversationPrompt prefixes history before the new message", () => {
  expect(buildConversationPrompt([], "do it")).toBe("do it");
  expect(
    buildConversationPrompt(
      [
        { role: "user", content: "check logs" },
        { role: "assistant", content: "The log shows no errors." },
      ],
      "now check config",
    ),
  ).toBe(
    "user:\ncheck logs\n\nassistant:\nThe log shows no errors.\n\nuser:\nnow check config",
  );
});

test("partial tool streaming emits params-start/delta/end frames before tool.start", async () => {
  const frames: AgentFrame[] = [];
  const model = () =>
    Stream.fromIterable<AgentModelPart>([
      { _tag: "text", text: "ok" },
      { _tag: "tool.params-start", call: "call-1", tool: "grep" },
      { _tag: "tool.params-delta", call: "call-1", delta: "pat" },
      { _tag: "tool.params-delta", call: "call-1", delta: "tern" },
      { _tag: "tool.params-end", call: "call-1" },
      { _tag: "tool", call: "call-1", tool: "grep", input: "pattern" },
      { _tag: "result", call: "call-1", output: "found" },
    ]);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* makeAgentWorker({
          session: "agent-partial",
          model,
          emit: (frame) => Effect.sync(() => void frames.push(frame)),
        });
        yield* worker.steer("search");
        yield* Effect.promise(() =>
          waitFor(() => frames.some((f) => f._tag === "turn.end")),
        );
      }),
    ),
  );

  expect(frames.map((f) => f._tag)).toEqual([
    "agent.status",
    "turn.start",
    "text.delta",
    "tool.params-start",
    "tool.params-delta",
    "tool.params-delta",
    "tool.params-end",
    "tool.start",
    "tool.result",
    "turn.end",
    "agent.status",
  ]);
});

test("interrupted partial tool params appear in next steer context", async () => {
  const prompts: string[] = [];
  const frames: AgentFrame[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* makeAgentWorker({
          session: "agent-partial-tool-ctx",
          model: ({ prompt, signal }) => {
            prompts.push(prompt);
            return Stream.concat(
              Stream.fromIterable<AgentModelPart>([
                { _tag: "tool.params-start", call: "c1", tool: "bash" },
                { _tag: "tool.params-delta", call: "c1", delta: '{"command"' },
                { _tag: "tool.params-delta", call: "c1", delta: ':"ls -la"}' },
              ]),
              Stream.fromEffect(
                Effect.promise(
                  () =>
                    new Promise<AgentModelPart>((resolve) =>
                      signal.addEventListener(
                        "abort",
                        () => resolve({ _tag: "text", text: "x" }),
                        { once: true },
                      ),
                    ),
                ),
              ),
            );
          },
          emit: (frame) => Effect.sync(() => void frames.push(frame)),
        });
        yield* worker.steer("first");
        yield* Effect.promise(() =>
          Promise.resolve(waitFor(() => frames.some((f) => f._tag === "tool.params-delta"))),
        );
        yield* worker.interrupt();
        yield* worker.steer("second");
        yield* Effect.promise(() =>
          Promise.resolve(waitFor(() => prompts.length > 1)),
        );
      }),
    ),
  );

  expect(prompts.length).toBeGreaterThanOrEqual(2);
  expect(prompts[0]!).toBe("first");
  expect(prompts[1]!).toContain("bash");
  expect(prompts[1]!).toContain('{"command"');
  expect(prompts[1]!).toContain("second");
});

test("interrupted turn retains partial context for next steer", async () => {
  const prompts: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* makeAgentWorker({
          session: "agent-interrupt-ctx",
          model: ({ prompt, signal }) => {
            prompts.push(prompt);
            return Stream.concat(
              Stream.succeed<AgentModelPart>({ _tag: "text", text: "partial response" }),
              Stream.fromEffect(
                Effect.promise(
                  () =>
                    new Promise<AgentModelPart>((resolve) =>
                      signal.addEventListener("abort", () => resolve({ _tag: "text", text: "x" }), {
                        once: true,
                      }),
                    ),
                ),
              ),
            );
          },
          emit: () => Effect.void,
        });
        yield* worker.steer("first message");
        yield* Effect.promise(() => Promise.resolve(waitFor(() => prompts.length > 0)));
        yield* worker.interrupt();
        // Interrupt signals the abort controller — the model's second part
        // resolves into a now-interrupted stream, so the turn processes
        // pushPartialContext and ends. Wait for the second steer to land.
        yield* worker.steer("second message");
        yield* Effect.promise(() => Promise.resolve(waitFor(() => prompts.length > 1)));
      }),
    ),
  );

  expect(prompts.length).toBeGreaterThanOrEqual(2);
  expect(prompts[0]!).toBe("first message");
  expect(prompts[1]!).toContain("first message");
  expect(prompts[1]!).toContain("partial response");
  expect(prompts[1]!).toContain("second message");
});
