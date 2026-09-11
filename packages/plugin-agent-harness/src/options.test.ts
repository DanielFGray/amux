import { expect, test } from "bun:test";
import { coerceOption } from "@danielfgray/amux";
import { AGENT_HARNESS_OPTIONS, APPROVAL_MODES, parseModelReference } from "./options.ts";

test("the native agent model is a provider/model config value", () => {
  const spec = AGENT_HARNESS_OPTIONS["agent.model"];
  expect(coerceOption(spec, undefined) ?? spec.default).toBe("openai/gpt-4o-mini");
  expect(coerceOption(spec, "anthropic/claude-sonnet")).toBe("anthropic/claude-sonnet");
  expect(coerceOption(spec, 42)).toBeUndefined();
});

test("prewalk options default off with an explore model slot", () => {
  const enabled = AGENT_HARNESS_OPTIONS["agent.prewalk"];
  const explore = AGENT_HARNESS_OPTIONS["agent.prewalkModel"];
  expect(coerceOption(enabled, undefined) ?? enabled.default).toBe(false);
  expect(coerceOption(explore, undefined) ?? explore.default).toBe("openai/gpt-4o-mini");
  expect(coerceOption(enabled, true)).toBe(true);
});

test("agent.thinking defaults to empty (provider default)", () => {
  const spec = AGENT_HARNESS_OPTIONS["agent.thinking"];
  expect(coerceOption(spec, undefined) ?? spec.default).toBe("");
  expect(coerceOption(spec, "high")).toBe("high");
});

test("agent.thinkingBudget defaults to 0 (omit on the wire)", () => {
  const spec = AGENT_HARNESS_OPTIONS["agent.thinkingBudget"];
  expect(spec.kind).toBe("number");
  expect(coerceOption(spec, undefined) ?? spec.default).toBe(0);
  expect(coerceOption(spec, 4096)).toBe(4096);
  expect(coerceOption(spec, -1)).toBe(0);
});

test("model references split provider from model and reject incomplete values", () => {
  expect(parseModelReference("openai/gpt-4o-mini")).toEqual({
    providerID: "openai",
    modelID: "gpt-4o-mini",
  });
  expect(parseModelReference("openai/")).toBeUndefined();
  expect(parseModelReference("/gpt-4o-mini")).toBeUndefined();
});

test("agent.approvalMode is a closed enum defaulting to always-ask", () => {
  const spec = AGENT_HARNESS_OPTIONS["agent.approvalMode"];
  expect(spec.kind).toBe("enum");
  expect(spec.default).toBe("always-ask");
  expect(spec.values).toEqual([...APPROVAL_MODES]);
  expect(coerceOption(spec, "yolo")).toBe("yolo");
  expect(coerceOption(spec, "nope")).toBeUndefined();
});

test("agent.bashInterceptor defaults on", () => {
  const spec = AGENT_HARNESS_OPTIONS["agent.bashInterceptor"];
  expect(spec.kind).toBe("boolean");
  expect(spec.default).toBe(true);
  expect(coerceOption(spec, false)).toBe(false);
});

test("compaction options: auto on, 85% trigger, 20k keep-recent, claude strategy", () => {
  const auto = AGENT_HARNESS_OPTIONS["agent.autoCompact"];
  const at = AGENT_HARNESS_OPTIONS["agent.autoCompactAt"];
  const keep = AGENT_HARNESS_OPTIONS["agent.compactKeepRecent"];
  const strategy = AGENT_HARNESS_OPTIONS["agent.compactStrategy"];
  expect(auto.kind).toBe("boolean");
  expect(auto.default).toBe(true);
  expect(at.kind).toBe("number");
  expect(at.default).toBe(85);
  expect(keep.kind).toBe("number");
  expect(keep.default).toBe(20_000);
  expect(strategy.kind).toBe("enum");
  expect(strategy.default).toBe("claude");
  expect(strategy.values).toEqual(["claude", "pi", "codex"]);
  expect(coerceOption(at, 40)).toBe(50);
  expect(coerceOption(auto, false)).toBe(false);
  expect(coerceOption(strategy, "codex")).toBe("codex");
});
