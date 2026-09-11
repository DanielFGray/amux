import { expect, test } from "bun:test";
import { Option } from "effect";
import { bundledRegistry } from "./manifests.ts";
import { identifyAgent, splitActivity } from "./identify.ts";

const registry = bundledRegistry();

test("agent CLIs are recognised by executable name, and nothing else is", () => {
  expect(identifyAgent(registry, "claude")).toEqual(Option.some("claude"));
  expect(identifyAgent(registry, ["/home/x/.bun/bin/claude", "--resume"])).toEqual(
    Option.some("claude"),
  );
  expect(identifyAgent(registry, "node /x/codex.js")).toEqual(Option.some("codex"));
  expect(identifyAgent(registry, "cursor-agent")).toEqual(Option.some("cursor"));
  expect(identifyAgent(registry, "OpenCode")).toEqual(Option.some("opencode"));
  expect(identifyAgent(registry, "nvim")).toEqual(Option.none());
  expect(identifyAgent(registry, "cargo build")).toEqual(Option.none());
});

test("agent activity glyphs are stripped without stripping ordinary symbols", () => {
  expect(splitActivity("⠋ building")).toEqual({ spinning: true, text: "building" });
  expect(splitActivity("✢ task")).toEqual({ spinning: true, text: "task" });
  expect(splitActivity("★ production")).toEqual({ spinning: false, text: "★ production" });
  expect(splitActivity("⠋ ⠙ task")).toEqual({ spinning: true, text: "⠙ task" });
});
