import { test, expect } from "bun:test";
import { AiError, Chat, LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { Effect, Ref, Schema as S, Stream } from "effect";
import { makeAgentWorker, sanitizeAgentError } from "./worker.ts";
import { testEffect } from "@danielfgray/amux/testing"
import { AgentDelta } from "@danielfgray/amux/protocol"
import type { AgentEventPayload } from "@danielfgray/amux/protocol"
import { waitFor } from "@danielfgray/amux/testing"
type WorkerFrame = AgentEventPayload | AgentDelta;

/** Wait for the worker to emit a frame, since a turn ends asynchronously. */
const awaitFrame = (frames: readonly WorkerFrame[], tag: WorkerFrame["_tag"], count = 1) =>
  Effect.promise(() =>
    waitFor(
      () => frames.filter((frame) => frame._tag === tag).length >= count,
      count === 1 ? `a ${tag} frame` : `${count} ${tag} frames`,
    ),
  );

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
  body: (
    worker: {
      readonly prompt: (
        text: string,
        options?: {
          readonly id?: string;
          readonly delivery?: "steer" | "queue";
          readonly resume?: boolean;
        },
      ) => Effect.Effect<void>;
      readonly interrupt: (reason?: string) => Effect.Effect<void>;
      readonly close: Effect.Effect<void>;
    },
    chat: Chat.Service,
  ) => Effect.Effect<A>,
  options?: {
    readonly emit?: (frame: WorkerFrame) => Effect.Effect<void>;
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
          toolkit: options?.toolkit,
        });
        return yield* body(worker, chat);
        // `toolkit` above is typed as `Toolkit.WithHandler<Record<string, Tool.Any>>`, and
        // `Tool.Any`'s requirements resolve to `any`, so `makeAgentWorker`'s inferred
        // context is `any` here even though every call site provides the toolkit's
        // real handlers via `Effect.provide` before it ever reaches `runWorker`.
      }).pipe(Effect.provideServiceEffect(LanguageModel.LanguageModel, model)) as Effect.Effect<A>,
    ),
  );

const roles = (prompt: Prompt.Prompt) => prompt.content.map((message) => message.role);

test("drains a prompt and emits semantic frames", async () => {
  const frames: WorkerFrame[] = [];
  await runWorker(
    scriptedModel(() => [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "hello" },
      { type: "text-end", id: "t1" },
    ]),
    (worker) =>
      worker.prompt("inspect the pane").pipe(Effect.andThen(awaitFrame(frames, "turn.end"))),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  expect(frames.map((frame) => frame._tag)).toEqual([
    "turn.queued",
    "turn.start",
    "topic",
    "text.delta",
    "turn.end",
    "topic",
    "topic",
  ]);
  expect(frames.find((frame) => frame._tag === "turn.start")).toMatchObject({
    prompt: "inspect the pane",
  });
});

test("forwards provider reasoning deltas", async () => {
  const frames: WorkerFrame[] = [];
  await runWorker(
    scriptedModel(() => [
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "checking files" },
      { type: "reasoning-end", id: "r1" },
    ]),
    (worker) => worker.prompt("inspect").pipe(Effect.andThen(awaitFrame(frames, "turn.end"))),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  expect(frames).toContainEqual({
    _tag: "reasoning.delta",
    session: "agent-test",
    turn: expect.any(String),
    text: "checking files",
  });
});

