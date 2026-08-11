import { FetchHttpClient, HttpClientRequest } from "@effect/platform";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Layer, Redacted } from "effect";
import type { Credential } from "../../credential.ts";
import type { Integration, Method } from "./types.ts";

/**
 * A provider that speaks OpenAI's chat-completions API.
 *
 * Most of them do. What actually distinguishes one is its name, where it lives
 * and how it wants to be asked — so those are the arguments, and everything
 * else is stated once here rather than copied into a file per vendor. OpenAI
 * itself is one of these; it simply has no URL to override.
 */
export const openAiCompatible = (spec: {
  readonly id: string;
  readonly label: string;
  /** Defaults to a plain API key, which is what an OpenAI-compatible provider
   *  offers unless it has an OAuth flow of its own. */
  readonly methods?: readonly Method[];
}): Integration => ({
  id: spec.id,
  label: spec.label,
  methods: spec.methods ?? [{ type: "key", label: "API key" }],
  model: ({ model, transformClient, apiUrl }) =>
    OpenAiLanguageModel.layer({ model }).pipe(
      // apiUrl is spread rather than passed as undefined: the client's own
      // default is the right answer when the catalog names no host, and an
      // explicit undefined would override it with nothing.
      Layer.provide(OpenAiClient.layer({ transformClient, ...(apiUrl ? { apiUrl } : {}) })),
      Layer.provide(FetchHttpClient.layer),
    ),
  authorize: (credential, request) =>
    HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(key(credential))}`)(
      request,
    ),
});

const key = (credential: Credential.Value) =>
  credential.type === "key" ? credential.key : credential.access;
