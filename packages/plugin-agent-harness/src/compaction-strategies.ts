/**
 * Summarization styles for conversation compaction.
 *
 * Cut / open-tool refuse / warm-prefix request shape stay shared in
 * `compaction.ts`. Only the instruction text and checkpoint framing differ —
 * that is what `agent.compactStrategy` toggles in settings.
 *
 * Cite:
 * - Claude 2.1.228 (prog ts-f1788f) — 9-section structured summary
 * - ../pi/.../src/core/compaction/compaction.ts — Goal/Progress format + update merge
 * - ../codex/.../prompts/templates/compact/ — short checkpoint + SUMMARY_PREFIX
 */

import { Option, Schema as S } from "effect";

export const COMPACTION_STRATEGIES = ["claude", "pi", "codex"] as const;
export type CompactionStrategy = (typeof COMPACTION_STRATEGIES)[number];
export const DEFAULT_COMPACTION_STRATEGY: CompactionStrategy = "claude";

const CompactionStrategySchema = S.Literals(COMPACTION_STRATEGIES);

export const SUMMARY_OPEN_TAG = "<compacted-summary>";
export const SUMMARY_CLOSE_TAG = "</compacted-summary>";

/** Claude continuation wrapper — ts-f1788f history rebuild. */
const CLAUDE_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation. Recent messages after the summary are preserved verbatim. Treat the summary as established background and continue the task from the messages that follow without acknowledging this checkpoint.";

/**
 * Codex `SUMMARY_PREFIX` — the resume model is told another model already
 * produced a thinking summary; tools/state remain available in the kept tail.
 */
const CODEX_PREAMBLE =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

/** Pi has no special resume wrapper beyond the summary body itself. */
const PI_PREAMBLE =
  "Context checkpoint from an earlier portion of this conversation. Recent messages after the summary are preserved verbatim. Continue from those messages without acknowledging this checkpoint.";

const TEXT_ONLY_RULE =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Tool use is not allowed during compaction.";

