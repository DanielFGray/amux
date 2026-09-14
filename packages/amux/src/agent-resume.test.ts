import { expect, test } from "bun:test";
import { Duration, Effect, Exit, Fiber, Layer, Option, Schema as S } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  AgentResumeClaimSet,
  AgentResumePlanSchema,
  PLAN_RESUME_TIMEOUT_MS,
  agentResumeDedupeKey,
  askPlanResume,
  planAgentResume,
  planAgentResumeFromSnapshot,
} from "./agent-resume.ts";
import { AgentSessionRefSchema, type AgentSessionRef } from "./agent-session.ts";
import { ForeignHarnessPlanResumeError, type ForeignHarnessAdapter } from "./foreign-harness.ts";
import {
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  opencodeAdapter,
} from "../../plugin-agent-continuity/src/adapters/index.ts";
import { testEffect } from "./test-effect.ts";
import { withCollectingLogger } from "./test-logger.ts";
import { PluginBehaviour, buildPluginBehaviour } from "./plugin-behaviour.ts";
import {
  adapterLookupWith,
  emptyAlgorithms,
  emptyCommands,
  stubSessions,
} from "./test-plugin-behaviour.ts";

const { effect: testClockEffect } = testEffect(Layer.empty);

const adapters = adapterLookupWith([claudeAdapter, codexAdapter, cursorAdapter, opencodeAdapter]);

const withResume = <A, E>(effect: Effect.Effect<A, E, PluginBehaviour>) =>
  effect.pipe(
    Effect.provideService(
      PluginBehaviour,
      buildPluginBehaviour(emptyCommands(), emptyAlgorithms(), adapters, stubSessions),
    ),
  );

const id = (value: string): AgentSessionRef => ({ kind: "id", value });
const path = (value: string): AgentSessionRef => ({ kind: "path", value });

const expectArgv = (
  source: string,
  agent: string,
  sessionRef: AgentSessionRef,
  argv: readonly string[],
) =>
  Effect.gen(function* () {
    const plan = Option.getOrThrow(yield* planAgentResume(source, agent, sessionRef));
    expect(plan.agent).toBe(agent);
    expect(plan.argv).toEqual([...argv]);
    expect(plan.dedupeKey).toBe(agentResumeDedupeKey(source, agent, sessionRef));
  }).pipe(withResume);

testEffect("plan: claude --resume <id>", () =>
  expectArgv("amux:claude", "claude", id("claude-session"), [
    "claude",
    "--resume",
    "claude-session",
  ]),
);

testEffect("plan: codex resume <id> (subcommand)", () =>
  expectArgv("amux:codex", "codex", id("codex-session"), ["codex", "resume", "codex-session"]),
);

testEffect("plan: opencode --session <id>", () =>
  expectArgv("amux:opencode", "opencode", id("opencode-session"), [
    "opencode",
    "--session",
    "opencode-session",
  ]),
);

testEffect("plan: cursor-agent --resume <id>", () =>
  expectArgv("amux:cursor", "cursor", id("cursor-session"), [
    "cursor-agent",
    "--resume",
    "cursor-session",
  ]),
);

testEffect("unsupported source/agent pairs and mismatched kinds yield no plan", () =>
  withResume(
    Effect.gen(function* () {
      expect(Option.isNone(yield* planAgentResume("evil:claude", "claude", id("s")))).toBe(true);
      expect(Option.isNone(yield* planAgentResume("amux:claude", "codex", id("s")))).toBe(true);
      expect(Option.isNone(yield* planAgentResume("amux:droid", "droid", id("s")))).toBe(true);
      expect(Option.isNone(yield* planAgentResume("amux:copilot", "copilot", id("s")))).toBe(true);
      expect(
        Option.isNone(yield* planAgentResume("amux:claude", "claude", path("/tmp/claude-session"))),
      ).toBe(true);
      expect(
        Option.isNone(
          yield* planAgentResume("amux:opencode", "opencode", path("/tmp/opencode-session")),
        ),
      ).toBe(true);
    }),
  ),
);

