/**
 * Prefix-preserving conversation compaction for the native harness.
 *
 * Cite:
 * - ../deepseek-harness/.../compaction-basic/src/summarizer.ts — instruction as
 *   final user message so the warm system/tools/prefix stays cacheable; checkpoint framing
 * - ../pi/.../docs/compaction.md — keepRecentTokens cut
 * - ../codex/.../compact.rs — refuse open tool pairs; approx token estimate; summary as user msg
 * - prog ts-f1788f — Claude auto/manual paths; strategy prompts in compaction-strategies.ts
 *
 * History mutation is worker-owned (`Chat.history` Ref). Summarization uses
 * `LanguageModel.generateText` with `toolChoice: "none"` — never `Chat.generateText`,
 * which would append the summary call into the live conversation.
 */
import { LanguageModel, Prompt } from "effect/unstable/ai";
import { Effect, Ref } from "effect";
import {
  DEFAULT_COMPACTION_STRATEGY,
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  compactionInstruction,
  compactionPreamble,
  type CompactionStrategy,
} from "./compaction-strategies.ts";

export {
  CLAUDE_COMPACTION_INSTRUCTION,
  CODEX_COMPACTION_INSTRUCTION,
  COMPACTION_STRATEGIES,
  DEFAULT_COMPACTION_STRATEGY,
  PI_COMPACTION_INSTRUCTION,
  PI_UPDATE_COMPACTION_INSTRUCTION,
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  compactionInstruction,
  resolveCompactionStrategy,
  type CompactionStrategy,
} from "./compaction-strategies.ts";

export const COMPACTION_TOPIC = "agent-harness/compaction";

/** Default keep-recent budget — Pi docs/compaction.md keepRecentTokens. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/** Default auto-compact trigger as a percent of catalog `limit.context`. */
export const DEFAULT_AUTO_COMPACT_AT_PERCENT = 85;

export type CompactionPolicy = {
  readonly auto: boolean;
  /** Percent of model context window (50–99) that triggers auto-compact. */
  readonly atPercent: number;
  readonly keepRecentTokens: number;
  /** Catalog `Model.limit.context`. Absent → auto-compact cannot fire. */
  readonly contextLimit?: number;
  /** Summarization style — settings `agent.compactStrategy`. */
  readonly strategy: CompactionStrategy;
};

export type CompactOutcome =
  | {
      readonly _tag: "compacted";
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly summarizedMessages: number;
      readonly keptMessages: number;
      readonly strategy: CompactionStrategy;
    }
  | { readonly _tag: "noop"; readonly reason: "nothing-to-summarize" | "below-threshold" }
  | { readonly _tag: "refused"; readonly reason: "open-tool-calls" | "empty-summary" };

/** Rough token estimate — Codex `approx_token_count` posture (chars/4). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const estimatePromptTokens = (prompt: Prompt.Prompt): number => {
  let total = 0;
  for (const message of prompt.content) {
    total += estimateMessageTokens(message);
  }
  return total;
};

const estimateMessageTokens = (message: Prompt.Message): number => {
  if (typeof message.content === "string") return estimateTokens(message.content);
  let total = 0;
  for (const part of message.content) {
    total += estimatePartTokens(part);
  }
  return total;
};

const estimatePartTokens = (part: Prompt.Part): number => {
  switch (part.type) {
    case "text":
    case "reasoning":
      return estimateTokens(part.text);
    case "tool-call":
      return estimateTokens(part.name) + estimateTokens(JSON.stringify(part.params ?? {}));
    case "tool-result":
      return estimateTokens(part.name) + estimateTokens(JSON.stringify(part.result ?? {}));
    default:
      return 8;
  }
};

const messageText = (message: Prompt.Message): string => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

/** Last framed checkpoint body in the span, if any — drives Pi's update prompt. */
export const extractPriorSummary = (messages: readonly Prompt.Message[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messageText(messages[i]!);
    const open = text.lastIndexOf(SUMMARY_OPEN_TAG);
    if (open < 0) continue;
    const close = text.indexOf(SUMMARY_CLOSE_TAG, open);
    if (close < 0) continue;
    const body = text.slice(open + SUMMARY_OPEN_TAG.length, close).trim();
    if (body.length > 0) return body;
  }
  return undefined;
};

/** True when any tool-call lacks a matching tool-result (Codex refuse path). */
export const hasOpenToolCalls = (prompt: Prompt.Prompt): boolean => {
  const answered = new Set<string>();
  const open = new Set<string>();
  for (const message of prompt.content) {
    if (message.role !== "assistant" && message.role !== "tool") continue;
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") open.add(part.id);
      if (part.type === "tool-result") answered.add(part.id);
    }
  }
  for (const id of answered) open.delete(id);
  return open.size > 0;
};

export const shouldAutoCompact = (
  tokens: number,
  policy: CompactionPolicy,
): boolean => {
  if (!policy.auto) return false;
  if (policy.contextLimit === undefined || policy.contextLimit <= 0) return false;
  const threshold = Math.floor((policy.contextLimit * policy.atPercent) / 100);
  return tokens >= threshold;
};

/**
 * Split history into preserved system prefix, region to summarize, and recent tail.
 * Cut snaps to a user-message turn boundary when possible (Pi turn cut).
 */
