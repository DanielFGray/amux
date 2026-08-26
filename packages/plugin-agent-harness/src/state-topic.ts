import {
  SESSION_STATE_TOPIC,
  type AgentEventPayload,
  type Topic,
} from "@danielfgray/amux/effect/AttachProtocol.ts";
import { isProcessState, type ProcessState } from "@danielfgray/amux/process-state.ts";

type StateTopicPayload = Extract<AgentEventPayload, { readonly _tag: "topic" }>;

export const agentStateTopic = (state: ProcessState): Omit<StateTopicPayload, "session"> => ({
  _tag: "topic",
  topic: SESSION_STATE_TOPIC,
  payload: state,
});

export const agentStateFromTopic = (frame: Topic): ProcessState | undefined =>
  frame.topic === SESSION_STATE_TOPIC && isProcessState(frame.payload) ? frame.payload : undefined;
