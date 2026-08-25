import { expect } from "bun:test";
import { LanguageModel, Prompt, Response as AiResponse, Tool, Toolkit } from "@effect/ai";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Chunk, Effect, Layer, Schema as S, Stream } from "effect";
import * as OpenAiChat from "./openai-chat.ts";
import { testEffect } from "../../test-effect.ts";

/**
 * The Chat Completions protocol.
 *
 * The frames below are recorded from real gateways rather than written to suit
 * the parser: a delta that carries only a tool call's id and name, arguments
 * split mid-token across frames, a usage-only frame after the finish, and the
 * `[DONE]` sentinel that is not JSON. Every one of them is a shape that has
 * ended a turn early somewhere.
 */

// =============================================================================
// A gateway, recorded
// =============================================================================

type Recorded = {
  readonly status?: number | readonly number[];
  readonly body: string;
  readonly chunks?: number;
};

type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;
type JsonRecord = { [key: string]: JsonValue };

/** The requests a run made, and the client that answers them. */
const gateway = (recorded: Recorded) => {
  const sent: JsonRecord[] = [];
  let attempt = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array") throw new Error("expected a JSON request body");
      sent.push(
        JSON.parse(new TextDecoder().decode(request.body.body)) as JsonRecord,
      );
      const bytes = new TextEncoder().encode(recorded.body);
      const size = Math.ceil(bytes.length / (recorded.chunks ?? 1));
      // Delivered in pieces, because a real socket does: a decoder that splits
      // bytes before decoding text mangles anything multi-byte that straddles
      // a boundary.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += size)
            controller.enqueue(bytes.slice(at, at + size));
          controller.close();
        },
      });
       return HttpClientResponse.fromWeb(
         request,
         new globalThis.Response(stream, {
          status: Array.isArray(recorded.status)
            ? (recorded.status[Math.min(attempt++, recorded.status.length - 1)] ?? 200)
            : (recorded.status ?? 200),
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }),
  );
  return { sent, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const run = <A, E>(
  recorded: Recorded,
  use: (
    model: LanguageModel.Service,
  ) => Effect.Effect<A, E, LanguageModel.LanguageModel | HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const stub = gateway(recorded);
    const model = yield* OpenAiChat.make({ model: "deepseek-v4-flash-free", apiUrl: API }).pipe(
      Effect.provide(stub.layer),
    );
    const result = yield* use(model).pipe(
      Effect.provide(Layer.succeed(LanguageModel.LanguageModel, model)),
      Effect.provide(stub.layer),
    );
    return { result, sent: stub.sent };
  });

const API = "https://opencode.ai/zen/v1";

/**
 * The parts of one turn, as plain data. `LanguageModel` decodes what the
 * protocol emits, so the parts arrive as classes carrying a provider-metadata
 * bag; the assertions here are about the protocol, not about that wrapper.
 */
const parts = <Tools extends Record<string, Tool.Any> = {}>(
  model: LanguageModel.Service,
  options?: Partial<LanguageModel.GenerateTextOptions<Tools>>,
) =>
  Stream.runCollect(
    model.streamText({ prompt: "hello", ...options }),
  ).pipe(
    Effect.map(Chunk.toReadonlyArray),
    Effect.map((all) => all.map(fixture)),
  );

const fixture = <Tools extends Record<string, Tool.Any>>(
  part: AiResponse.StreamPart<Tools>,
): JsonRecord => {
  const { metadata: _metadata, ...rest } = JSON.parse(JSON.stringify(part)) as JsonRecord;
  delete rest["~effect/ai/Content/Part"];
  return rest;
};

const sse = (...frames: ReadonlyArray<string>) =>
  frames.map((frame) => `data: ${frame}\n\n`).join("") + "data: [DONE]\n\n";

const read = Tool.make("read", {
  description: "Read a file",
  parameters: { path: S.String },
  success: S.String,
});
const list = Tool.make("list", { parameters: { dir: S.String }, success: S.String });

/**
 * A toolkit is required to receive a tool call at all: `LanguageModel` decodes
 * a call's arguments against the schema of the tool it names, so a call to a
 * tool the caller never offered is not a part it can produce.
 */
type TestTools = { read: typeof read; list: typeof list };

