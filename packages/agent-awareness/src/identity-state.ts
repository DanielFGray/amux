import { Option, Schema as S } from "effect";
import { Topic } from "@danielfgray/amux/protocol";

export * as IdentityState from "./identity-state.ts";

/**
 * The one topic name adapter hooks publish an agent's identity under. Core
 * routes this as an opaque `Topic` payload and never imports the schema
 * below; the opencode hook asset hardcodes this same string literal because
 * it cannot import from the amux TypeScript sources, so
 * `identity-state.test.ts` cross-checks the two stay in sync.
 *
 * Identity only, not state: a hook reports its live state through core's own
 * generic `process.state`/`topic.publish(SESSION_STATE_TOPIC)` channel,
 * exactly like the native harness does — that is what feeds the
 * `ProcessStateArbiter`'s `SelfReport` tier, and awareness reads the result
 * back off `SessionFact.processState` rather than keeping a second, parallel
 * copy of it. This topic exists only for the one thing core's channel cannot
 * carry: which agent vendor is reporting.
 */
export const AGENT_AWARENESS_IDENTITY_TOPIC = "amux.agent-awareness/identity-state";

/**
 * `agent` identifies which tracked agent this report is about, matching
 * AgentPresence identity rather than assuming the report came from a
 * particular vendor's integration — awareness arbitrates identity across
 * sources, so it must accept any string a hook names rather than a closed
 * enum core or this schema would need to keep current.
 */
export const AgentIdentitySchema = S.Struct({ agent: S.NonEmptyString });
export type AgentIdentity = typeof AgentIdentitySchema.Type;

const decodeAgentIdentity = S.decodeUnknownOption(AgentIdentitySchema);

export const agentIdentityFromTopic = (frame: Topic): AgentIdentity | undefined =>
  frame.topic === AGENT_AWARENESS_IDENTITY_TOPIC
    ? Option.getOrUndefined(decodeAgentIdentity(frame.payload))
    : undefined;
