import { expect, test } from "bun:test";
import { Prompt } from "effect/unstable/ai";
import {
  CLAUDE_COMPACTION_INSTRUCTION,
  CODEX_COMPACTION_INSTRUCTION,
  DEFAULT_AUTO_COMPACT_AT_PERCENT,
  DEFAULT_COMPACTION_STRATEGY,
  DEFAULT_KEEP_RECENT_TOKENS,
  PI_COMPACTION_INSTRUCTION,
  PI_UPDATE_COMPACTION_INSTRUCTION,
  buildSummarizationPrompt,
  compactionInstruction,
  estimatePromptTokens,
  extractPriorSummary,
  frameSummary,
  hasOpenToolCalls,
  rebuildAfterCompaction,
  shouldAutoCompact,
  splitForCompaction,
} from "./compaction.ts";
import { AGENT_HARNESS_OPTIONS, COMPACTION_STRATEGIES } from "./options.ts";
import { coerceOption } from "@danielfgray/amux";

const user = (text: string) =>
  Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] });
const assistant = (text: string) =>
  Prompt.makeMessage("assistant", { content: [Prompt.makePart("text", { text })] });
const system = (text: string) => Prompt.makeMessage("system", { content: text });

test("compaction options default to auto-on at 85% with a 20k keep-recent tail", () => {
  const auto = AGENT_HARNESS_OPTIONS["agent.autoCompact"];
  const at = AGENT_HARNESS_OPTIONS["agent.autoCompactAt"];
  const keep = AGENT_HARNESS_OPTIONS["agent.compactKeepRecent"];
  const strategy = AGENT_HARNESS_OPTIONS["agent.compactStrategy"];
  expect(coerceOption(auto, undefined) ?? auto.default).toBe(true);
  expect(coerceOption(at, undefined) ?? at.default).toBe(DEFAULT_AUTO_COMPACT_AT_PERCENT);
  expect(coerceOption(keep, undefined) ?? keep.default).toBe(DEFAULT_KEEP_RECENT_TOKENS);
  expect(strategy.kind).toBe("enum");
  expect(strategy.default).toBe(DEFAULT_COMPACTION_STRATEGY);
  expect(strategy.values).toEqual([...COMPACTION_STRATEGIES]);
  expect(coerceOption(strategy, "pi")).toBe("pi");
  expect(coerceOption(strategy, "nope")).toBeUndefined();
  expect(coerceOption(auto, false)).toBe(false);
  expect(coerceOption(at, 40)).toBe(50); // clamped to min
});

test("shouldAutoCompact respects disable and missing context limit", () => {
  expect(
    shouldAutoCompact(100_000, {
      auto: false,
      atPercent: 85,
      keepRecentTokens: 20_000,
      strategy: "claude",
      contextLimit: 100_000,
    }),
  ).toBe(false);
  expect(
    shouldAutoCompact(100_000, {
      auto: true,
      atPercent: 85,
      keepRecentTokens: 20_000,
      strategy: "claude",
    }),
  ).toBe(false);
  expect(
    shouldAutoCompact(85_000, {
      auto: true,
      atPercent: 85,
      keepRecentTokens: 20_000,
      strategy: "claude",
      contextLimit: 100_000,
    }),
  ).toBe(true);
  expect(
    shouldAutoCompact(84_000, {
      auto: true,
      atPercent: 85,
      keepRecentTokens: 20_000,
      strategy: "claude",
      contextLimit: 100_000,
    }),
  ).toBe(false);
});

test("hasOpenToolCalls detects unpaired tool-calls", () => {
  const open = Prompt.make([
    system("sys"),
    user("do it"),
    Prompt.makeMessage("assistant", {
      content: [
        Prompt.makePart("tool-call", {
          id: "c1",
          name: "bash",
          params: { command: "ls" },
          providerExecuted: false,
        }),
      ],
    }),
  ]);
  expect(hasOpenToolCalls(open)).toBe(true);

  const closed = Prompt.make([
    ...open.content,
    Prompt.makeMessage("tool", {
      content: [
        Prompt.makePart("tool-result", {
          id: "c1",
          name: "bash",
          isFailure: false,
          result: "ok",
          providerExecuted: false,
        }),
      ],
    }),
  ]);
  expect(hasOpenToolCalls(closed)).toBe(false);
});

