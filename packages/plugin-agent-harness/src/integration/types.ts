import type { LanguageModel } from "effect/unstable/ai";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { Effect, Layer } from "effect";
import type { Credential } from "../credential.ts";
import type { OAuthRefreshError } from "../credential.ts";
import type { OAuthError, OAuthFlowController } from "../oauth/types.ts";

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
      /**
       * Run the provider's OAuth dance. Auth tab / CLI supply the controller;
       * cancel is Scope interrupt (closes any loopback socket via finalizer).
       * `answers` carries values from `prompts` (e.g. mode=auto|paste).
       */
      readonly login: (
        ctl: OAuthFlowController,
        answers?: Readonly<Record<string, string>>,
      ) => Effect.Effect<Credential.OAuth, OAuthError>;
    };

export type Connection = {
  readonly type: "credential";
  readonly id: Credential.ID;
  readonly label: string;
};

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
  /**
   * The npm package the catalog names for this model, which is the catalog's
   * way of saying which wire protocol the model speaks.
   *
   * It is read per model, not per provider: a gateway serves many models and
   * the catalog states an override on the ones that do not speak the
   * provider's own protocol. Guessing it from the provider is how a
   * chat-completions model ends up being asked over `/responses`, which fails
   * silently — the frames simply do not decode.
   */
  readonly npm?: string;
  /**
   * Clamped thinking level from `agent.thinking`, or absent when the model has
   * no controllable effort / the option is empty (provider default).
   */
  readonly thinking?: string;
  /**
   * Clamped token budget from `agent.thinkingBudget` when the catalog lists
   * `budget_tokens`. Absent when 0 / model has no budget option.
   */
  readonly thinkingBudget?: number;
};

export type Integration = {
  readonly id: string;
  readonly label: string;
  readonly methods: readonly Method[];
  /**
   * The environment variable names this provider reads for a credential.
   *
   * The worker never reads these — it resolves credentials from the store —
   * but a provider key exported into the daemon's environment must not reach
   * the worker's `environ` (it would be readable there via /proc). The harness
   * unions its registered integrations' names and tells the daemon which
   * variables to strip from a worker's inherited environment.
   */
  readonly env: readonly string[];
  /**
   * Other catalog ids this integration answers to, besides `id`.
   *
   * OpenCode Zen and OpenCode Go take the same key but the model catalog
   * lists them as separate providers ("opencode" and "opencode-go") because
   * their hosts and model lists differ — a model reference still has to name
   * whichever one it means. `id` is where a *new* connection is stored;
   * `aliases` are read alongside it so one credential answers for both and a
   * key never has to be entered twice for the same account.
   */
  readonly aliases?: readonly string[];
  readonly refresh?: (
    credential: Credential.OAuth,
  ) => Effect.Effect<Credential.OAuth, OAuthRefreshError>;
  readonly model: (request: ModelRequest) => Layer.Layer<LanguageModel.LanguageModel, never, never>;
  readonly authorize: (
    credential: Credential.Value,
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest;
};
