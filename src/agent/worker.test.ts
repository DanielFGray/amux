import { test, expect } from "bun:test";
import { Chat, LanguageModel, Prompt, Response, Tool, Toolkit } from "@effect/ai";
import { Effect, Schema as S, Stream } from "effect";
import { makeAgentWorker } from "./worker.ts";
import type { AgentFrame } from "../effect/AttachProtocol.ts";

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5);
};

/**
 * A provider that replays scripted parts and records the prompt it was handed.
 * `LanguageModel.make` is the library's own seam, so the worker under test is
 * wired exactly as it is in production — only the provider is fake.
 */
const scriptedModel = (
  script: (call: number) => ReadonlyArray<Response.StreamPartEncoded>,
  options?: {
    readonly seen?: Prompt.Prompt[];
    /** Keep the stream open after the script, so a turn can be interrupted. */
    readonly hold?: boolean;
  },
) => {
  let call = 0;
  return LanguageModel.make({
    generateText: (providerOptions) => {
      options?.seen?.push(providerOptions.prompt);
      return Effect.succeed([...script(call++)] as never);
    },
    streamText: (providerOptions) => {
      options?.seen?.push(providerOptions.prompt);
      const parts = Stream.fromIterable(script(call++));
      return options?.hold ? Stream.concat(parts, Stream.never) : parts;
    },
  });
};

const runWorker = <A>(
  model: Effect.Effect<LanguageModel.Service>,
  body: (worker: {
    readonly steer: (message: string) => Effect.Effect<void>;
    readonly interrupt: (reason?: string) => Effect.Effect<void>;
    readonly close: Effect.Effect<void>;
  }, chat: Chat.Service) => Effect.Effect<A>,
  options?: {
    readonly emit?: (frame: AgentFrame) => Effect.Effect<void>;
    readonly toolkit?: Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>>;
  },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* Chat.empty;
        const worker = yield* makeAgentWorker({
          session: "agent-test",
          chat,
          emit: options?.emit ?? (() => Effect.void),
          ...(options?.toolkit ? { toolkit: options.toolkit } : {}),
        });
        return yield* body(worker, chat);
      }).pipe(Effect.provideServiceEffect(LanguageModel.LanguageModel, model)),
    ),
  );

const roles = (prompt: Prompt.Prompt) => prompt.content.map((message) => message.role);

test("drains a prompt and emits semantic frames", async () => {
  const frames: AgentFrame[] = [];
  await runWorker(
    scriptedModel(() => [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "hello" },
      { type: "text-end", id: "t1" },
    ]),
    (worker) =>
      worker.steer("inspect the pane").pipe(
        Effect.andThen(
          Effect.promise(() => waitFor(() => frames.some((f) => f._tag === "turn.end"))),
        ),
      ),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  expect(frames.map((frame) => frame._tag)).toEqual([
    "agent.status",
    "turn.start",
    "text.delta",
    "turn.end",
    "agent.status",
  ]);
  expect(frames.find((frame) => frame._tag === "turn.start")).toMatchObject({
    prompt: "inspect the pane",
  });
});

test("a tool call is resolved by the toolkit and reported as a result frame", async () => {
  const frames: AgentFrame[] = [];
  const capture = Tool.make("pane_capture", {
    description: "capture a pane",
    parameters: { session: S.String },
    success: S.Unknown,
  });
  const toolkit = Toolkit.make(capture);
  const handlers = toolkit.of({
    pane_capture: (input: { session: string }) =>
      Effect.succeed({ captured: "screen", session: input.session }),
  } as never);
  const resolved = toolkit.pipe(Effect.provide(toolkit.toLayer(handlers)));

  await runWorker(
    scriptedModel((call) =>
      call === 0
        ? [
            {
              type: "tool-call",
              id: "call-1",
              name: "pane_capture",
              params: { session: "target" },
              providerExecuted: false,
            },
          ]
        : [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "done" },
            { type: "text-end", id: "t1" },
          ],
    ),
    (worker) =>
      worker.steer("capture it").pipe(
        Effect.andThen(
          Effect.promise(() => waitFor(() => frames.some((f) => f._tag === "tool.result"))),
        ),
      ),
    {
      emit: (frame) => Effect.sync(() => void frames.push(frame)),
      toolkit: resolved as never,
    },
  );

  expect(frames.find((frame) => frame._tag === "tool.start")).toMatchObject({
    call: "call-1",
    tool: "pane_capture",
  });
  expect(frames.find((frame) => frame._tag === "tool.result")).toMatchObject({
    call: "call-1",
    isError: false,
  });
});

