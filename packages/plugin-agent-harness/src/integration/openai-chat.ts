import { AiError, LanguageModel, Prompt, Response, Tool } from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { Effect, Layer, Schedule, Schema as S, Stream } from "effect";

/**
 * A `LanguageModel` that speaks OpenAI's Chat Completions API.
 *
 * `@effect/ai-openai` speaks the Responses API. A gateway that is only
 * OpenAI-*compatible* serves `/chat/completions` and nothing else, so a
 * Responses request against it returns SSE frames of a shape the Responses
 * decoder does not recognise — which it drops, one by one, in silence. The
 * result is a turn that completes with no content and no error. This module
 * exists so that the protocol a model actually speaks can be chosen, rather
 * than assumed from the fact that the provider takes a bearer token.
 *
 * Only the streaming form is implemented on the wire. `generateText` folds the
 * same stream into final parts, so there is one request shape, one decoder and
 * one state machine to be correct about instead of two.
 */
export const layer = (options: Options): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(LanguageModel.LanguageModel, make(options)).pipe(
    Layer.provide(FetchHttpClient.layer),
  );

export type Options = {
  readonly model: string;
  /** Root of the provider's API, without `/chat/completions`. */
  readonly apiUrl?: string;
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
};

const DEFAULT_API_URL = "https://api.openai.com/v1";
const MODULE = "OpenAiChatLanguageModel";

export const make = Effect.fnUntraced(function* (options: Options) {
  const http = yield* HttpClient.HttpClient;
  const client = (options.transformClient ?? ((c: HttpClient.HttpClient) => c))(
    HttpClient.filterStatusOk(http),
  );
  const url = `${(options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "")}/chat/completions`;

  const send = (provider: LanguageModel.ProviderOptions) =>
    body(options.model, provider).pipe(
      Effect.map((payload) =>
        request(
          client.execute(HttpClientRequest.post(url, { body: HttpBody.jsonUnsafe(payload) })),
        ).pipe(
          Effect.map((response) => response.stream),
          Stream.unwrap,
        ),
      ),
      Stream.unwrap,
      Stream.mapError((error) => toAiError("streamText", error)),
    );

  const stream = (provider: LanguageModel.ProviderOptions) =>
    Stream.suspend(() => {
      const state = initialState();
      return events(send(provider)).pipe(
        Stream.mapEffect((event) => step(state, event)),
        Stream.flattenIterable,
        Stream.concat(Stream.unwrap(Effect.map(finish(state), Stream.fromIterable))),
      );
    });

  return yield* LanguageModel.make({
    streamText: stream,
    generateText: (provider) => Stream.runCollect(stream(provider)).pipe(Effect.map(gather)),
  });
});

// =============================================================================
// Request
// =============================================================================
// The only place that knows how `@effect/ai`'s prompt maps onto the Chat
// Completions wire format. Provider quirks belong here, not in the caller.

const body = Effect.fnUntraced(function* (model: string, options: LanguageModel.ProviderOptions) {
  const choice = toolChoice(options.toolChoice);
  // A `oneOf` choice restricts which tools the model may see. OpenAI's wire
  // format has no such field, so the restriction is applied by omitting the
  // rest of the tools from the request.
  const allowed =
    choice.oneOf === undefined
      ? options.tools
      : options.tools.filter((tool) => choice.oneOf?.has(tool.name));
  const tools = allowed.filter(Tool.isUserDefined).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: Tool.getDescription(tool) ?? "",
      parameters: Tool.getJsonSchema(tool),
    },
  }));
  const result: RequestBody = {
    model,
    messages: yield* messages(options.prompt),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length > 0) result.tools = tools;
  if (choice.value !== undefined && tools.length > 0) result.tool_choice = choice.value;
  if (options.responseFormat.type === "json")
    result.response_format = { type: "json_object" as const };
  return result;
});

type ToolChoice = {
  readonly value?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  readonly oneOf?: ReadonlySet<string>;
};

type RequestBody = {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: ReadonlyArray<{
    type: "function";
    function: { name: string; description: string; parameters: object };
  }>;
  tool_choice?: ToolChoice["value"];
  response_format?: { type: "json_object" };
};

