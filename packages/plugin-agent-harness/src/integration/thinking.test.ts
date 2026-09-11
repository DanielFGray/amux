import { expect, test } from "bun:test";
import { anthropicThinkingConfig, chatReasoningEffort, openAiReasoningConfig } from "./thinking.ts";

test("anthropicThinkingConfig maps effort and toggle levels", () => {
  expect(anthropicThinkingConfig(undefined)).toBeUndefined();
  expect(anthropicThinkingConfig("off")).toEqual({ thinking: { type: "disabled" } });
  expect(anthropicThinkingConfig("none")).toEqual({ thinking: { type: "disabled" } });
  expect(anthropicThinkingConfig("on")).toEqual({ thinking: { type: "adaptive" } });
  expect(anthropicThinkingConfig("high")).toEqual({ output_config: { effort: "high" } });
  expect(anthropicThinkingConfig("max")).toEqual({ output_config: { effort: "max" } });
  expect(anthropicThinkingConfig("xhigh")).toEqual({ output_config: { effort: "xhigh" } });
});

test("anthropicThinkingConfig prefers budget_tokens over effort when supplied", () => {
  expect(anthropicThinkingConfig(undefined, 4096)).toEqual({
    thinking: { type: "enabled", budget_tokens: 4096 },
  });
  expect(anthropicThinkingConfig("high", 2048)).toEqual({
    thinking: { type: "enabled", budget_tokens: 2048 },
  });
  expect(anthropicThinkingConfig("on", 1024)).toEqual({
    thinking: { type: "enabled", budget_tokens: 1024 },
  });
  expect(anthropicThinkingConfig("off", 4096)).toEqual({ thinking: { type: "disabled" } });
});

test("openAiReasoningConfig maps effort levels onto Responses reasoning", () => {
  expect(openAiReasoningConfig(undefined)).toBeUndefined();
  expect(openAiReasoningConfig("on")).toBeUndefined();
  expect(openAiReasoningConfig("off")).toEqual({ reasoning: { effort: "none" } });
  expect(openAiReasoningConfig("minimal")).toEqual({ reasoning: { effort: "minimal" } });
});

test("chatReasoningEffort becomes reasoning_effort on Chat Completions", () => {
  expect(chatReasoningEffort(undefined)).toBeUndefined();
  expect(chatReasoningEffort("on")).toBeUndefined();
  expect(chatReasoningEffort("off")).toBe("none");
  expect(chatReasoningEffort("high")).toBe("high");
});