testEffect("planAgentResumeFromSnapshot re-validates then plans", () =>
  withResume(
    Effect.gen(function* () {
      expect(
        Option.getOrThrow(
          yield* planAgentResumeFromSnapshot({
            source: "amux:claude",
            agent: "claude",
            kind: "id",
            value: "from-snap",
          }),
        ).argv,
      ).toEqual(["claude", "--resume", "from-snap"]);
      expect(
        Option.isNone(
          yield* planAgentResumeFromSnapshot({
            source: "evil:claude",
            agent: "claude",
            kind: "id",
            value: "x",
          }),
        ),
      ).toBe(true);
    }),
  ),
);

testEffect("AgentResumeClaimSet claims once per dedupe key", () =>
  withResume(
    Effect.gen(function* () {
      const claims = new AgentResumeClaimSet();
      const sessionRef = id("same");
      const first = Option.getOrThrow(yield* planAgentResume("amux:codex", "codex", sessionRef));
      const second = Option.getOrThrow(yield* planAgentResume("amux:codex", "codex", sessionRef));
      expect(Option.isSome(claims.take(first))).toBe(true);
      expect(Option.isNone(claims.take(second))).toBe(true);
      claims.release(first.dedupeKey);
      expect(Option.isSome(claims.take(second))).toBe(true);
    }),
  ),
);

test("dedupeKey differs by kind or value", () => {
  expect(agentResumeDedupeKey("amux:pi", "pi", id("a"))).not.toBe(
    agentResumeDedupeKey("amux:pi", "pi", path("/tmp/a")),
  );
});

testEffect("AgentSessionRefSchema and AgentResumePlanSchema round-trip", () =>
  Effect.gen(function* () {
    const ref = { kind: "id" as const, value: "sess-1" };
    const encodedRef = yield* S.encodeEffect(AgentSessionRefSchema)(ref);
    expect(yield* S.decodeEffect(AgentSessionRefSchema)(encodedRef)).toEqual(ref);
    const plan = {
      agent: "claude",
      argv: ["claude", "--resume", "sess-1"],
      dedupeKey: agentResumeDedupeKey("amux:claude", "claude", ref),
    };
    const encodedPlan = yield* S.encodeEffect(AgentResumePlanSchema)(plan);
    expect(yield* S.decodeEffect(AgentResumePlanSchema)(encodedPlan)).toEqual(plan);
  }),
);

testEffect("askPlanResume treats adapter failure as no plan and warns", () =>
  Effect.gen(function* () {
    const failing: ForeignHarnessAdapter = {
      ...claudeAdapter,
      planResume: () =>
        Effect.fail(
          new ForeignHarnessPlanResumeError({
            adapter: "claude",
            message: "boom",
          }),
        ),
    };
    const table = adapterLookupWith([failing]);
    const failingBehaviour = buildPluginBehaviour(
      emptyCommands(),
      emptyAlgorithms(),
      table,
      stubSessions,
    );
    const logs: string[] = [];
    const plan = yield* withCollectingLogger(
      askPlanResume("claude", id("sess")).pipe(
        Effect.provideService(PluginBehaviour, failingBehaviour),
      ),
      logs,
    );
    expect(Option.isNone(plan)).toBe(true);
    expect(logs.some((line) => line.includes("claude") && line.includes("sess"))).toBe(true);
  }),
);

testClockEffect("askPlanResume times out under TestClock and yields no plan", () =>
  Effect.gen(function* () {
    const hanging: ForeignHarnessAdapter = {
      ...codexAdapter,
      planResume: () =>
        Effect.sleep(Duration.minutes(1)).pipe(
          Effect.as(
            Option.some({
              agent: "codex",
              argv: ["codex", "resume", "late"],
              dedupeKey: "never",
            }),
          ),
        ),
    };
    const table = adapterLookupWith([hanging]);
    const hangingBehaviour = buildPluginBehaviour(
      emptyCommands(),
      emptyAlgorithms(),
      table,
      stubSessions,
    );
    const logs: string[] = [];
    const fiber = yield* withCollectingLogger(
      askPlanResume("codex", id("late")).pipe(
        Effect.provideService(PluginBehaviour, hangingBehaviour),
      ),
      logs,
    ).pipe(Effect.exit, Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(PLAN_RESUME_TIMEOUT_MS));
    const result = yield* Fiber.join(fiber);
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) expect(Option.isNone(result.value)).toBe(true);
    expect(logs.some((line) => line.includes("codex") && line.includes("late"))).toBe(true);
  }),
);