test("a tool call is resolved by the toolkit and reported as a result frame", async () => {
  const frames: WorkerFrame[] = [];
  const seen: Prompt.Prompt[] = [];
  const capture = Tool.make("pane_capture", {
    description: "capture a pane",
    parameters: S.Struct({ session: S.String }),
    success: S.Unknown,
  });
  const toolkit = Toolkit.make(capture);
  const handlers = toolkit.of({
    pane_capture: (input: { session: string }) =>
      Effect.succeed({ captured: "screen", session: input.session }),
  } as never);
  const resolved = toolkit.pipe(Effect.provide(toolkit.toLayer(handlers)));

  await runWorker(
    scriptedModel(
      (call) =>
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
      { seen },
    ),
    (worker) => worker.prompt("capture it").pipe(Effect.andThen(awaitFrame(frames, "turn.end"))),
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
  expect(seen).toHaveLength(2);
  expect(roles(seen[0]!)).toEqual(["user"]);
  expect(roles(seen[1]!)).toEqual(["user", "assistant", "tool"]);
  expect(frames.filter((frame) => frame._tag === "turn.end")).toHaveLength(1);
  expect(frames.find((frame) => frame._tag === "turn.end")).toMatchObject({
    text: "done",
  });
});

test("continues through successive tool calls before ending the turn", async () => {
  const frames: WorkerFrame[] = [];
  const lookup = Tool.make("lookup", {
    description: "look up a value",
    parameters: S.Struct({ value: S.String }),
    success: S.String,
  });
  const toolkit = Toolkit.make(lookup);
  const handlers = toolkit.of({
    lookup: ({ value }: { value: string }) => Effect.succeed(`found ${value}`),
  } as never);

  await runWorker(
    scriptedModel((call) =>
      call < 2
        ? [
            {
              type: "tool-call",
              id: `call-${call + 1}`,
              name: "lookup",
              params: { value: String(call + 1) },
              providerExecuted: false,
            },
          ]
        : [{ type: "text-delta", id: "t1", delta: "finished" }],
    ),
    (worker) => worker.prompt("look twice").pipe(Effect.andThen(awaitFrame(frames, "turn.end"))),
    {
      emit: (frame) => Effect.sync(() => void frames.push(frame)),
      toolkit: toolkit.pipe(Effect.provide(toolkit.toLayer(handlers))) as never,
    },
  );

  expect(frames.filter((frame) => frame._tag === "tool.result")).toHaveLength(2);
  expect(frames.filter((frame) => frame._tag === "turn.end")).toHaveLength(1);
  expect(frames.find((frame) => frame._tag === "turn.end")).toMatchObject({
    text: "finished",
  });
});

test("a steer at a tool continuation boundary replaces the empty continuation", async () => {
  const frames: WorkerFrame[] = [];
  const seen: Prompt.Prompt[] = [];
  let releaseTool: (() => void) | undefined;
  const toolFinished = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const lookup = Tool.make("lookup", {
    description: "look up a value",
    parameters: S.Struct({}),
    success: S.String,
  });
  const toolkit = Toolkit.make(lookup);
  const handlers = toolkit.of({
    lookup: () => Effect.promise(() => toolFinished).pipe(Effect.as("found")),
  } as never);

  await runWorker(
    scriptedModel(
      (call) =>
        call === 0
          ? [
              {
                type: "tool-call",
                id: "call-1",
                name: "lookup",
                params: {},
                providerExecuted: false,
              },
            ]
          : [{ type: "text-delta", id: "t1", delta: "steered" }],
      { seen },
    ),
    (worker) =>
      Effect.gen(function* () {
        yield* worker.prompt("first");
        yield* awaitFrame(frames, "tool.start");
        yield* worker.prompt("change direction", { delivery: "steer" });
        yield* Effect.sync(() => releaseTool?.());
        yield* awaitFrame(frames, "turn.end", 2);
      }),
    {
      emit: (frame) => Effect.sync(() => void frames.push(frame)),
      toolkit: toolkit.pipe(Effect.provide(toolkit.toLayer(handlers))) as never,
    },
  );

  expect(seen.map(roles)).toEqual([["user"], ["user", "assistant", "tool", "user"]]);
  expect(frames.filter((frame) => frame._tag === "turn.start").map((frame) => frame.turn)).toEqual([
    "turn-1",
    "turn-2",
  ]);
  expect(frames.filter((frame) => frame._tag === "turn.end").map((frame) => frame.turn)).toEqual([
    "turn-2",
    "turn-1",
  ]);
});

test("a second prompt carries prior turns as structured messages, not concatenated text", async () => {
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
      worker
        .prompt("check the logs")
        .pipe(
          Effect.andThen(Effect.promise(() => waitFor(() => seen.length > 0, "the first turn"))),
          Effect.andThen(worker.prompt("now check the error")),
          Effect.andThen(Effect.promise(() => waitFor(() => seen.length > 1, "the second turn"))),
        ),
  );

  expect(seen.length).toBeGreaterThanOrEqual(2);
  // First turn: one user message, nothing else.
  expect(roles(seen[0]!)).toEqual(["user"]);
  // Second turn: the prior exchange survives as separate role-tagged messages
  // rather than being flattened into one user turn.
  expect(roles(seen[1]!)).toEqual(["user", "assistant", "user"]);
});