test("splitForCompaction keeps the system prefix and a recent tail", () => {
  // Inflate messages so keepRecent is exceeded.
  const blob = "x".repeat(4_000); // ~1000 tokens each
  const prompt = Prompt.make([
    system("immutable"),
    user(`old-1 ${blob}`),
    assistant(`old-a ${blob}`),
    user(`old-2 ${blob}`),
    assistant(`old-b ${blob}`),
    user("recent user"),
    assistant("recent assistant"),
  ]);
  const split = splitForCompaction(prompt, 500);
  expect(split.system).toHaveLength(1);
  expect(split.system[0]!.role).toBe("system");
  expect(split.toSummarize.length).toBeGreaterThan(0);
  expect(split.keep.length).toBeGreaterThan(0);
  expect(split.keep.some((m) => m.role === "user")).toBe(true);
  // System is not re-summarized.
  expect(split.toSummarize.every((m) => m.role !== "system")).toBe(true);
});

test("splitForCompaction is a noop when everything fits in keepRecent", () => {
  const prompt = Prompt.make([system("sys"), user("hi"), assistant("hello")]);
  const split = splitForCompaction(prompt, 50_000);
  expect(split.toSummarize).toEqual([]);
  expect(split.keep).toHaveLength(2);
});

test("buildSummarizationPrompt appends the strategy instruction as the final user message", () => {
  const systemMsgs = [system("sys")];
  const region = [user("a"), assistant("b")];
  const request = buildSummarizationPrompt(systemMsgs, region, undefined, "claude");
  expect(request.content[0]!.role).toBe("system");
  expect(request.content.at(-1)!.role).toBe("user");
  const last = request.content.at(-1)!;
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  expect(text).toContain(CLAUDE_COMPACTION_INSTRUCTION.slice(0, 40));
  expect(text).toContain("Primary Request and Intent");

  const pi = buildSummarizationPrompt(systemMsgs, region, undefined, "pi");
  const piLast = pi.content.at(-1)!;
  const piText =
    typeof piLast.content === "string"
      ? piLast.content
      : piLast.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  expect(piText).toContain("## Goal");
  expect(piText).toContain(PI_COMPACTION_INSTRUCTION.slice(0, 40));

  const codex = buildSummarizationPrompt(systemMsgs, region, undefined, "codex");
  const codexLast = codex.content.at(-1)!;
  const codexText =
    typeof codexLast.content === "string"
      ? codexLast.content
      : codexLast.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  expect(codexText).toContain("CONTEXT CHECKPOINT COMPACTION");
  expect(codexText).toContain(CODEX_COMPACTION_INSTRUCTION.slice(0, 40));
});

test("pi strategy switches to the update instruction when a prior checkpoint exists", () => {
  const prior = frameSummary("## Goal\nship it", undefined, "pi");
  expect(extractPriorSummary([user(prior)])).toContain("ship it");
  expect(compactionInstruction("pi", { hasPriorSummary: true })).toBe(
    PI_UPDATE_COMPACTION_INSTRUCTION,
  );
  const request = buildSummarizationPrompt(
    [system("sys")],
    [user(prior), user("new work"), assistant("ok")],
    undefined,
    "pi",
  );
  const last = request.content.at(-1)!;
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  expect(text).toContain("NEW conversation messages");
  expect(text).toContain(PI_UPDATE_COMPACTION_INSTRUCTION.slice(0, 40));
});

test("rebuildAfterCompaction frames the summary per strategy", () => {
  const next = rebuildAfterCompaction(
    [system("sys")],
    "## Primary Request\n- ship compaction",
    [user("recent"), assistant("ok")],
    undefined,
    "claude",
  );
  expect(next.content.map((m) => m.role)).toEqual(["system", "user", "user", "assistant"]);
  const checkpoint = next.content[1]!;
  const text =
    typeof checkpoint.content === "string"
      ? checkpoint.content
      : checkpoint.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  expect(text).toContain("<compacted-summary>");
  expect(text).toContain("ship compaction");
  expect(frameSummary("body", undefined, "claude")).toContain(
    "continued from a previous conversation",
  );
  expect(frameSummary("body", undefined, "codex")).toContain(
    "Another language model started to solve this problem",
  );
});

test("estimatePromptTokens grows with content", () => {
  const small = Prompt.make([user("hi")]);
  const large = Prompt.make([user("hi".repeat(1000))]);
  expect(estimatePromptTokens(large)).toBeGreaterThan(estimatePromptTokens(small));
});
