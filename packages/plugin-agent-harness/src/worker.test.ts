import { expect, test } from "bun:test";
import { AiError, Chat, LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { Deferred, Effect, Match, Ref, Schema as S, Stream } from "effect";
import { makeAgentWorker, sanitizeAgentError } from "./worker.ts";
import { testEffect } from "@danielfgray/amux/testing";
import type { AgentDelta, AgentEventPayload } from "@danielfgray/amux/protocol";
import { readDelta, readEvent, type HarnessDelta, type SequencedHarnessEvent } from "./protocol.ts";
import { waitFor } from "@danielfgray/amux/testing";
type WorkerFrame = AgentEventPayload | AgentDelta;

/**
 * Recover the harness tag a recorded frame carries.
 *
 * `options.emit` now receives the wire envelope, not the harness vocabulary
 * directly: a durable event rides `agent.message` and a live fragment rides
 * `agent.delta`. `topic` and `session.error` carry meaning of their own and
 * pass through unchanged. The synthetic `sequence` is only what `readEvent`
 * requires of a committed frame — these tests emit before any daemon assigns one.
 */
function unwrap(
  frame: WorkerFrame,
): SequencedHarnessEvent | HarnessDelta | WorkerFrame | undefined {
  return Match.value(frame).pipe(
    Match.tag("agent.message", (frame) => readEvent({ ...frame, sequence: 0 })),
    Match.tag("agent.delta", (frame) => readDelta(frame)),
    Match.orElse((frame) => frame),
  );
}

/** Wait for the worker to emit a frame, since a turn ends asynchronously. */
const awaitFrame = (frames: readonly WorkerFrame[], tag: string, count = 1) =>
  Effect.promise(() =>
    waitFor(
      () => frames.filter((frame) => unwrap(frame)?._tag === tag).length >= count,
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
  );

const roles = (prompt: Prompt.Prompt) => prompt.content.map((message) => message.role);

testEffect("drains a prompt and emits semantic frames", () =>
  Effect.gen(function* () {
    const frames: WorkerFrame[] = [];
    yield* runWorker(
      scriptedModel(() => [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hello" },
        { type: "text-end", id: "t1" },
      ]),
      (worker) =>
        worker.prompt("inspect the pane").pipe(Effect.andThen(awaitFrame(frames, "turn.end"))),
      { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
    );

    expect(frames.map((frame) => unwrap(frame)?._tag)).toEqual([
      "turn.queued",
      "turn.start",
      "topic",
      "text.delta",
      "turn.end",
      "topic",
      "topic",
    ]);
    expect(frames.map(unwrap).find((event) => event?._tag === "turn.start")).toMatchObject({
      prompt: "inspect the pane",
    });
  }),
);

testEffect("forwards provider reasoning deltas", () =>
  Effect.gen(function* () {
    const frames: WorkerFrame[] = [];
    yield* runWorker(
      scriptedModel(() => [
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "checking files" },
        { type: "reasoning-end", id: "r1" },
      ]),
      (worker) => worker.prompt("inspect").pipe(Effect.andThen(awaitFrame(frames, "turn.end"))),
      { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
    );

    expect(frames.map(unwrap)).toContainEqual({
      _tag: "reasoning.delta",
      sequence: 0,
      turn: expect.any(String),
      text: "checking files",
    });
  }),
);

testEffect("a tool call is resolved by the toolkit and reported as a result frame", () =>
  Effect.gen(function* () {
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

    yield* runWorker(
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

    const events = frames.map(unwrap);
    expect(events.find((event) => event?._tag === "tool.start")).toMatchObject({
      call: "call-1",
      tool: "pane_capture",
    });
    expect(events.find((event) => event?._tag === "tool.result")).toMatchObject({
      call: "call-1",
      isError: false,
    });
    expect(seen).toHaveLength(2);
    expect(roles(seen[0]!)).toEqual(["user"]);
    expect(roles(seen[1]!)).toEqual(["user", "assistant", "tool"]);
    expect(events.filter((event) => event?._tag === "turn.end")).toHaveLength(1);
    expect(events.find((event) => event?._tag === "turn.end")).toMatchObject({
      text: "done",
    });
  }),
);

testEffect("continues through successive tool calls before ending the turn", () =>
  Effect.gen(function* () {
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

    yield* runWorker(
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

    const events = frames.map(unwrap);
    expect(events.filter((event) => event?._tag === "tool.result")).toHaveLength(2);
    expect(events.filter((event) => event?._tag === "turn.end")).toHaveLength(1);
    expect(events.find((event) => event?._tag === "turn.end")).toMatchObject({
      text: "finished",
    });
  }),
);

testEffect("a steer at a tool continuation boundary replaces the empty continuation", () =>
  Effect.gen(function* () {
    const frames: WorkerFrame[] = [];
    const seen: Prompt.Prompt[] = [];
    const toolFinished = yield* Deferred.make<void>();
    const lookup = Tool.make("lookup", {
      description: "look up a value",
      parameters: S.Struct({}),
      success: S.String,
    });
    const toolkit = Toolkit.make(lookup);
    const handlers = toolkit.of({
      lookup: () => Deferred.await(toolFinished).pipe(Effect.as("found")),
    } as never);

    yield* runWorker(
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
          yield* Deferred.succeed(toolFinished, undefined);
          yield* awaitFrame(frames, "turn.end", 2);
        }),
      {
        emit: (frame) => Effect.sync(() => void frames.push(frame)),
        toolkit: toolkit.pipe(Effect.provide(toolkit.toLayer(handlers))) as never,
      },
    );

    expect(seen.map(roles)).toEqual([["user"], ["user", "assistant", "tool", "user"]]);
    const events = frames.map(unwrap);
    expect(
      events
        .filter(
          (event): event is Extract<SequencedHarnessEvent, { _tag: "turn.start" }> =>
            event?._tag === "turn.start",
        )
        .map((event) => event.turn),
    ).toEqual(["turn-1", "turn-2"]);
    expect(
      events
        .filter(
          (event): event is Extract<SequencedHarnessEvent, { _tag: "turn.end" }> =>
            event?._tag === "turn.end",
        )
        .map((event) => event.turn),
    ).toEqual(["turn-2", "turn-1"]);
  }),
);

testEffect(
  "a second prompt carries prior turns as structured messages, not concatenated text",
  () =>
    Effect.gen(function* () {
      const seen: Prompt.Prompt[] = [];
      yield* runWorker(
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
              Effect.andThen(
                Effect.promise(() => waitFor(() => seen.length > 0, "the first turn")),
              ),
              Effect.andThen(worker.prompt("now check the error")),
              Effect.andThen(
                Effect.promise(() => waitFor(() => seen.length > 1, "the second turn")),
              ),
            ),
      );

      expect(seen.length).toBeGreaterThanOrEqual(2);
      // First turn: one user message, nothing else.
      expect(roles(seen[0]!)).toEqual(["user"]);
      // Second turn: the prior exchange survives as separate role-tagged messages
      // rather than being flattened into one user turn.
      expect(roles(seen[1]!)).toEqual(["user", "assistant", "user"]);
    }),
);

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

testEffect("interrupt ends the turn as interrupted and keeps the partial text", () =>
  Effect.gen(function* () {
    const frames: WorkerFrame[] = [];
    yield* runWorker(
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

    const events = frames.map(unwrap);
    expect(events.some((e) => e?._tag === "text.delta" && e.text === "partial")).toBe(true);
    expect(events.find((e) => e?._tag === "turn.end")).toMatchObject({
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
  }),
);

/**
 * A failed turn has to say why.
 *
 * The turn is the error's only channel: runTurn absorbs the failure afterwards
 * so a provider 500 cannot end the session, which means anything settle drops
 * is lost for good. Without the reason a rejected request looks exactly like a
 * model with nothing to say — the pane shows `status> failed` and nothing else.
 */
testEffect("a turn that fails reports the cause and leaves the session usable", () =>
  Effect.gen(function* () {
    const frames: WorkerFrame[] = [];
    let calls = 0;
    yield* runWorker(
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

    const [failed, recovered] = frames.map(unwrap).filter((e) => e?._tag === "turn.end");
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
  }),
);

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

testEffect("streamed tool parameters emit params frames before the call", () =>
  Effect.gen(function* () {
    const frames: WorkerFrame[] = [];
    yield* runWorker(
      scriptedModel(() => [
        { type: "tool-params-start", id: "call-1", name: "grep" },
        { type: "tool-params-delta", id: "call-1", delta: '{"pat' },
        { type: "tool-params-delta", id: "call-1", delta: 'tern":"x"}' },
        { type: "tool-params-end", id: "call-1" },
      ]),
      (worker) => worker.prompt("search").pipe(Effect.andThen(awaitFrame(frames, "turn.end"))),
      { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
    );

    expect(frames.map(unwrap).map((event) => event?._tag)).toEqual([
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
  }),
);

testEffect("a turn interrupted mid-tool-call leaves no unpaired tool call in history", () =>
  Effect.gen(function* () {
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

    const chatHistory = yield* runWorker(
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
  }),
);

testEffect("a prompt queued behind a running turn announces its prompt immediately", () =>
  Effect.gen(function* () {
    const frames: WorkerFrame[] = [];
    const announced = yield* runWorker(
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
          const announced = frames
            .map(unwrap)
            .some((e) => e?._tag === "turn.queued" && e.prompt === "second");
          yield* worker.interrupt("enough");
          yield* awaitFrame(frames, "turn.end");
          return announced;
        }),
      { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
    );

    // The queued prompt is visible before the running turn has ended.
    expect(announced).toBe(true);
  }),
);

testEffect("admit without scheduling is visible as queued but does not reach the provider", () =>
  Effect.gen(function* () {
    const frames: WorkerFrame[] = [];
    const seen: Prompt.Prompt[] = [];
    yield* runWorker(
      scriptedModel(() => [], { seen }),
      (worker) => worker.prompt("later", { resume: false }),
      { emit: (frame) => Effect.sync(() => void frames.push(frame)) },
    );

    expect(seen).toEqual([]);
    expect(frames.map(unwrap)).toContainEqual({
      _tag: "turn.queued",
      sequence: 0,
      turn: expect.any(String),
      prompt: "later",
      delivery: "queue",
    });
    expect(frames.map(unwrap).some((event) => event?._tag === "turn.start")).toBe(false);
  }),
);
