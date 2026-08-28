import { expect, test } from "bun:test";
import { identifyAgent, splitActivity } from "./identify.ts";

test("agent CLIs are recognised by executable name, and nothing else is", () => {
  expect(identifyAgent("claude")).toBe("claude");
  expect(identifyAgent(["/home/x/.bun/bin/claude", "--resume"])).toBe("claude");
  expect(identifyAgent("node /x/codex.js")).toBe("codex");
  expect(identifyAgent("cursor-agent")).toBe("cursor");
  expect(identifyAgent("OpenCode")).toBe("opencode");
  expect(identifyAgent("nvim")).toBe(null);
  expect(identifyAgent("cargo build")).toBe(null);
});

test("agent activity glyphs are stripped without stripping ordinary symbols", () => {
  expect(splitActivity("⠋ building")).toEqual({ spinning: true, text: "building" });
  expect(splitActivity("✢ task")).toEqual({ spinning: true, text: "task" });
  expect(splitActivity("★ production")).toEqual({ spinning: false, text: "★ production" });
  expect(splitActivity("⠋ ⠙ task")).toEqual({ spinning: true, text: "⠙ task" });
});
