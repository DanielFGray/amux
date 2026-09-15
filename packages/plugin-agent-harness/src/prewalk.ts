/**
 * Prewalk: start on a cheap explore model; hand off to the strong model at the
 * first mutating tool. OMP docs/prewalk.md — session-level one-shot switch.
 */

import { Schema as S } from "effect";

export const MUTATING_TOOLS = ["write", "edit", "apply_patch"] as const;

export type MutatingTool = (typeof MUTATING_TOOLS)[number];

export const isMutatingTool = (name: string): name is MutatingTool =>
  (MUTATING_TOOLS as readonly string[]).includes(name);

export type PrewalkArm = {
  readonly armed: true;
  readonly exploreModel: string;
  readonly strongModel: string;
};

export type PrewalkDisarmed = {
  readonly armed: false;
  readonly reason: "disabled" | "same-model" | "unavailable" | "missing-target";
  readonly model: string;
};

export type PrewalkPlan = PrewalkArm | PrewalkDisarmed;

/**
 * Decide whether the session starts in prewalk and which model is initial.
 * `exploreAvailable` is false when credentials/catalog cannot resolve prewalkModel.
 */
export const planPrewalk = (input: {
  readonly enabled: boolean;
  readonly strongModel: string;
  readonly prewalkModel: string;
  readonly exploreAvailable: boolean;
}): PrewalkPlan => {
  if (!input.enabled) {
    return { armed: false, reason: "disabled", model: input.strongModel };
  }
  if (input.prewalkModel.length === 0) {
    return { armed: false, reason: "missing-target", model: input.strongModel };
  }
  if (input.prewalkModel === input.strongModel) {
    return { armed: false, reason: "same-model", model: input.strongModel };
  }
  if (!input.exploreAvailable) {
    return { armed: false, reason: "unavailable", model: input.strongModel };
  }
  return {
    armed: true,
    exploreModel: input.prewalkModel,
    strongModel: input.strongModel,
  };
};

export type HandoffDecision =
  | { readonly kind: "handoff"; readonly from: string; readonly to: string; readonly tool: string }
  | {
      readonly kind: "skip";
      readonly reason: "not-armed" | "already-handed" | "not-mutating" | "tool-failed";
    };

/**
 * One-shot handoff after a successful mutating tool. Pure — caller updates arm state.
 */
export const decidePrewalkHandoff = (input: {
  readonly armed: boolean;
  readonly handedOff: boolean;
  readonly tool: string;
  readonly toolSucceeded: boolean;
  readonly exploreModel: string;
  readonly strongModel: string;
}): HandoffDecision => {
  if (!input.armed) return { kind: "skip", reason: "not-armed" };
  if (input.handedOff) return { kind: "skip", reason: "already-handed" };
  if (!isMutatingTool(input.tool)) return { kind: "skip", reason: "not-mutating" };
  if (!input.toolSucceeded) return { kind: "skip", reason: "tool-failed" };
  return {
    kind: "handoff",
    from: input.exploreModel,
    to: input.strongModel,
    tool: input.tool,
  };
};

/** Topic payload so transcript/UI can surface the switch without a new harness event tag. */
export const PREWALK_HANDOFF_TOPIC = "agent-harness/prewalk-handoff";

/** Owner schema for PREWALK_HANDOFF_TOPIC payloads. */
export const PrewalkHandoffPayloadSchema = S.Struct({
  from: S.String,
  to: S.String,
  tool: S.String,
});
export type PrewalkHandoffPayload = typeof PrewalkHandoffPayloadSchema.Type;
