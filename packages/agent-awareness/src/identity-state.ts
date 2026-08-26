import { Option, Schema as S } from "effect";
import type { Topic } from "@danielfgray/amux/effect/AttachProtocol.ts";

export * as IdentityState from "./identity-state.ts";

/**
 * The one topic name adapter hooks publish an agent's identity and lifecycle
 * state under. Core routes this as an opaque `Topic` payload and never
 * imports the schema below; the opencode hook asset hardcodes this same
 * string literal because it cannot import from the amux TypeScript sources,
 * so `identity-state.test.ts` cross-checks the two stay in sync.
 */
export const AGENT_AWARENESS_IDENTITY_TOPIC = "amux.agent-awareness/identity-state";

/**
 * Awareness's own lifecycle vocabulary for a reported agent. This mirrors
 * core's `process.state` states but is declared independently: awareness
 * must not import core's process-state vocabulary, so a hook's report is
 * validated here against a copy this plugin owns and can evolve on its own.
 */
export const AwarenessReportedState = S.Literal("idle", "working", "blocked", "failed", "done");
export type AwarenessReportedState = typeof AwarenessReportedState.Type;

/**
 * `agent` identifies which tracked agent this report is about, matching
 * AgentPresence identity rather than assuming the report came from a
 * particular vendor's integration — awareness arbitrates identity across
 * sources, so it must accept any string a hook names rather than a closed
 * enum core or this schema would need to keep current.
 */
export const AgentIdentityStateSchema = S.Struct({
  agent: S.NonEmptyString,
  state: AwarenessReportedState,
});
export type AgentIdentityState = typeof AgentIdentityStateSchema.Type;

const decodeAgentIdentityState = S.decodeUnknownOption(AgentIdentityStateSchema);

export const agentIdentityStateFromTopic = (frame: Topic): AgentIdentityState | undefined =>
  frame.topic === AGENT_AWARENESS_IDENTITY_TOPIC
    ? Option.getOrUndefined(decodeAgentIdentityState(frame.payload))
    : undefined;
