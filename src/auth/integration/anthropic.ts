import { FetchHttpClient } from "@effect/platform";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Layer, Redacted } from "effect";
import type { Credential } from "../../credential.ts";
import type { Integration } from "./types.ts";

const key = (credential: Credential.Value) =>
  credential.type === "key" ? credential.key : credential.access;

export const anthropic: Integration = {
  id: "anthropic",
  label: "Anthropic",
  methods: [
    { type: "key", label: "API key" },
    { type: "env", names: ["ANTHROPIC_API_KEY"] },
  ],
  model: (credential, model) =>
    AnthropicLanguageModel.layer({ model }).pipe(
      Layer.provide(
        AnthropicClient.layer({ apiKey: Redacted.make(Redacted.value(key(credential))) }),
      ),
      Layer.provide(FetchHttpClient.layer),
    ),
};
