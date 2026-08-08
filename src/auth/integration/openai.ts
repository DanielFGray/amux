import { FetchHttpClient } from "@effect/platform";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Layer, Redacted } from "effect";
import { HttpClientRequest } from "@effect/platform";
import type { Credential } from "../../credential.ts";
import type { Integration } from "./types.ts";

const key = (credential: Credential.Value) =>
  credential.type === "key" ? credential.key : credential.access;

export const openai: Integration = {
  id: "openai",
  label: "OpenAI",
  methods: [
    { type: "key", label: "API key" },
  ],
  model: (model, transformClient) =>
    OpenAiLanguageModel.layer({ model }).pipe(
      Layer.provide(OpenAiClient.layer({ transformClient })),
      Layer.provide(FetchHttpClient.layer),
    ),
  authorize: (credential, request) =>
    HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(key(credential))}`)(request),
};
