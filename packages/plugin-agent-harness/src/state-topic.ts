import { Effect, Option, Schema as S } from "effect";
import {
  SESSION_STATE_TOPIC,
  type AgentEventPayload,
  type Topic,
} from "@danielfgray/amux/protocol";
import { ProcessStateSchema, type ProcessState } from "@danielfgray/amux";

type StateTopicPayload = Extract<AgentEventPayload, { readonly _tag: "topic" }>;

const decodeProcessStateText = S.decodeUnknownOption(S.fromJsonString(ProcessStateSchema));

/** Encode ProcessState to topic OwnerJsonText via the owner schema. */
export const agentStateTopic = (
  state: ProcessState,
): Effect.Effect<Omit<StateTopicPayload, "session">> =>
  S.encodeEffect(S.fromJsonString(ProcessStateSchema))(state).pipe(
    Effect.orDie,
    Effect.map((payload) => ({
      _tag: "topic" as const,
      topic: SESSION_STATE_TOPIC,
      payload,
    })),
  );

export const agentStateFromTopic = (frame: Topic): ProcessState | undefined =>
  frame.topic === SESSION_STATE_TOPIC
    ? Option.getOrUndefined(decodeProcessStateText(frame.payload))
    : undefined;