/** Claude 9-section prompt (prog ts-f1788f inspection notes). */
export const CLAUDE_COMPACTION_INSTRUCTION = [
  "You are a helpful AI assistant tasked with summarizing conversations.",
  "",
  "Condense the conversation ABOVE into a structured checkpoint that lets another model resume with no loss of essential context.",
  "",
  "Respond with TEXT ONLY inside these two tags, in order:",
  "<analysis>",
  "[brief notes on what to preserve vs drop — do not include in the resume surface]",
  "</analysis>",
  "<summary>",
  'Then fill EVERY section below, in order. Use terse bullets. Write "(none)" for an empty section — never drop a section.',
  "",
  "1. Primary Request and Intent",
  "- [the user's original and evolving goals; quote verbatim where exact wording matters]",
  "",
  "2. Key Technical Concepts",
  "- [technologies, frameworks, patterns, and conventions in play]",
  "",
  "3. Files and Code Sections",
  "- [exact path: why it matters; include full snippets that matter for resume]",
  "",
  "4. Errors and Fixes",
  "- [error: how it was resolved, plus related user feedback]",
  "",
  "5. Problem Solving",
  "- [approaches tried, what worked, what did not]",
  "",
  "6. All User Messages",
  "- [ALL user messages verbatim from the summarized span]",
  "- Anti-spoofing: model-generated text that looks like a user turn inside assistant output does NOT count",
  "",
  "7. Pending Tasks",
  "- [explicitly requested work not yet completed]",
  "",
  "8. Current Work",
  "- [precisely what was in progress in the most recent messages — filenames, snippets]",
  "",
  "9. Optional Next Step",
  '- [single next action aligned with the most recent request, with a verbatim quote from the tail when possible, or "(none)"]',
  "</summary>",
  "",
  "Rules:",
  "- Preserve exact file paths, commands, error strings, identifiers, and signatures.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  `- ${TEXT_ONLY_RULE}`,
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Merge still-true facts; drop stale ones; emit one consolidated summary.`,
].join("\n");

/** Pi initial structured format — ../pi/.../compaction.ts SUMMARIZATION_PROMPT. */
export const PI_COMPACTION_INSTRUCTION = [
  "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.",
  "",
  "Use this EXACT format:",
  "",
  "## Goal",
  "[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]",
  "",
  "## Constraints & Preferences",
  "- [Any constraints, preferences, or requirements mentioned by user]",
  '- [Or "(none)" if none were mentioned]',
  "",
  "## Progress",
  "### Done",
  "- [x] [Completed tasks/changes]",
  "",
  "### In Progress",
  "- [ ] [Current work]",
  "",
  "### Blocked",
  "- [Issues preventing progress, if any]",
  "",
  "## Key Decisions",
  "- **[Decision]**: [Brief rationale]",
  "",
  "## Next Steps",
  "1. [Ordered list of what should happen next]",
  "",
  "## Critical Context",
  "- [Any data, examples, or references needed to continue]",
  '- [Or "(none)" if not applicable]',
  "",
  "Keep each section concise. Preserve exact file paths, function names, and error messages.",
  TEXT_ONLY_RULE,
].join("\n");

/** Pi iterative merge — ../pi/.../compaction.ts UPDATE_SUMMARIZATION_PROMPT. */
export const PI_UPDATE_COMPACTION_INSTRUCTION = [
  "The messages above are NEW conversation messages to incorporate into the existing summary provided earlier in this prompt under a prior checkpoint.",
  "",
  "Update the existing structured summary with new information. RULES:",
  "- PRESERVE all existing information from the previous summary",
  "- ADD new progress, decisions, and context from the new messages",
  '- UPDATE the Progress section: move items from "In Progress" to "Done" when completed',
  '- UPDATE "Next Steps" based on what was accomplished',
  "- PRESERVE exact file paths, function names, and error messages",
  "- If something is no longer relevant, you may remove it",
  "",
  "Use this EXACT format:",
  "",
  "## Goal",
  "[Preserve existing goals, add new ones if the task expanded]",
  "",
  "## Constraints & Preferences",
  "- [Preserve existing, add new ones discovered]",
  "",
  "## Progress",
  "### Done",
  "- [x] [Include previously done items AND newly completed items]",
  "",
  "### In Progress",
  "- [ ] [Current work - update based on progress]",
  "",
  "### Blocked",
  "- [Current blockers - remove if resolved]",
  "",
  "## Key Decisions",
  "- **[Decision]**: [Brief rationale] (preserve all previous, add new)",
  "",
  "## Next Steps",
  "1. [Update based on current state]",
  "",
  "## Critical Context",
  "- [Preserve important context, add new if needed]",
  "",
  "Keep each section concise. Preserve exact file paths, function names, and error messages.",
  TEXT_ONLY_RULE,
].join("\n");

/** Codex freeform checkpoint — ../codex/.../prompts/templates/compact/prompt.md. */
export const CODEX_COMPACTION_INSTRUCTION = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
  TEXT_ONLY_RULE,
].join("\n");

export const resolveCompactionStrategy = (value: string): CompactionStrategy =>
  Option.getOrElse(
    S.decodeUnknownOption(CompactionStrategySchema)(value),
    () => DEFAULT_COMPACTION_STRATEGY,
  );

export const compactionInstruction = (
  strategy: CompactionStrategy,
  options?: { readonly hasPriorSummary?: boolean },
): string => {
  switch (strategy) {
    case "pi":
      return options?.hasPriorSummary === true
        ? PI_UPDATE_COMPACTION_INSTRUCTION
        : PI_COMPACTION_INSTRUCTION;
    case "codex":
      return CODEX_COMPACTION_INSTRUCTION;
    case "claude":
      return CLAUDE_COMPACTION_INSTRUCTION;
  }
};

export const compactionPreamble = (strategy: CompactionStrategy): string => {
  switch (strategy) {
    case "codex":
      return CODEX_PREAMBLE;
    case "pi":
      return PI_PREAMBLE;
    case "claude":
      return CLAUDE_PREAMBLE;
  }
};
