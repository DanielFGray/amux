import { expect, test } from "bun:test";
import type { JsonValue, Topic } from "@danielfgray/amux/protocol";
import { AGENT_AWARENESS_IDENTITY_TOPIC, agentIdentityFromTopic } from "./identity-state.ts";

const frame = (topic: string, payload: JsonValue): Topic => ({
  _tag: "topic",
  session: "pane-a",
  topic,
  payload,
  sequence: 0,
});

test("a well-formed identity payload decodes on the awareness topic", () => {
  const decoded = agentIdentityFromTopic(
    frame(AGENT_AWARENESS_IDENTITY_TOPIC, { agent: "opencode" }),
  );
  expect(decoded).toEqual({ agent: "opencode" });
});

test("a payload on an unrelated topic is not interpreted as identity", () => {
  const decoded = agentIdentityFromTopic(frame("some.other/topic", { agent: "opencode" }));
  expect(decoded).toBeUndefined();
});

test("a payload missing an agent is rejected", () => {
  const decoded = agentIdentityFromTopic(frame(AGENT_AWARENESS_IDENTITY_TOPIC, {}));
  expect(decoded).toBeUndefined();
});

test("a non-object payload is rejected", () => {
  const decoded = agentIdentityFromTopic(frame(AGENT_AWARENESS_IDENTITY_TOPIC, "opencode"));
  expect(decoded).toBeUndefined();
});
