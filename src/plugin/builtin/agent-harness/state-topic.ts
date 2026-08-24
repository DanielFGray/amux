import {
  SESSION_STATE_TOPIC,
  type AgentEventPayload,
  type Topic,
} from "../../../effect/AttachProtocol.ts";
import { isReportedAgentState, type ReportedAgentState } from "../../../agent-state.ts";

type StateTopicPayload = Extract<AgentEventPayload, { readonly _tag: "topic" }>;

export const agentStateTopic = (state: ReportedAgentState): Omit<StateTopicPayload, "session"> => ({
  _tag: "topic",
  topic: SESSION_STATE_TOPIC,
  payload: state,
});

export const agentStateFromTopic = (frame: Topic): ReportedAgentState | undefined =>
  frame.topic === SESSION_STATE_TOPIC && isReportedAgentState(frame.payload)
    ? frame.payload
    : undefined;