testEffect("a restored chat sends prior structured history exactly once", () =>
  Effect.gen(function* () {
    const saved: string[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* Chat.empty;
        const worker = yield* makeAgentWorker({
          session: "agent-test",
          chat,
          emit: () => Effect.void,
          persist: chat.exportJson.pipe(
            Effect.tap((history) => Effect.sync(() => saved.push(history))),
            Effect.orDie,
          ),
        });
        yield* worker.prompt("first");
        yield* Effect.promise(() => waitFor(() => saved.length === 1, "the history to be saved"));
      }).pipe(
        Effect.provideServiceEffect(
          LanguageModel.LanguageModel,
          scriptedModel(() => [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "answer" },
            { type: "text-end", id: "t1" },
          ]),
        ),
      ),
    );
    const seen: Prompt.Prompt[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* Chat.fromJson(saved[0]!);
        const worker = yield* makeAgentWorker({
          session: "agent-test",
          chat,
          emit: () => Effect.void,
        });
        yield* worker.prompt("second");
        yield* Effect.promise(() => waitFor(() => seen.length === 1, "the resumed turn"));
      }).pipe(
        Effect.provideServiceEffect(
          LanguageModel.LanguageModel,
          scriptedModel(() => [{ type: "text-delta", id: "t2", delta: "again" }], { seen }),
        ),
      ),
    );

    expect(roles(seen[0]!)).toEqual(["user", "assistant", "user"]);
  }),
);

test("interrupt ends the turn as interrupted and keeps the partial text", async () => {
  const frames: WorkerFrame[] = [];
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
        yield* worker.prompt("start");
        yield* awaitFrame(frames, "text.delta");
        yield* worker.interrupt("human correction");
        yield* awaitFrame(frames, "turn.end");
      }),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  expect(frames.some((f) => f._tag === "text.delta" && f.text === "partial")).toBe(true);
  expect(frames.find((f) => f._tag === "turn.end")).toMatchObject({
    outcome: "interrupted",
  });
  expect(
    frames.some((f) => f._tag === "topic" && f.topic === "session.state" && f.payload === "idle"),
  ).toBe(true);
  expect(frames.at(-1)).toMatchObject({
    _tag: "topic",
    topic: "amux.agent-awareness/identity-state",
    payload: { agent: "native", state: "idle" },
  });
});

/**
 * A failed turn has to say why.
 *
 * The turn is the error's only channel: runTurn absorbs the failure afterwards
 * so a provider 500 cannot end the session, which means anything settle drops
 * is lost for good. Without the reason a rejected request looks exactly like a
 * model with nothing to say — the pane shows `status> failed` and nothing else.
 */
