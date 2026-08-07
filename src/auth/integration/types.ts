import type { LanguageModel } from "@effect/ai";
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
  | { readonly type: "env"; readonly names: readonly string[] }
  | {
      readonly type: "oauth";
      readonly id: string;
      readonly label: string;
      readonly prompts?: readonly Prompt[];
    };

export type Connection =
  | { readonly type: "credential"; readonly id: Credential.ID; readonly label: string }
  | { readonly type: "env"; readonly name: string };

export type Integration = {
  readonly id: string;
  readonly label: string;
  readonly methods: readonly Method[];
  readonly refresh?: (
    credential: Credential.OAuth,
  ) => import("effect").Effect.Effect<Credential.OAuth, unknown>;
  readonly model: (
    credential: Credential.Value,
    model: string,
  ) => Layer.Layer<LanguageModel.LanguageModel, never, never>;
};