const toolChoice = (choice: LanguageModel.ToolChoice<string>): ToolChoice => {
  if (typeof choice === "string") return { value: choice };
  if ("tool" in choice) return { value: { type: "function", function: { name: choice.tool } } };
  return { value: choice.mode === "required" ? "required" : "auto", oneOf: new Set(choice.oneOf) };
};

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ReadonlyArray<UserContent> }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ReadonlyArray<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
      reasoning_content?: string;
    }
  | { role: "tool"; tool_call_id: string; content: string };

type UserContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

const messages = Effect.fnUntraced(function* (prompt: Prompt.Prompt) {
  const out: ChatMessage[] = [];
  for (const message of prompt.content) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      out.push(yield* userMessage(message.content));
      continue;
    }
    if (message.role === "tool") {
      out.push(
        ...message.content
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
          .map(toolResult),
      );
      continue;
    }
    out.push(assistantMessage(message.content));
  }
  return out;
});

const userMessage = Effect.fnUntraced(function* (parts: ReadonlyArray<Prompt.UserMessagePart>) {
  const content: UserContent[] = [];
  for (const part of parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else content.push({ type: "image_url", image_url: { url: yield* dataUrl(part) } });
  }
  // A text-only message is sent as a bare string: some compatible gateways
  // reject the array form for text, and every one of them accepts the string.
  return content.every((part) => part.type === "text")
    ? ({ role: "user", content: content.map((part) => part.text).join("") } as const)
    : ({ role: "user", content } as const);
});

const dataUrl = (part: Prompt.FilePart) =>
  part.data instanceof URL
    ? Effect.succeed(part.data.href)
    : part.data instanceof Uint8Array
      ? Effect.succeed(`data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`)
      : // Already a URL, or already base64. Anything else is unrepresentable.
        Effect.succeed(
          /^(https?|data):/.test(part.data)
            ? part.data
            : `data:${part.mediaType};base64,${part.data}`,
        );

const assistantMessage = (parts: ReadonlyArray<Prompt.AssistantMessagePart>): ChatMessage => {
  const text = parts.filter((part) => part.type === "text").map((part) => part.text);
  const reasoning = parts.filter((part) => part.type === "reasoning").map((part) => part.text);
  const calls = parts.filter((part) => part.type === "tool-call");
  const result: ChatMessage = {
    role: "assistant",
    content: text.length === 0 ? null : text.join(""),
  };
  if (calls.length > 0)
    result.tool_calls = calls.map((part) => ({
      id: part.id,
      type: "function" as const,
      function: { name: part.name, arguments: JSON.stringify(part.params ?? {}) },
    }));
  if (reasoning.length > 0) result.reasoning_content = reasoning.join("");
  return result;
};

const toolResult = (part: Prompt.ToolResultPart): ChatMessage => ({
  role: "tool",
  tool_call_id: part.id,
  content: typeof part.result === "string" ? part.result : JSON.stringify(part.result ?? null),
});

// =============================================================================
// Wire events
// =============================================================================
// One decoded SSE `data:` payload. Every field is optional because the set a
// gateway actually sends varies, and a frame we do not understand must not be
// the thing that fails a turn.

const Nullish = <A, I>(schema: S.Codec<A, I>) => S.optional(S.NullOr(schema));

const ToolCallDelta = S.Struct({
  index: S.Number,
  id: Nullish(S.String),
  function: Nullish(S.Struct({ name: Nullish(S.String), arguments: Nullish(S.String) })),
});

const ChatEvent = S.Struct({
  choices: S.optional(
    S.Array(
      S.Struct({
        delta: Nullish(
          S.Struct({
            content: Nullish(S.String),
            reasoning_content: Nullish(S.String),
            reasoning: Nullish(S.String),
            tool_calls: Nullish(S.Array(ToolCallDelta)),
          }),
        ),
        finish_reason: Nullish(S.String),
      }),
    ),
  ),
  usage: Nullish(
    S.Struct({
      prompt_tokens: S.optional(S.Number),
      completion_tokens: S.optional(S.Number),
      total_tokens: S.optional(S.Number),
      prompt_tokens_details: Nullish(S.Struct({ cached_tokens: S.optional(S.Number) })),
      completion_tokens_details: Nullish(S.Struct({ reasoning_tokens: S.optional(S.Number) })),
    }),
  ),
  error: Nullish(S.Struct({ message: S.optional(S.String), type: S.optional(S.String) })),
});
type ChatEvent = typeof ChatEvent.Type;

const decodeEvent = S.decodeUnknownEffect(S.fromJsonString(ChatEvent));

