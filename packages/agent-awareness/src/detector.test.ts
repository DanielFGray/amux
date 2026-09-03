import { expect, test } from "bun:test";
import { evaluateAdapter, evaluateAgent, type Adapter } from "./detector.ts";

test("rules compose over named fact regions and highest priority wins", () => {
  const adapter: Adapter = {
    id: "test",
    rules: [
      { id: "low", state: "idle", priority: 1, region: "whole_recent", contains: ["ready"] },
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
  expect(evaluateAdapter(adapter, { whole_recent: "ready\nchoose one" })).toMatchObject({
    state: "blocked",
    rule: "high",
  });
  expect(evaluateAdapter(adapter, { whole_recent: "ready\nchoose one\ncancelled" })).toMatchObject({
    state: "idle",
    rule: "low",
  });
});

test("bundled adapters preserve picker suppression and prompt detection", () => {
  expect(
    evaluateAgent("claude", {
      whole_recent: "Select model\nEnter to set as default\nEsc to cancel\n❯ 1. Yes",
    }),
  ).toEqual({ state: "unknown", rule: "model_picker_menu", skipStateUpdate: true });
  expect(
    evaluateAgent("opencode", { whole_recent: "△ Permission required\nesc dismiss" }),
  ).toMatchObject({ state: "blocked" });
  expect(evaluateAgent("claude", { osc_title: "⠋ thinking" })).toMatchObject({ state: "running" });
});

test("claude's working spinner and idle marker are distinct osc_title rules", () => {
  expect(evaluateAgent("claude", { osc_title: "⠋ thinking" })).toMatchObject({
    state: "running",
    rule: "osc_title_working",
  });
  expect(evaluateAgent("claude", { osc_title: "✳ done" })).toMatchObject({
    state: "idle",
    rule: "osc_title_idle",
  });
});

test("codex distinguishes action-required, spinner, and plain idle titles", () => {
  expect(evaluateAgent("codex", { osc_title: "Action Required" })).toMatchObject({
    state: "blocked",
    rule: "osc_title_blocked",
  });
  expect(evaluateAgent("codex", { osc_title: "⠋ working" })).toMatchObject({
    state: "running",
    rule: "osc_title_working",
  });
  expect(evaluateAgent("codex", { osc_title: "my-project" })).toMatchObject({
    state: "idle",
    rule: "osc_title_idle",
  });
});

test("copilot detects a cancel-hinted working state and a selection blocker", () => {
  expect(
    evaluateAgent("copilot", { whole_recent: "Generating suggestion...\nesc to cancel" }),
  ).toMatchObject({ state: "running", rule: "working_cancel_hint" });
  expect(
    evaluateAgent("copilot", { whole_recent: "Pick a suggestion\nenter to select\nesc to cancel" }),
  ).toMatchObject({ state: "blocked", rule: "selection_blocker" });
});
