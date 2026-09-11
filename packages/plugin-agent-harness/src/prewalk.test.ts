import { expect, test } from "bun:test";
import { decidePrewalkHandoff, isMutatingTool, planPrewalk } from "./prewalk.ts";

test("isMutatingTool names write/edit/apply_patch only", () => {
  expect(isMutatingTool("write")).toBe(true);
  expect(isMutatingTool("edit")).toBe(true);
  expect(isMutatingTool("apply_patch")).toBe(true);
  expect(isMutatingTool("read")).toBe(false);
  expect(isMutatingTool("bash")).toBe(false);
});

test("planPrewalk arms explore when enabled, distinct, and available", () => {
  expect(
    planPrewalk({
      enabled: true,
      strongModel: "openai/gpt-4o",
      prewalkModel: "openai/gpt-4o-mini",
      exploreAvailable: true,
    }),
  ).toEqual({
    armed: true,
    exploreModel: "openai/gpt-4o-mini",
    strongModel: "openai/gpt-4o",
  });
});

test("planPrewalk skips when disabled, same model, missing, or unavailable", () => {
  expect(
    planPrewalk({
      enabled: false,
      strongModel: "openai/gpt-4o",
      prewalkModel: "openai/gpt-4o-mini",
      exploreAvailable: true,
    }),
  ).toMatchObject({ armed: false, reason: "disabled", model: "openai/gpt-4o" });

  expect(
    planPrewalk({
      enabled: true,
      strongModel: "openai/gpt-4o",
      prewalkModel: "openai/gpt-4o",
      exploreAvailable: true,
    }),
  ).toMatchObject({ armed: false, reason: "same-model" });

  expect(
    planPrewalk({
      enabled: true,
      strongModel: "openai/gpt-4o",
      prewalkModel: "",
      exploreAvailable: true,
    }),
  ).toMatchObject({ armed: false, reason: "missing-target" });

  expect(
    planPrewalk({
      enabled: true,
      strongModel: "openai/gpt-4o",
      prewalkModel: "openai/gpt-4o-mini",
      exploreAvailable: false,
    }),
  ).toMatchObject({ armed: false, reason: "unavailable", model: "openai/gpt-4o" });
});

test("decidePrewalkHandoff switches once after a successful mutating tool", () => {
  const base = {
    armed: true,
    handedOff: false,
    exploreModel: "openai/mini",
    strongModel: "openai/strong",
  };
  expect(decidePrewalkHandoff({ ...base, tool: "read", toolSucceeded: true })).toEqual({
    kind: "skip",
    reason: "not-mutating",
  });
  expect(decidePrewalkHandoff({ ...base, tool: "edit", toolSucceeded: false })).toEqual({
    kind: "skip",
    reason: "tool-failed",
  });
  expect(decidePrewalkHandoff({ ...base, tool: "write", toolSucceeded: true })).toEqual({
    kind: "handoff",
    from: "openai/mini",
    to: "openai/strong",
    tool: "write",
  });
  expect(
    decidePrewalkHandoff({
      ...base,
      handedOff: true,
      tool: "edit",
      toolSucceeded: true,
    }),
  ).toEqual({ kind: "skip", reason: "already-handed" });
  expect(
    decidePrewalkHandoff({
      ...base,
      armed: false,
      tool: "edit",
      toolSucceeded: true,
    }),
  ).toEqual({ kind: "skip", reason: "not-armed" });
});