export const splitForCompaction = (
  prompt: Prompt.Prompt,
  keepRecentTokens: number,
): {
  readonly system: readonly Prompt.Message[];
  readonly toSummarize: readonly Prompt.Message[];
  readonly keep: readonly Prompt.Message[];
} => {
  const system: Prompt.Message[] = [];
  const rest: Prompt.Message[] = [];
  for (const message of prompt.content) {
    if (message.role === "system" && system.length === rest.length) {
      // Only leading system messages are the immutable prefix.
      if (rest.length === 0) system.push(message);
      else rest.push(message);
    } else {
      rest.push(message);
    }
  }

  if (rest.length === 0) {
    return { system, toSummarize: [], keep: [] };
  }

  let tokens = 0;
  let cut = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    tokens += estimateMessageTokens(rest[i]!);
    if (tokens >= keepRecentTokens) {
      cut = i;
      break;
    }
  }
  // Everything fits in the keep budget — nothing to summarize.
  if (tokens < keepRecentTokens) {
    return { system, toSummarize: [], keep: rest };
  }

  // Snap forward to a user turn start when the cut landed mid-turn.
  let firstKept = cut;
  for (let j = cut; j < rest.length; j++) {
    if (rest[j]!.role === "user") {
      firstKept = j;
      break;
    }
  }
  // Avoid splitting an assistant tool-call from its later tool-result: if the
  // keep region starts on a tool message, pull back to the preceding assistant.
  while (firstKept > 0 && rest[firstKept]!.role === "tool") {
    firstKept -= 1;
  }

  return {
    system,
    toSummarize: rest.slice(0, firstKept),
    keep: rest.slice(firstKept),
  };
};

export const frameSummary = (
  summary: string,
  extraInstructions?: string,
  strategy: CompactionStrategy = DEFAULT_COMPACTION_STRATEGY,
): string => {
  const focus =
    extraInstructions !== undefined && extraInstructions.trim() !== ""
      ? `\n\nAdditional focus for this checkpoint:\n${extraInstructions.trim()}`
      : "";
  return `${compactionPreamble(strategy)}${focus}\n\n${SUMMARY_OPEN_TAG}\n${summary.trim()}\n${SUMMARY_CLOSE_TAG}`;
};

export const buildSummarizationPrompt = (
  system: readonly Prompt.Message[],
  toSummarize: readonly Prompt.Message[],
  extraInstructions?: string,
  strategy: CompactionStrategy = DEFAULT_COMPACTION_STRATEGY,
): Prompt.Prompt => {
  const prior = extractPriorSummary(toSummarize);
  const base = compactionInstruction(strategy, { hasPriorSummary: prior !== undefined });
  const instruction =
    extraInstructions !== undefined && extraInstructions.trim() !== ""
      ? `${base}\n\nAdditional instructions from the user:\n${extraInstructions.trim()}`
      : base;
  return Prompt.make([
    ...system,
    ...toSummarize,
    Prompt.makeMessage("user", {
      content: [Prompt.makePart("text", { text: instruction })],
    }),
  ]);
};

export const rebuildAfterCompaction = (
  system: readonly Prompt.Message[],
  summaryText: string,
  keep: readonly Prompt.Message[],
  extraInstructions?: string,
  strategy: CompactionStrategy = DEFAULT_COMPACTION_STRATEGY,
): Prompt.Prompt =>
  Prompt.make([
    ...system,
    Prompt.makeMessage("user", {
      content: [Prompt.makePart("text", { text: frameSummary(summaryText, extraInstructions, strategy) })],
    }),
    ...keep,
  ]);

/**
 * Run one compaction against `chat.history`. Does not append via Chat —
 * uses LanguageModel.generateText with toolChoice none.
 */
export const compactChatHistory = (options: {
  readonly history: Ref.Ref<Prompt.Prompt>;
  readonly policy: CompactionPolicy;
  readonly instructions?: string;
  /** When true, skip the auto threshold check (manual /compact). */
  readonly force?: boolean;
}): Effect.Effect<CompactOutcome, never, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(options.history);
    if (hasOpenToolCalls(current)) {
      return { _tag: "refused", reason: "open-tool-calls" } as const;
    }

    const tokensBefore = estimatePromptTokens(current);
    if (!options.force && !shouldAutoCompact(tokensBefore, options.policy)) {
      return { _tag: "noop", reason: "below-threshold" } as const;
    }

    const { system, toSummarize, keep } = splitForCompaction(
      current,
      options.policy.keepRecentTokens,
    );
    if (toSummarize.length === 0) {
      return { _tag: "noop", reason: "nothing-to-summarize" } as const;
    }

    const strategy = options.policy.strategy;
    const request = buildSummarizationPrompt(
      system,
      toSummarize,
      options.instructions,
      strategy,
    );
    const response = yield* LanguageModel.generateText({
      prompt: request,
      toolChoice: "none",
    }).pipe(Effect.orElseSucceed(() => ({ text: "" } as { readonly text: string })));

    const summary = response.text?.trim() ?? "";
    if (summary === "") {
      return { _tag: "refused", reason: "empty-summary" } as const;
    }

    const next = rebuildAfterCompaction(
      system,
      summary,
      keep,
      options.instructions,
      strategy,
    );
    yield* Ref.set(options.history, next);
    return {
      _tag: "compacted",
      tokensBefore,
      tokensAfter: estimatePromptTokens(next),
      summarizedMessages: toSummarize.length,
      keptMessages: keep.length,
      strategy,
    } as const;
  });