test("a turn that fails reports the cause and leaves the session usable", async () => {
  const frames: WorkerFrame[] = [];
  let calls = 0;
  await runWorker(
    LanguageModel.make({
      generateText: () => Effect.succeed([] as never),
      streamText: () =>
        calls++ === 0
          ? Stream.fail(
              new AiError.AiError({
                module: "test",
                method: "streamText",
                reason: new AiError.InvalidOutputError({
                  description: "provider rejected the tool schema",
                }),
              }),
            )
          : Stream.fromIterable([
              { type: "text-delta", id: "t1", delta: "second" },
            ] as Response.StreamPartEncoded[]),
    }),
    (worker) =>
      Effect.gen(function* () {
        yield* worker.prompt("first");
        yield* awaitFrame(frames, "turn.end");
        yield* worker.prompt("second");
        yield* awaitFrame(frames, "turn.end", 2);
      }),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  const [failed, recovered] = frames.filter((f) => f._tag === "turn.end");
  expect(failed).toMatchObject({ outcome: "failed" });
  expect((failed as { error?: string }).error).toBe(
    "The agent worker failed while processing the request.",
  );
  // `session.state` stays the neutral "idle" even on failure — the failure
  // itself is only visible on the awareness identity topic.
  expect(
    frames.some(
      (frame) =>
        frame._tag === "topic" &&
        frame.topic === "amux.agent-awareness/identity-state" &&
        typeof frame.payload === "object" &&
        frame.payload !== null &&
        (frame.payload as { state?: unknown }).state === "failed",
    ),
  ).toBe(true);
  // The next turn still runs: a failure ends the turn, never the worker.
  expect(recovered).toMatchObject({ outcome: "completed" });
  expect((recovered as { error?: string }).error).toBeUndefined();
});

test("sanitizes provider failure categories without exposing diagnostics", () => {
  expect(sanitizeAgentError(new Error("401 invalid api key sk-secret"))).toBe(
    "Provider authentication failed. Check Settings > auth.",
  );
  expect(sanitizeAgentError(new Error("fetch failed: connection reset"))).toBe(
    "Provider is unavailable. Check your network and try again.",
  );
  expect(sanitizeAgentError(new Error("unexpected provider detail"))).toBe(
    "The agent worker failed while processing the request.",
  );
});

test("streamed tool parameters emit params frames before the call", async () => {
  const frames: WorkerFrame[] = [];
  await runWorker(
    scriptedModel(() => [
      { type: "tool-params-start", id: "call-1", name: "grep" },
      { type: "tool-params-delta", id: "call-1", delta: '{"pat' },
      { type: "tool-params-delta", id: "call-1", delta: 'tern":"x"}' },
      { type: "tool-params-end", id: "call-1" },
    ]),
    (worker) => worker.prompt("search").pipe(Effect.andThen(awaitFrame(frames, "turn.end"))),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  expect(frames.map((f) => f._tag)).toEqual([
    "turn.queued",
    "turn.start",
    "topic",
    "tool.params-start",
    "tool.params-delta",
    "tool.params-delta",
    "tool.params-end",
    "turn.end",
    "topic",
    "topic",
  ]);
});

test("a turn interrupted mid-tool-call leaves no unpaired tool call in history", async () => {
  const frames: WorkerFrame[] = [];
  // The tool never returns, so the interrupt below lands while the call is
  // still open — the only state that can strand an unpaired call.
  const slow = Tool.make("slow_tool", {
    description: "never finishes",
    parameters: S.Struct({}),
    success: S.String,
  });
  const toolkit = Toolkit.make(slow);
  const handlers = toolkit.of({ slow_tool: () => Effect.never } as never);

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
        yield* worker.prompt("run it");
        yield* awaitFrame(frames, "tool.start");
        yield* worker.interrupt();
        yield* awaitFrame(frames, "turn.end");
        return yield* Ref.get(chat.history);
      }),
    {
      emit: (frame) => Effect.sync(() => void frames.push(frame)),
      toolkit: toolkit.pipe(Effect.provide(toolkit.toLayer(handlers))) as never,
    },
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
  // Without this the loop below is vacuous: a history that recorded no call at
  // all would satisfy "every call is paired" while testing nothing.
  expect(calls).toContain("call-1");
  for (const id of calls) expect(results.has(id)).toBe(true);
});

test("a prompt queued behind a running turn announces its prompt immediately", async () => {
  const frames: WorkerFrame[] = [];
  const announced = await runWorker(
    scriptedModel(
      () => [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "first" },
      ],
      { hold: true },
    ),
    (worker) =>
      Effect.gen(function* () {
        yield* worker.prompt("first");
        yield* awaitFrame(frames, "text.delta");
        yield* worker.prompt("second");
        const announced = frames.some((f) => f._tag === "turn.queued" && f.prompt === "second");
        yield* worker.interrupt("enough");
        yield* awaitFrame(frames, "turn.end");
        return announced;
      }),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  // The queued prompt is visible before the running turn has ended.
  expect(announced).toBe(true);
});

test("admit without scheduling is visible as queued but does not reach the provider", async () => {
  const frames: WorkerFrame[] = [];
  const seen: Prompt.Prompt[] = [];
  await runWorker(
    scriptedModel(() => [], { seen }),
    (worker) => worker.prompt("later", { resume: false }),
    { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
  );

  expect(seen).toEqual([]);
  expect(frames).toContainEqual({
    _tag: "turn.queued",
    session: "agent-test",
    turn: expect.any(String),
    prompt: "later",
    delivery: "queue",
  });
  expect(frames.some((frame) => frame._tag === "turn.start")).toBe(false);
});