test("a second steer carries prior turns as structured messages, not concatenated text", async () => {
  const seen: Prompt.Prompt[] = [];
  await runWorker(
    scriptedModel(
      () => [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "no errors" },
        { type: "text-end", id: "t1" },
      ],
      { seen },
    ),
    (worker) =>
      worker.steer("check the logs").pipe(
        Effect.andThen(Effect.promise(() => waitFor(() => seen.length > 0))),
        Effect.andThen(worker.steer("now check the error")),
        Effect.andThen(Effect.promise(() => waitFor(() => seen.length > 1))),
      ),
  );

  expect(seen.length).toBeGreaterThanOrEqual(2);
  // First turn: one user message, nothing else.
  expect(roles(seen[0]!)).toEqual(["user"]);
  // Second turn: the prior exchange survives as separate role-tagged messages
  // rather than being flattened into one user turn.
  expect(roles(seen[1]!)).toEqual(["user", "assistant", "user"]);
});

test("interrupt ends the turn as interrupted and keeps the partial text", async () => {
  const frames: AgentFrame[] = [];
  await runWorker(
    scriptedModel(
      () => [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "partial" },
      ],
      { hold: true },
    ),
    (worker) =>
      Effect.gen(function* () {
        yield* worker.steer("start");
        yield* Effect.promise(() => waitFor(() => frames.some((f) => f._tag === "text.delta")));
        yield* worker.interrupt("human correction");
        yield* Effect.promise(() => waitFor(() => frames.some((f) => f._tag === "turn.end")));
      }),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  expect(frames.some((f) => f._tag === "text.delta" && f.text === "partial")).toBe(true);
  expect(frames.find((f) => f._tag === "turn.end")).toMatchObject({ outcome: "interrupted" });
  expect(frames.at(-1)).toMatchObject({ _tag: "agent.status", state: "idle" });
});

test("streamed tool parameters emit params frames before the call", async () => {
  const frames: AgentFrame[] = [];
  await runWorker(
    scriptedModel(() => [
      { type: "tool-params-start", id: "call-1", name: "grep" },
      { type: "tool-params-delta", id: "call-1", delta: '{"pat' },
      { type: "tool-params-delta", id: "call-1", delta: 'tern":"x"}' },
      { type: "tool-params-end", id: "call-1" },
    ]),
    (worker) =>
      worker.steer("search").pipe(
        Effect.andThen(
          Effect.promise(() => waitFor(() => frames.some((f) => f._tag === "turn.end"))),
        ),
      ),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  expect(frames.map((f) => f._tag)).toEqual([
    "agent.status",
    "turn.start",
    "tool.params-start",
    "tool.params-delta",
    "tool.params-delta",
    "tool.params-end",
    "turn.end",
    "agent.status",
  ]);
});

test("a turn interrupted mid-tool-call leaves no unpaired tool call in history", async () => {
  const frames: AgentFrame[] = [];
  const chatHistory = await runWorker(
    scriptedModel(
      () => [
        {
          type: "tool-call",
          id: "call-1",
          name: "slow_tool",
          params: {},
          providerExecuted: false,
        },
      ],
      { hold: true },
    ),
    (worker, chat) =>
      Effect.gen(function* () {
        yield* worker.steer("run it");
        yield* Effect.promise(() => waitFor(() => frames.some((f) => f._tag === "tool.start")));
        yield* worker.interrupt();
        yield* Effect.promise(() => waitFor(() => frames.some((f) => f._tag === "turn.end")));
        return yield* chat.history;
      }),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  // An assistant message carrying a tool call with no matching tool result is
  // rejected outright by Anthropic, so an interrupted turn must never leave one.
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of chatHistory.content) {
    if (message.role !== "assistant" && message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.id);
      if (part.type === "tool-result") results.add(part.id);
    }
  }
  for (const id of calls) expect(results.has(id)).toBe(true);
});
