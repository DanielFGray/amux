import { ProcessState, type SessionFact } from "@danielfgray/amux";
import type { AttachFrame, Topic } from "@danielfgray/amux/protocol";
import { evaluateAgent } from "./detector.ts";
import { identifyAgent } from "./identify.ts";
import { agentIdentityFromTopic } from "./identity-state.ts";

export type PresenceSource = "harness" | "hook" | "manifest" | "unknown";

/**
 * Awareness's own lifecycle vocabulary. Distinct from core's `ProcessState`
 * so this plugin can present states core has no opinion on, but always
 * derived from `SessionFact.processState` — the arbiter's already-resolved
 * answer — never recomputed independently per tier.
 */
export type AwarenessReportedState = "idle" | "working" | "blocked" | "done";

const DETECTOR_TO_AWARENESS = {
  [ProcessState.Idle]: "idle",
  [ProcessState.Running]: "working",
  [ProcessState.Blocked]: "blocked",
  [ProcessState.Done]: "done",
} satisfies Record<ProcessState, AwarenessReportedState>;

/**
 * The one record answering "what agent is this pane, and how sure are we":
 * `agent` always comes from the tier named by `source`, so `evidence`
 * explains the whole identity claim. `state` is a straight readback of
 * `SessionFact.processState` — the `ProcessStateArbiter`'s own resolution —
 * so it is never a second opinion alongside core's.
 */
export interface AgentPresence {
  readonly session: string;
  readonly agent: string | null;
  readonly state: AwarenessReportedState | "unknown";
  readonly source: PresenceSource;
  readonly evidence: string | null;
}

/**
 * declaredAgent > hook > manifest guess: the one identity fallback chain
 * both a Detector-authority state source and `resolvePresence` need, so
 * a session's manifest evaluation and its displayed identity never disagree
 * about which agent they are looking at.
 */
export function resolveAgentId(fact: SessionFact, hookAgent: string | undefined): string | null {
  return (
    fact.declaredAgent ??
    hookAgent ??
    identifyAgent(fact.command) ??
    identifyAgent(fact.foreground?.argv ?? []) ??
    null
  );
}

/**
 * Arbitrates identity across sources ranked harness registration (the
 * session's own declared agent, set at spawn) over a hook self-report over a
 * manifest heuristic match against the screen — the same order in which each
 * source's confidence in what it is reporting decreases.
 */
export function resolvePresence(
  session: string,
  fact: SessionFact,
  hookAgent: string | undefined,
): AgentPresence {
  const state: AwarenessReportedState | "unknown" =
    fact.processState === null ? "unknown" : DETECTOR_TO_AWARENESS[fact.processState];
  const agent = resolveAgentId(fact, hookAgent);
  if (!agent) return { session, agent: null, state: "unknown", source: "unknown", evidence: null };
  if (fact.declaredAgent) {
    return { session, agent, state, source: "harness", evidence: `declaredAgent:${agent}` };
  }
  if (hookAgent) {
    return { session, agent, state, source: "hook", evidence: `hook:${agent}` };
  }
  const rule = evaluateAgent(agent, fact.regions).rule;
  return {
    session,
    agent,
    state,
    source: "manifest",
    evidence: rule ? `manifest-rule:${rule}` : `manifest:${agent}`,
  };
}

/** Extracts a hook's identity claim from a raw wire frame, for callers
 *  folding `SessionStreamTag.frames(session)` into per-session hook state. */
export function hookAgentFromFrame(frame: AttachFrame): string | undefined {
  if (frame._tag !== "topic") return undefined;
  return agentIdentityFromTopic(frame as Topic)?.agent;
}
