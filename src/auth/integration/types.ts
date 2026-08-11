import type { LanguageModel } from "@effect/ai";
import type { HttpClient } from "@effect/platform";
import type { HttpClientRequest } from "@effect/platform/HttpClientRequest";
import type { Layer } from "effect";
import type { Credential } from "../../credential.ts";

export type When = { readonly key: string; readonly op: "eq" | "neq"; readonly value: string };
export type Prompt =
  | {
      readonly type: "text";
      readonly key: string;
      readonly message: string;
      readonly placeholder?: string;
      readonly when?: When;
    }
  | {
      readonly type: "select";
      readonly key: string;
      readonly message: string;
      readonly options: readonly {
        readonly label: string;
        readonly value: string;
        readonly hint?: string;
      }[];
      readonly when?: When;
    };

export type Method =
  | { readonly type: "key"; readonly label?: string }
  | {
      readonly type: "oauth";
      readonly id: string;
      readonly label: string;
      readonly prompts?: readonly Prompt[];
    };

export type Connection =
  | { readonly type: "credential"; readonly id: Credential.ID; readonly label: string };

/** What an integration needs to build a language model. */
export type ModelRequest = {
  readonly model: string;
  /** Authorization, applied to every request the model makes. Built by
   *  integration.ts from this integration's own `authorize`. */
  readonly transformClient: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
  /**
   * Where the provider's API lives, as the model catalog states it.
   *
   * Absent for a provider whose SDK already points at the right host, which is
   * every first-party one. An OpenAI-compatible provider is otherwise nothing
   * but its URL, and the catalog we already fetch is where that URL is written
   * down — repeating it here would be a second copy free to drift.
   */
  readonly apiUrl?: string;
};

export type Integration = {
  readonly id: string;
  readonly label: string;
  readonly methods: readonly Method[];
  readonly refresh?: (
    credential: Credential.OAuth,
  ) => import("effect").Effect.Effect<Credential.OAuth, unknown>;
  readonly model: (request: ModelRequest) => Layer.Layer<LanguageModel.LanguageModel, never, never>;
  readonly authorize: (
    credential: Credential.Value,
    request: HttpClientRequest,
  ) => HttpClientRequest;
};
