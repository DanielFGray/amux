import type { OptionSpec } from "@danielfgray/amux";
import {
  COMPACTION_STRATEGIES,
  DEFAULT_COMPACTION_STRATEGY,
} from "./compaction-strategies.ts";

/**
 * The native harness's own option declarations, registered through
 * `OptionsTag` — see agent-harness.tsx. Kept beside `parseModelReference`
 * because both are model policy this harness owns; core has no idea a model
 * exists.
 *
 * Approval modes absorb OMP docs/approval-mode.md. Default is `always-ask`
 * (not OMP's `yolo`): matches the gate's historical DEFAULT_RULES — auto-allow
 * reads, prompt on write/exec — so enabling tiers does not suddenly stop
 * asking. See prog log on ts-56d122.
 */
export const APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export { COMPACTION_STRATEGIES, DEFAULT_COMPACTION_STRATEGY };
export type { CompactionStrategy } from "./compaction-strategies.ts";

export const AGENT_HARNESS_OPTIONS = {
  "agent.model": {
    kind: "string",
    default: "openai/gpt-4o-mini",
    desc: "provider/model for native agents",
    editable: true,
  },
  "agent.prewalk": {
    kind: "boolean",
    default: false,
    desc: "start on agent.prewalkModel until the first write/edit/apply_patch, then hand off to agent.model",
  },
  "agent.prewalkModel": {
    kind: "string",
    default: "openai/gpt-4o-mini",
    desc: "provider/model used while prewalk is armed (explore phase)",
    editable: true,
  },
  "agent.showThinking": {
    kind: "boolean",
    default: false,
    desc: "show agent thinking traces",
  },
  "agent.thinking": {
    kind: "string",
    // Empty = provider default; picker writes a catalog level when the model
    // exposes effort/toggle options.
    default: "",
    desc: "thinking effort for native agents",
    editable: true,
  },
  /**
   * Catalog `budget_tokens` (Anthropic ThinkingConfigEnabled). 0 = omit /
   * provider default. Clamped to the model's catalog min/max in integration.ts.
   * Not the worker turn/cost policy budgets (ts-fce7ef).
   */
  "agent.thinkingBudget": {
    kind: "number",
    default: 0,
    min: 0,
    max: 200_000,
    desc: "thinking token budget when the model lists budget_tokens · 0 = provider default",
  },
  "agent.approvalMode": {
    kind: "enum",
    default: "always-ask",
    values: APPROVAL_MODES,
    desc: "when the permission gate asks: always-ask | write | yolo",
  },
  /**
   * OMP bash-tool-runtime.md § interception: when true, bash calls that are
   * clearly a dedicated-tool job fail with a message naming that tool — only
   * if it is in the active toolkit. Default on: steering misuse is the product
   * intent of absorbing the interceptor (ts-65e675); turn off to allow raw
   * cat/grep/find via bash.
   */
  "agent.bashInterceptor": {
    kind: "boolean",
    default: true,
    desc: "block bash when a dedicated tool should be used instead",
  },
  /**
   * Prefix-preserving compaction (ts-d7ecf2 / ts-f1788f). Auto fires when
   * estimated conversation tokens reach `agent.autoCompactAt` percent of the
   * model's catalog `limit.context`. Manual `/compact` always available.
   * `agent.compactStrategy` selects the summarization style; cut/rebuild stay
   * shared. Cite: Pi keepRecentTokens; Claude/Codex prompts — percent travels
   * across catalog models better than an absolute token limit.
   */
  "agent.autoCompact": {
    kind: "boolean",
    default: true,
    desc: "automatically compact when the conversation nears the model context window",
  },
  "agent.autoCompactAt": {
    kind: "number",
    default: 85,
    min: 50,
    max: 99,
    desc: "percent of model context window that triggers auto-compact",
  },
  "agent.compactKeepRecent": {
    kind: "number",
    default: 20_000,
    min: 1_000,
    max: 200_000,
    desc: "tokens of recent history kept verbatim after compaction",
  },
  "agent.compactStrategy": {
    kind: "enum",
    default: DEFAULT_COMPACTION_STRATEGY,
    values: COMPACTION_STRATEGIES,
    desc: "compaction summary style: claude | pi | codex",
  },
} as const satisfies Record<string, OptionSpec>;

export function parseModelReference(
  value: string,
): { readonly providerID: string; readonly modelID: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}
