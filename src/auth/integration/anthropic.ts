import { FetchHttpClient } from "@effect/platform";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Layer, Redacted } from "effect";
import { HttpClientRequest } from "@effect/platform";
import type { Credential } from "../../credential.ts";
import type { Integration } from "./types.ts";

const key = (credential: Credential.Value) =>
  credential.type === "key" ? credential.key : credential.access;

export const anthropic: Integration = {
  id: "anthropic",
  label: "Anthropic",
  methods: [{ type: "key", label: "API key" }],
  env: ["ANTHROPIC_API_KEY"],
  model: ({ model, transformClient }) =>
    AnthropicLanguageModel.layer({ model }).pipe(
      Layer.provide(AnthropicClient.layer({ transformClient })),
      Layer.provide(FetchHttpClient.layer),
    ),
  authorize: (credential, request) =>
    HttpClientRequest.setHeader("x-api-key", Redacted.value(key(credential)))(request),
};
