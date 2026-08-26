import { expect, test } from "bun:test";
import { coerceOption } from "@danielfgray/amux/options.ts";
import { AGENT_HARNESS_OPTIONS, parseModelReference } from "./options.ts";

test("the native agent model is a provider/model config value", () => {
  const spec = AGENT_HARNESS_OPTIONS["agent.model"];
  expect(coerceOption(spec, undefined) ?? spec.default).toBe("openai/gpt-4o-mini");
  expect(coerceOption(spec, "anthropic/claude-sonnet")).toBe("anthropic/claude-sonnet");
  expect(coerceOption(spec, 42)).toBeUndefined();
});

test("model references split provider from model and reject incomplete values", () => {
  expect(parseModelReference("openai/gpt-4o-mini")).toEqual({
    providerID: "openai",
    modelID: "gpt-4o-mini",
  });
  expect(parseModelReference("openai/")).toBeUndefined();
  expect(parseModelReference("/gpt-4o-mini")).toBeUndefined();
});
