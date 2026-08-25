import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  DetectorEvaluator,
  evaluateAdapter,
  type Adapter,
  type DetectorResult,
} from "./detector-evaluator.ts";

const snapshot = (lines: readonly string[] = [], oscTitle = "") => ({
  lines,
  oscTitle,
  oscProgress: "",
});

test("rules compose predicates over their named region and highest priority wins", () => {
  const adapter: Adapter = {
    id: "test",
    rules: [
      {
        id: "low",
        state: "idle",
        priority: 1,
        region: "whole_recent",
        contains: ["ready"],
      },
      {
        id: "high",
        state: "blocked",
        priority: 2,
        region: "whole_recent",
        all: [{ line_regex: [{ pattern: "^choose" }] }],
        not: [{ contains: ["cancelled"] }],
      },
    ],
  };

  expect(evaluateAdapter(adapter, snapshot(["ready", "choose one"]))).toMatchObject({
    state: "blocked",
    rule: "high",
  });
  expect(evaluateAdapter(adapter, snapshot(["ready", "choose one", "cancelled"]))).toMatchObject({
    state: "idle",
    rule: "low",
  });
});

test("Claude's model picker suppresses a lower-priority blocked rule", () => {
  expect(
    DetectorEvaluator.core.evaluate(
      "claude",
      snapshot(["Select model", "Enter to set as default", "Esc to cancel", "❯ 1. Yes"]),
    ),
  ).toEqual({ state: "unknown", rule: "model_picker_menu", skipStateUpdate: true });
});

test("bundled adapters cover Claude and OpenCode", () => {
  expect(DetectorEvaluator.core.evaluate("claude", snapshot([], "⠋ thinking"))).toMatchObject({
    state: "running",
    rule: "osc_title_working",
  });
  expect(
    DetectorEvaluator.core.evaluate("opencode", snapshot(["Allow this command? [y/n]"])),
  ).toMatchObject({ state: "blocked" });
});

test("a supplied evaluator replaces the core evaluator", () => {
  const replacement: DetectorResult = {
    state: "running",
    rule: "replacement",
    skipStateUpdate: false,
  };
  const result = Effect.runSync(
    DetectorEvaluator.evaluate("claude", snapshot()).pipe(
      Effect.provideService(DetectorEvaluator, { evaluate: () => replacement }),
    ),
  );
  expect(result).toBe(replacement);
});
