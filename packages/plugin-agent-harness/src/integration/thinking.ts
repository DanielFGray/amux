import { Match } from "effect";

export type AnthropicThinkingConfig =
  | { readonly thinking: { readonly type: "disabled" | "adaptive" } }
  | {
      readonly thinking: {
        readonly type: "enabled";
        readonly budget_tokens: number;
      };
    }
  | { readonly output_config: { readonly effort: string } };

/**
 * Map a clamped catalog thinking level (+ optional token budget) onto Anthropic
 * Messages config.
 *
 * Precedence: off/none → disabled; a supplied budget → enabled+budget_tokens
 * (catalog `budget_tokens`, Anthropic ThinkingConfigEnabled); on → adaptive;
 * otherwise effort strings use `output_config.effort` (Generated EffortLevel
 * includes max; catalog may also advertise xhigh).
 */
export const anthropicThinkingConfig = (
  thinking: string | undefined,
  budgetTokens?: number,
): AnthropicThinkingConfig | undefined => {
  if (thinking === "off" || thinking === "none") {
    return { thinking: { type: "disabled" } };
  }
  if (budgetTokens !== undefined) {
    return { thinking: { type: "enabled", budget_tokens: budgetTokens } };
  }
  return Match.value(thinking).pipe(
    Match.when(undefined, () => undefined),
    Match.when("on", (): AnthropicThinkingConfig => ({ thinking: { type: "adaptive" } })),
    Match.orElse((effort): AnthropicThinkingConfig => ({ output_config: { effort } })),
  );
};

export type OpenAiReasoningConfig = {
  readonly reasoning: {
    readonly effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  };
};

/** OpenAI Responses `reasoning.effort` literals the SDK accepts. */
const OPENAI_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const openAiReasoningConfig = (
  thinking: string | undefined,
): OpenAiReasoningConfig | undefined => {
  if (thinking === undefined) return undefined;
  if (thinking === "off") return { reasoning: { effort: "none" } };
  if (thinking === "on") return undefined;
  if (!OPENAI_EFFORTS.has(thinking)) return undefined;
  return {
    reasoning: {
      effort: thinking as OpenAiReasoningConfig["reasoning"]["effort"],
    },
  };
};

/** Chat Completions `reasoning_effort` — omit when unset or toggle-on. */
export const chatReasoningEffort = (thinking: string | undefined): string | undefined => {
  if (thinking === undefined || thinking === "on") return undefined;
  if (thinking === "off") return "none";
  return thinking;
};
