import { expect, test } from "bun:test";
import type { JsonValue, Topic } from "../../../effect/AttachProtocol.ts";
import { AGENT_AWARENESS_IDENTITY_TOPIC, agentIdentityStateFromTopic } from "./identity-state.ts";

const frame = (topic: string, payload: JsonValue): Topic => ({
  _tag: "topic",
  session: "pane-a",
  topic,
  payload,
  sequence: 0,
});

test("a well-formed identity/state payload decodes on the awareness topic", () => {
  const decoded = agentIdentityStateFromTopic(
    frame(AGENT_AWARENESS_IDENTITY_TOPIC, { agent: "opencode", state: "working" }),
  );
  expect(decoded).toEqual({ agent: "opencode", state: "working" });
});

test("a payload on an unrelated topic is not interpreted as identity/state", () => {
  const decoded = agentIdentityStateFromTopic(
    frame("some.other/topic", { agent: "opencode", state: "working" }),
  );
  expect(decoded).toBeUndefined();
});

test("a payload missing an agent is rejected", () => {
  const decoded = agentIdentityStateFromTopic(
    frame(AGENT_AWARENESS_IDENTITY_TOPIC, { state: "working" }),
  );
  expect(decoded).toBeUndefined();
});

test("a payload with a state outside the awareness vocabulary is rejected", () => {
  const decoded = agentIdentityStateFromTopic(
    frame(AGENT_AWARENESS_IDENTITY_TOPIC, { agent: "opencode", state: "sleeping" }),
  );
  expect(decoded).toBeUndefined();
});

test("a non-object payload is rejected", () => {
  const decoded = agentIdentityStateFromTopic(frame(AGENT_AWARENESS_IDENTITY_TOPIC, "working"));
  expect(decoded).toBeUndefined();
});
