import { expect, test } from "bun:test";
import { Effect, Schema as S } from "effect";
import { ProcessState, type SessionFact } from "@danielfgray/amux";
import type { AttachFrame } from "@danielfgray/amux/protocol";
import { hookAgentFromFrame, resolvePresence } from "./presence.ts";
import { AGENT_AWARENESS_IDENTITY_TOPIC } from "./identity-state.ts";
import { bundledRegistry } from "@danielfgray/amux-agent-facts/manifests.ts";

const OwnerJsonText = S.flip(S.fromJsonString(S.Unknown));
const ownerText = (value: typeof OwnerJsonText.Encoded) => S.decodeSync(OwnerJsonText)(value);

const registry = await Effect.runPromise(bundledRegistry);

function fact(overrides: Partial<SessionFact> = {}): SessionFact {
  return {
    id: "s1",
    revision: 1,
    lifecycle: "running",
    exitCode: null,
    processState: null,
    command: [],
    declaredAgent: null,
    foreground: null,
    outputRevision: 0,
    screenRevision: 0,
    regions: {},
    ...overrides,
  };
}

test("a declared agent wins identity, but state still reads the arbiter's own resolution", () => {
  const presence = resolvePresence(
    registry,
    "s1",
    fact({ declaredAgent: "claude", processState: ProcessState.Running }),
    "native",
  );
  expect(presence).toMatchObject({
    agent: "claude",
    source: "harness",
    evidence: "declaredAgent:claude",
    state: "working",
  });
});

test("with no declared agent, a hook's identity claim outranks the manifest heuristic", () => {
  const presence = resolvePresence(
    registry,
    "s1",
    fact({ command: ["claude"], processState: ProcessState.Blocked }),
    "native",
  );
  expect(presence).toEqual({
    session: "s1",
    agent: "native",
    state: "blocked",
    source: "hook",
    evidence: "hook:native",
  });
});

test("with neither declared agent nor hook, a manifest rule match wins identity", () => {
  const presence = resolvePresence(
    registry,
    "s1",
    fact({
      command: ["claude"],
      regions: { osc_title: "⠋ thinking" },
      processState: ProcessState.Running,
    }),
    undefined,
  );
  expect(presence).toEqual({
    session: "s1",
    agent: "claude",
    state: "working",
    source: "manifest",
    evidence: "manifest-rule:osc_title_working",
  });
});

test("nothing resolves to an unknown, evidence-free presence", () => {
  const presence = resolvePresence(registry, "s1", fact(), undefined);
  expect(presence).toEqual({
    session: "s1",
    agent: null,
    state: "unknown",
    source: "unknown",
    evidence: null,
  });
});

test("hookAgentFromFrame decodes only the identity topic, ignoring other frames", () => {
  expect(hookAgentFromFrame({ _tag: "output" } as AttachFrame)).toBeUndefined();
  expect(
    hookAgentFromFrame({
      _tag: "topic",
      session: "s1",
      sequence: 1,
      topic: AGENT_AWARENESS_IDENTITY_TOPIC,
      payload: ownerText({ agent: "native" }),
    } as AttachFrame),
  ).toBe("native");
  expect(
    hookAgentFromFrame({
      _tag: "topic",
      session: "s1",
      sequence: 1,
      topic: "some.other/topic",
      payload: ownerText({ agent: "native" }),
    } as AttachFrame),
  ).toBeUndefined();
});
