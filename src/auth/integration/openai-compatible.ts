import { FetchHttpClient, HttpClientRequest } from "@effect/platform";
import { LanguageModel } from "@effect/ai";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Layer, Redacted } from "effect";
import type { Credential } from "../../credential.ts";
import * as OpenAiChat from "./openai-chat.ts";
import type { Integration, Method } from "./types.ts";

/**
 * A provider that speaks OpenAI's API.
 *
 * Most of them do. What actually distinguishes one is its name, where it lives
 * and how it wants to be asked — so those are the arguments, and everything
 * else is stated once here rather than copied into a file per vendor. OpenAI
 * itself is one of these; it simply has no URL to override.
 *
 * "OpenAI's API" is two protocols, not one. Native OpenAI serves Responses;
 * a gateway that is only OpenAI-*compatible* serves Chat Completions. They are
 * not interchangeable, and asking one over the other's frames yields an empty
 * turn rather than an error, so the protocol is read from the catalog per model
 * instead of guessed from the provider.
 */
export const openAiCompatible = (spec: {
  readonly id: string;
  readonly label: string;
  /** Defaults to a plain API key, which is what an OpenAI-compatible provider
   *  offers unless it has an OAuth flow of its own. */
  readonly methods?: readonly Method[];
  /** The environment variable this provider's CLI reads for a credential. */
  readonly env: string;
}): Integration => ({
  id: spec.id,
  label: spec.label,
  methods: spec.methods ?? [{ type: "key", label: "API key" }],
  env: [spec.env],
  model: ({ model, transformClient, apiUrl, npm }) => {
    const client = { transformClient, ...(apiUrl ? { apiUrl } : {}) };
    if (npm === RESPONSES)
      return OpenAiLanguageModel.layer({ model }).pipe(
        Layer.provide(OpenAiClient.layer(client)),
        Layer.provide(FetchHttpClient.layer),
      );
    if (npm === MESSAGES)
      return AnthropicLanguageModel.layer({ model }).pipe(
        Layer.provide(AnthropicClient.layer(client)),
        Layer.provide(FetchHttpClient.layer),
      );
    if (npm === undefined || npm === CHAT) return OpenAiChat.layer({ model, ...client });
    return Layer.effect(
      LanguageModel.LanguageModel,
      Effect.dieMessage(`unsupported model protocol '${npm}'`),
    );
  },
  authorize: (credential, request) =>
    HttpClientRequest.setHeader(
      "Authorization",
      `Bearer ${Redacted.value(key(credential))}`,
    )(request),
});

/**
 * The one npm package that means Responses rather than Chat Completions.
 *
 * Every other value the catalog carries — `@ai-sdk/openai-compatible`, a
 * vendor's own package, or nothing at all — describes a model reached over
 * `/chat/completions`, which is what a gateway serves for the models it
 * resells whoever originally built them.
 */
const RESPONSES = "@ai-sdk/openai";
const MESSAGES = "@ai-sdk/anthropic";
const CHAT = "@ai-sdk/openai-compatible";

const key = (credential: Credential.Value) =>
  credential.type === "key" ? credential.key : credential.access;