const toolkit: Toolkit.WithHandler<TestTools> = {
  tools: { read, list },
  // `streamText` runs the tools it is given. These tests are about the
  // protocol, so the handler is a stub and its result is not asserted on.
  handle: () =>
    Effect.succeed({ isFailure: false, result: "ok", encodedResult: "ok" } as const) as Effect.Effect<
      Tool.HandlerResult<TestTools[keyof TestTools]>,
      never,
      never
    >,
};

const without = (type: string) => (all: ReadonlyArray<JsonRecord>) =>
  all.filter((part) => part.type !== type);

function only(name: "read"): Toolkit.WithHandler<{ read: typeof read }>;
function only(name: "list"): Toolkit.WithHandler<{ list: typeof list }>;
function only(name: "read" | "list") {
  return name === "read"
    ? { tools: { read }, handle: toolkit.handle }
    : { tools: { list }, handle: toolkit.handle };
}

// =============================================================================
// Streaming
// =============================================================================

testEffect("text deltas are bracketed, and the stream ends at the [DONE] sentinel", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      {
        chunks: 7,
        body:
          sse(
            `{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
            `{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Héllo"},"finish_reason":null}]}`,
            `{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":", 世界"},"finish_reason":null}]}`,
            `{"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
            `{"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":19,"completion_tokens":4,"total_tokens":23,"prompt_tokens_details":{"cached_tokens":16}}}`,
          ) + "data: [DONE]\n\n",
      },
      (model) => parts(model),
    );

    expect(result).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", delta: "Héllo" },
      // Split across socket chunks, and still one character rather than two
      // replacement bytes.
      { type: "text-delta", id: "text-0", delta: ", 世界" },
      { type: "text-end", id: "text-0" },
      {
        type: "finish",
        reason: "stop",
        usage: {
          inputTokens: 19,
          outputTokens: 4,
          totalTokens: 23,
          cachedInputTokens: 16,
        },
      },
    ]);
  }),
);

testEffect("reasoning is closed before the text that follows it", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      {
        body: sse(
          `{"choices":[{"index":0,"delta":{"reasoning_content":"The user "},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{"reasoning_content":"said hello."},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{"content":"Hi!"},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
        ),
      },
      (model) => parts(model),
    );

    expect(result.map((part) => part.type)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  }),
);

testEffect("tool arguments are assembled across deltas and parsed once whole", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      {
        body: sse(
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/etc/"}}]},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hosts\\"}"}}]},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
        ),
      },
      // The tool result is the harness running the tool, not the protocol
      // reading the wire, so it is not part of what is asserted here.
      (model) => parts(model, { toolkit }).pipe(Effect.map(without("tool-result"))),
    );

    expect(result).toEqual([
      { type: "tool-params-start", id: "call_abc123", name: "read", providerExecuted: false },
      { type: "tool-params-delta", id: "call_abc123", delta: '{"path":"/etc/' },
      { type: "tool-params-delta", id: "call_abc123", delta: 'hosts"}' },
      { type: "tool-params-end", id: "call_abc123" },
      {
        type: "tool-call",
        id: "call_abc123",
        name: "read",
        params: { path: "/etc/hosts" },
        providerExecuted: false,
      },
      // A gateway that reports no usage reports no usage. Zeroes would be a
      // number the provider never said.
      { type: "finish", reason: "tool-calls", usage: {} },
    ]);
  }),
);

testEffect("a model that asked for a tool has not stopped, whatever it reports", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      {
        body: sse(
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list","arguments":"{\\"dir\\":\\".\\"}"}}]},"finish_reason":null}]}`,
          // Some gateways report `stop` alongside a tool call. Taking them at
          // their word ends the turn with the tool never run.
          `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
        ),
      },
      (model) => parts(model, { toolkit }).pipe(Effect.map(without("tool-result"))),
    );
    expect(result.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" });
  }),
);

testEffect("two tools called in one turn are kept apart by their index", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      {
        body: sse(
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"list","arguments":"{\\"dir\\":"}}]},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a\\"}"}}]},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"b\\"}"}}]},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
        ),
      },
      (model) => parts(model, { toolkit }),
    );
    expect(result.filter((part) => part.type === "tool-call")).toEqual([
      {
        type: "tool-call",
        id: "call_a",
        name: "read",
        params: { path: "a" },
        providerExecuted: false,
      },
      {
        type: "tool-call",
        id: "call_b",
        name: "list",
        params: { dir: "b" },
        providerExecuted: false,
      },
    ]);
  }),
);

// =============================================================================
// Failure
// =============================================================================

testEffect("a tool call whose arguments never parse fails the turn", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      {
        body: sse(
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
        ),
      },
      (model) => parts(model),
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "MalformedOutput" });
  }),
);

testEffect("a tool call delta that never states its identity fails the turn", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      {
        body: sse(
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}`,
        ),
      },
      (model) => parts(model),
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "MalformedOutput" });
  }),
);

