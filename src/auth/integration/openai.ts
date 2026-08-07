import { FetchHttpClient } from "@effect/platform";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Layer, Redacted } from "effect";
import type { Credential } from "../../credential.ts";
import type { Integration } from "./types.ts";

const key = (credential: Credential.Value) =>
  credential.type === "key" ? credential.key : credential.access;

export const openai: Integration = {
  id: "openai",
  label: "OpenAI",
  methods: [
    { type: "key", label: "API key" },
    { type: "env", names: ["OPENAI_API_KEY"] },
  ],
  model: (credential, model) =>
    OpenAiLanguageModel.layer({ model }).pipe(
      Layer.provide(OpenAiClient.layer({ apiKey: Redacted.make(Redacted.value(key(credential))) })),
      Layer.provide(FetchHttpClient.layer),
    ),
};
