import { expect, test } from "bun:test";
import { Schema as S } from "effect";
import type { Topic } from "@danielfgray/amux/protocol";
import { AGENT_AWARENESS_IDENTITY_TOPIC, agentIdentityFromTopic } from "./identity-state.ts";

/** Test helper: Encoded nested JSON → Type owner JSON text (same as OwnerJsonText). */
const OwnerJsonText = S.flip(S.fromJsonString(S.Unknown));
const ownerText = (value: typeof OwnerJsonText.Encoded) => S.decodeSync(OwnerJsonText)(value);

const frame = (topic: string, payload: typeof OwnerJsonText.Encoded): Topic => ({
  _tag: "topic",
  session: "pane-a",
  topic,
  payload: ownerText(payload),
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
