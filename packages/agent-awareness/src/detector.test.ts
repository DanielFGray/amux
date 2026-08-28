import { expect, test } from "bun:test";
import { evaluateAdapter, evaluateAgent, type Adapter } from "./detector.ts";

test("rules compose over named fact regions and highest priority wins", () => {
  const adapter: Adapter = { id: "test", rules: [
    { id: "low", state: "idle", priority: 1, region: "whole_recent", contains: ["ready"] },
    { id: "high", state: "blocked", priority: 2, region: "whole_recent", all: [{ line_regex: [{ pattern: "^choose" }] }], not: [{ contains: ["cancelled"] }] },
  ] };
  expect(evaluateAdapter(adapter, { whole_recent: "ready\nchoose one" })).toMatchObject({ state: "blocked", rule: "high" });
  expect(evaluateAdapter(adapter, { whole_recent: "ready\nchoose one\ncancelled" })).toMatchObject({ state: "idle", rule: "low" });
});

test("bundled adapters preserve picker suppression and prompt detection", () => {
  expect(evaluateAgent("claude", { whole_recent: "Select model\nEnter to set as default\nEsc to cancel\n❯ 1. Yes" }))
    .toEqual({ state: "unknown", rule: "model_picker_menu", skipStateUpdate: true });
  expect(evaluateAgent("opencode", { "bottom_lines(20)": "Allow this command? [y/n]" }))
    .toMatchObject({ state: "blocked" });
  expect(evaluateAgent("claude", { osc_title: "⠋ thinking" })).toMatchObject({ state: "running" });
});
