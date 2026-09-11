import { expect, test } from "bun:test";
import { Option } from "effect";
import {
  AgentResumeClaimSet,
  agentResumeDedupeKey,
  planAgentResume,
  planAgentResumeFromSnapshot,
} from "./agent-resume.ts";
import type { AgentSessionRef } from "./agent-session.ts";
import { ForeignHarnessAdapterTable } from "./foreign-harness.ts";
import {
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  opencodeAdapter,
} from "../../plugin-agent-continuity/src/adapters/index.ts";

const adapters = new ForeignHarnessAdapterTable();
for (const adapter of [claudeAdapter, codexAdapter, cursorAdapter, opencodeAdapter])
  adapters.register(adapter);

const id = (value: string): AgentSessionRef => ({ kind: "id", value });
const path = (value: string): AgentSessionRef => ({ kind: "path", value });

const expectArgv = (
  source: string,
  agent: string,
  sessionRef: AgentSessionRef,
  argv: readonly string[],
) => {
  const plan = Option.getOrThrow(planAgentResume(source, agent, sessionRef, adapters));
  expect(plan.agent).toBe(agent);
  expect(plan.argv).toEqual([...argv]);
  expect(plan.dedupeKey).toBe(agentResumeDedupeKey(source, agent, sessionRef));
};

test("plan: claude --resume <id>", () => {
  expectArgv("amux:claude", "claude", id("claude-session"), [
    "claude",
    "--resume",
    "claude-session",
  ]);
});

test("plan: codex resume <id> (subcommand)", () => {
  expectArgv("amux:codex", "codex", id("codex-session"), ["codex", "resume", "codex-session"]);
});

test("plan: opencode --session <id>", () => {
  expectArgv("amux:opencode", "opencode", id("opencode-session"), [
    "opencode",
    "--session",
    "opencode-session",
  ]);
});

test("plan: cursor-agent --resume <id>", () => {
  expectArgv("amux:cursor", "cursor", id("cursor-session"), [
    "cursor-agent",
    "--resume",
    "cursor-session",
  ]);
});

test("unsupported source/agent pairs and mismatched kinds yield no plan", () => {
  expect(Option.isNone(planAgentResume("evil:claude", "claude", id("s"), adapters))).toBe(true);
  expect(Option.isNone(planAgentResume("amux:claude", "codex", id("s"), adapters))).toBe(true);
  // Official allowlist accepts reports, but no adapter registered → omit.
  expect(Option.isNone(planAgentResume("amux:droid", "droid", id("s"), adapters))).toBe(true);
  expect(Option.isNone(planAgentResume("amux:copilot", "copilot", id("s"), adapters))).toBe(true);
  expect(
    Option.isNone(planAgentResume("amux:claude", "claude", path("/tmp/claude-session"), adapters)),
  ).toBe(true);
  expect(
    Option.isNone(
      planAgentResume("amux:opencode", "opencode", path("/tmp/opencode-session"), adapters),
    ),
  ).toBe(true);
});

test("planAgentResumeFromSnapshot re-validates then plans", () => {
  expect(
    Option.getOrThrow(
      planAgentResumeFromSnapshot(
        {
          source: "amux:claude",
          agent: "claude",
          kind: "id",
          value: "from-snap",
        },
        adapters,
      ),
    ).argv,
  ).toEqual(["claude", "--resume", "from-snap"]);
  expect(
    Option.isNone(
      planAgentResumeFromSnapshot(
        {
          source: "evil:claude",
          agent: "claude",
          kind: "id",
          value: "x",
        },
        adapters,
      ),
    ),
  ).toBe(true);
});

test("AgentResumeClaimSet claims once per dedupe key", () => {
  const claims = new AgentResumeClaimSet();
  const sessionRef = id("same");
  const first = Option.getOrThrow(planAgentResume("amux:codex", "codex", sessionRef, adapters));
  const second = Option.getOrThrow(planAgentResume("amux:codex", "codex", sessionRef, adapters));
  expect(Option.isSome(claims.take(first))).toBe(true);
  expect(Option.isNone(claims.take(second))).toBe(true);
  claims.release(first.dedupeKey);
  expect(Option.isSome(claims.take(second))).toBe(true);
});

test("dedupeKey differs by kind or value", () => {
  expect(agentResumeDedupeKey("amux:pi", "pi", id("a"))).not.toBe(
    agentResumeDedupeKey("amux:pi", "pi", path("/tmp/a")),
  );
});