/**
 * SSE frames, decoded.
 *
 * The byte stream is decoded to text before it is split into lines: splitting
 * raw bytes and decoding the pieces mangles any multi-byte character that
 * happens to straddle a chunk boundary. `[DONE]` terminates the stream — it is
 * a sentinel, not JSON, and decoding it is the classic way to end a turn with
 * a parse error instead of a result.
 */
const events = (stream: Stream.Stream<Uint8Array, AiError.AiError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map((line) => line.trim()),
    Stream.filter((line) => line.startsWith("data:")),
    Stream.map((line) => line.slice("data:".length).trim()),
    Stream.takeWhile((data) => data !== "[DONE]"),
    Stream.mapEffect((data) =>
      decodeEvent(data).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.fail(
            AiError.make({
              module: MODULE,
              method: "streamText",
              reason: AiError.InvalidOutputError.fromSchemaError(error),
            }),
          ),
        ),
      ),
    ),
  );

/**
 * The client is status-filtered, so an authentication or quota rejection
 * surfaces as an `HttpClientError` rather than as an empty turn. Every non-2xx
 * response and every transport failure retries a bounded number of times
 * before it is converted to the `AiError` shape `@effect/ai` states.
 */
const request = <A>(effect: Effect.Effect<A, HttpClientError.HttpClientError>) =>
  effect.pipe(
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential("250 millis"),
      while: retryableHttpError,
    }),
  );

const retryableHttpError = (error: HttpClientError.HttpClientError): boolean => {
  switch (error.reason._tag) {
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError":
      return true;
    case "StatusCodeError": {
      const status = error.reason.response.status;
      return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    }
    default:
      return false;
  }
};

const toAiError = (method: string, error: HttpClientError.HttpClientError): AiError.AiError => {
  const reason = error.reason;
  if (reason._tag === "StatusCodeError")
    return AiError.make({
      module: MODULE,
      method,
      reason: AiError.reasonFromHttpStatus({
        status: reason.response.status,
        description: reason.description,
      }),
    });
  if (
    reason._tag === "TransportError" ||
    reason._tag === "EncodeError" ||
    reason._tag === "InvalidUrlError"
  )
    return AiError.make({
      module: MODULE,
      method,
      reason: AiError.NetworkError.fromRequestError(reason),
    });
  return AiError.make({
    module: MODULE,
    method,
    reason: new AiError.UnknownError({ description: reason.message }),
  });
};

// =============================================================================
// Stream state machine
// =============================================================================
// Chat Completions streams text, reasoning and tool arguments as bare deltas.
// `@effect/ai` wants explicitly bracketed parts, so the brackets are opened on
// the first delta of a kind and closed when something else starts or the stream
// halts. Tool arguments arrive split across frames and can only be parsed once
// they are whole, which is why a tool call is emitted at the end and not as it
// is read.

type ToolAccumulator = { id: string; name: string; params: string };

type State = {
  text: boolean;
  reasoning: boolean;
  tools: Map<number, ToolAccumulator>;
  usage?: ChatEvent["usage"];
  reason?: Response.FinishReason;
};

const initialState = (): State => ({ text: false, reasoning: false, tools: new Map() });

const malformedOutput = (description: string) =>
  new AiError.AiError({
    module: MODULE,
    method: "streamText",
    reason: new AiError.InvalidOutputError({ description }),
  });

const TEXT_ID = "text-0";
const REASONING_ID = "reasoning-0";

