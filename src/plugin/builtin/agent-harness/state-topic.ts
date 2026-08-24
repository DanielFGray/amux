import type { AgentEventPayload, Topic } from "../../../effect/AttachProtocol.ts";
import { isReportedAgentState, type ReportedAgentState } from "../../../agent-state.ts";

export const AGENT_STATE_TOPIC = "session.state";

type StateTopicPayload = Extract<AgentEventPayload, { readonly _tag: "topic" }>;

export const agentStateTopic = (state: ReportedAgentState): Omit<StateTopicPayload, "session"> => ({
  _tag: "topic",
  topic: AGENT_STATE_TOPIC,
  payload: state,
});

export const agentStateFromTopic = (frame: Topic): ReportedAgentState | undefined =>
  frame.topic === AGENT_STATE_TOPIC && isReportedAgentState(frame.payload)
    ? frame.payload
    : undefined;