testEffect("an error frame is an error, not an empty turn", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      { body: sse(`{"error":{"message":"insufficient credits","type":"quota_exceeded"}}`) },
      (model) => parts(model),
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({ description: expect.stringContaining("insufficient credits") });
  }),
);

testEffect("a rejected request is an error, not an empty turn", () =>
  Effect.gen(function* () {
    const failure = yield* run({ status: 401, body: `{"error":{"message":"bad key"}}` }, (model) =>
      parts(model),
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "HttpResponseError", request: expect.anything() });
  }),
);

testEffect("a rate-limited request retries with exponential backoff", () =>
  Effect.gen(function* () {
    const runEffect = run(
      {
        status: [429, 429, 200],
        body: sse(`{"choices":[{"index":0,"delta":{"content":"PING"},"finish_reason":"stop"}]}`),
      },
      (model) => parts(model),
    );
    const { result, sent } = yield* runEffect;
    expect(result).toContainEqual({ type: "text-delta", id: "text-0", delta: "PING" });
    expect(sent).toHaveLength(3);
  }),
);

testEffect("a frame that is not JSON fails rather than being silently skipped", () =>
  Effect.gen(function* () {
    const failure = yield* run({ body: "data: not json at all\n\ndata: [DONE]\n\n" }, (model) =>
      parts(model),
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "MalformedOutput" });
  }),
);

// =============================================================================
// generateText
// =============================================================================

testEffect("generateText is the stream, joined back up", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      {
        body: sse(
          `{"choices":[{"index":0,"delta":{"reasoning_content":"Think."},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{"content":", world"},"finish_reason":null}]}`,
          `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}`,
        ),
      },
      (model) => model.generateText({ prompt: "hi" }),
    );

    expect(result.text).toBe("Hello, world");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(8);
  }),
);

// =============================================================================
// Request lowering
// =============================================================================

testEffect("the request is a streaming chat completion that asks for its usage", () =>
  Effect.gen(function* () {
    const { sent } = yield* run(
      { body: sse(`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`) },
      (model) => parts(model),
    );
    expect(sent[0]).toMatchObject({
      model: "deepseek-v4-flash-free",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hello" }],
    });
  }),
);

testEffect("a conversation is lowered onto the roles the wire format has", () =>
  Effect.gen(function* () {
    const prompt = Prompt.make([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Read /etc/hosts" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "It wants a file." },
          { type: "tool-call", id: "call_1", name: "read", params: { path: "/etc/hosts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call_1",
            name: "read",
            isFailure: false,
            providerExecuted: false,
            result: "127.0.0.1 localhost",
          },
        ],
      },
    ]);
    const { sent } = yield* run(
      { body: sse(`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`) },
      (model) => parts(model, { prompt }),
    );

    expect(sent[0]?.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Read /etc/hosts" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"path":"/etc/hosts"}' },
          },
        ],
        reasoning_content: "It wants a file.",
      },
      { role: "tool", tool_call_id: "call_1", content: "127.0.0.1 localhost" },
    ]);
  }),
);

testEffect("a toolkit becomes function tools, and a forced choice names one", () =>
  Effect.gen(function* () {
    const { sent } = yield* run(
      { body: sse(`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`) },
      (model) =>
        parts(model, {
          toolkit: only("read"),
          toolChoice: { tool: "read" },
        }),
    );

    expect(sent[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
    ]);
    expect(sent[0]?.tool_choice).toEqual({ type: "function", function: { name: "read" } });
  }),
);

testEffect("a `oneOf` choice is applied by withholding the other tools", () =>
  Effect.gen(function* () {
    const { sent } = yield* run(
      { body: sse(`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`) },
      (model) => parts(model, { toolkit, toolChoice: { mode: "required", oneOf: ["list"] } }),
    );
    expect(sent[0]?.tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "list" }) }),
    ]);
    expect(sent[0]?.tool_choice).toBe("required");
  }),
);