const step = Effect.fnUntraced(function* (state: State, event: ChatEvent) {
  if (event.error)
    return yield* malformedOutput(
      `Provider reported an error: ${event.error.message ?? event.error.type ?? "unknown"}`,
    );

  const parts: Response.StreamPartEncoded[] = [];
  if (event.usage) state.usage = event.usage;

  const choice = event.choices?.[0];
  if (choice?.finish_reason) state.reason = finishReason(choice.finish_reason);
  const delta = choice?.delta;
  if (!delta) return parts;

  const thought = delta.reasoning_content ?? delta.reasoning;
  if (thought) {
    if (!state.reasoning) {
      state.reasoning = true;
      parts.push({ type: "reasoning-start", id: REASONING_ID });
    }
    parts.push({ type: "reasoning-delta", id: REASONING_ID, delta: thought });
  }

  const toolDeltas = delta.tool_calls ?? [];
  if (delta.content || toolDeltas.length > 0) closeReasoning(state, parts);

  if (delta.content) {
    if (!state.text) {
      state.text = true;
      parts.push({ type: "text-start", id: TEXT_ID });
    }
    parts.push({ type: "text-delta", id: TEXT_ID, delta: delta.content });
  }

  for (const call of toolDeltas) {
    const open = state.tools.get(call.index);
    if (open) {
      const params = call.function?.arguments ?? "";
      if (params) {
        open.params += params;
        parts.push({ type: "tool-params-delta", id: open.id, delta: params });
      }
      continue;
    }
    // The first frame for an index is the only one that carries identity.
    // Without it there is nothing to attribute the arguments to.
    if (!call.id || !call.function?.name)
      return yield* malformedOutput(
        `Tool call delta at index ${call.index} is missing an id or a name`,
      );
    const started: ToolAccumulator = {
      id: call.id,
      name: call.function.name,
      params: call.function.arguments ?? "",
    };
    state.tools.set(call.index, started);
    parts.push({ type: "tool-params-start", id: started.id, name: started.name });
    if (started.params)
      parts.push({ type: "tool-params-delta", id: started.id, delta: started.params });
  }
  return parts;
});

const finish = Effect.fnUntraced(function* (state: State) {
  const parts: Response.StreamPartEncoded[] = [];
  closeReasoning(state, parts);
  if (state.text) {
    state.text = false;
    parts.push({ type: "text-end", id: TEXT_ID });
  }
  for (const call of state.tools.values()) {
    parts.push({ type: "tool-params-end", id: call.id });
    parts.push({
      type: "tool-call",
      id: call.id,
      name: call.name,
      params: yield* Effect.try({
        try: () => (call.params === "" ? {} : Tool.unsafeSecureJsonParse(call.params)),
        catch: (cause) =>
          malformedOutput(
            `Failed to parse arguments for tool '${call.name}':\n${call.params}\n${String(cause)}`,
          ),
      }),
    });
  }
  // A model that asked for tools has not stopped, whatever it claims: the
  // turn continues once the results come back.
  const reason = state.tools.size > 0 ? "tool-calls" : (state.reason ?? "unknown");
  parts.push({ type: "finish", reason, usage: usage(state.usage) });
  return parts;
});

const closeReasoning = (state: State, parts: Response.StreamPartEncoded[]) => {
  if (!state.reasoning) return;
  state.reasoning = false;
  parts.push({ type: "reasoning-end", id: REASONING_ID });
};

const finishReason = (reason: string): Response.FinishReason =>
  reason === "stop"
    ? "stop"
    : reason === "length"
      ? "length"
      : reason === "content_filter"
        ? "content-filter"
        : reason === "tool_calls" || reason === "function_call"
          ? "tool-calls"
          : "unknown";

const usage = (reported: ChatEvent["usage"]): Usage => ({
  inputTokens: {
    total: reported?.prompt_tokens,
    cacheRead: reported?.prompt_tokens_details?.cached_tokens,
  },
  outputTokens: {
    total: reported?.completion_tokens,
    reasoning: reported?.completion_tokens_details?.reasoning_tokens,
  },
});

type Usage = {
  inputTokens: {
    uncached?: number;
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  outputTokens: {
    total?: number;
    text?: number;
    reasoning?: number;
  };
};

// =============================================================================
// Non-streaming result
// =============================================================================
// `generateText` is the stream, joined back up. The deltas of one bracketed run
// are concatenated into the single part the non-streaming contract expects.

const gather = (stream: ReadonlyArray<Response.StreamPartEncoded>): Response.PartEncoded[] => {
  const parts: Response.PartEncoded[] = [];
  const text = new Map<string, string>();
  const reasoning = new Map<string, string>();
  for (const part of stream) {
    if (part.type === "text-delta") text.set(part.id, (text.get(part.id) ?? "") + part.delta);
    else if (part.type === "reasoning-delta")
      reasoning.set(part.id, (reasoning.get(part.id) ?? "") + part.delta);
    else if (part.type === "reasoning-end")
      parts.push({ type: "reasoning", text: reasoning.get(part.id) ?? "" });
    else if (part.type === "text-end") parts.push({ type: "text", text: text.get(part.id) ?? "" });
    else if (part.type === "tool-call" || part.type === "finish") parts.push(part);
  }
  return parts;
};
