import { expect, test } from "bun:test";
import { Duration, Effect, Exit, Fiber, Layer, Option } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { AgentResumeClaimSet, PLAN_RESUME_TIMEOUT_MS } from "./agent-resume.ts";
import {
  collectSessionResumePlans,
  paneRestoreStartup,
  PendingAgentResumeScheduler,
  type PendingAgentResume,
} from "./agent-restore.ts";
import { ForeignHarnessPlanResumeError, type ForeignHarnessAdapter } from "./foreign-harness.ts";
import { claudeAdapter } from "../../plugin-agent-continuity/src/adapters/claude.ts";
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

const claudePlan = {
  agent: "claude",
  argv: ["claude", "--resume", "claude-session"],
  dedupeKey: "amux:claude\0claude\0id\0claude-session",
};

const pending = (sessionId: string): PendingAgentResume => ({
  sessionId,
  paneId: `pane-${sessionId}`,
  cwd: "/tmp",
  plan: claudePlan,
});

test("paneRestoreStartup suppresses history when a native resume plan exists", () => {
  const claims = new AgentResumeClaimSet();
  const startup = paneRestoreStartup("RESTORED_HISTORY\r\n", Option.some(claudePlan), {
    resumeEnabled: true,
    claims,
  });
  expect(Option.isSome(startup.restorePlan)).toBe(true);
  expect(Option.getOrThrow(startup.restorePlan).argv).toEqual([
    "claude",
    "--resume",
    "claude-session",
  ]);
  expect(Option.isNone(startup.initialHistory)).toBe(true);
  expect(startup.duplicateAgentSession).toBe(false);
});

test("paneRestoreStartup suppresses history for a duplicate native agent session too", () => {
  const claims = new AgentResumeClaimSet();
  const first = paneRestoreStartup("RESTORED_HISTORY\r\n", Option.some(claudePlan), {
    resumeEnabled: true,
    claims,
  });
  const duplicate = paneRestoreStartup("RESTORED_HISTORY\r\n", Option.some(claudePlan), {
    resumeEnabled: true,
    claims,
  });
  expect(Option.isSome(first.restorePlan)).toBe(true);
  expect(Option.isNone(first.initialHistory)).toBe(true);
  expect(Option.isNone(duplicate.restorePlan)).toBe(true);
  expect(Option.isNone(duplicate.initialHistory)).toBe(true);
  expect(duplicate.duplicateAgentSession).toBe(true);
});

test("paneRestoreStartup keeps history when resume is disabled", () => {
  const claims = new AgentResumeClaimSet();
  const startup = paneRestoreStartup("RESTORED_HISTORY\r\n", Option.some(claudePlan), {
    resumeEnabled: false,
    claims,
  });
  expect(Option.isNone(startup.restorePlan)).toBe(true);
  expect(Option.getOrNull(startup.initialHistory)).toBe("RESTORED_HISTORY\r\n");
  expect(startup.duplicateAgentSession).toBe(false);
  expect(claims.has("amux:claude\0claude\0id\0claude-session")).toBe(false);
});

test("paneRestoreStartup keeps history for a plain shell pane (no agent session)", () => {
  const claims = new AgentResumeClaimSet();
  const startup = paneRestoreStartup("shell-history\r\n", Option.none(), {
    resumeEnabled: true,
    claims,
  });
  expect(Option.isNone(startup.restorePlan)).toBe(true);
  expect(Option.getOrNull(startup.initialHistory)).toBe("shell-history\r\n");
});

test("pending scheduler refuses while geometry is dirty or zero", () => {
  const queue = new PendingAgentResumeScheduler();
  queue.enqueue(pending("s1"));

  expect(Option.isNone(queue.takeReady("s1", { cols: 120, rows: 40, dirty: true }))).toBe(true);
  expect(queue.has("s1")).toBe(true);

  expect(Option.isNone(queue.takeReady("s1", { cols: 0, rows: 40 }))).toBe(true);
  expect(queue.has("s1")).toBe(true);
});

test("pending scheduler yields ready resume once geometry settles", () => {
  const queue = new PendingAgentResumeScheduler();
  queue.enqueue(pending("s1"));
  const ready = Option.getOrThrow(queue.takeReady("s1", { cols: 120, rows: 40 }));
  expect(ready.cols).toBe(120);
  expect(ready.rows).toBe(40);
  expect(ready.plan.argv).toEqual(["claude", "--resume", "claude-session"]);
  expect(queue.has("s1")).toBe(false);
});

test("takeAllReady drains every pending resume under one geometry", () => {
  const queue = new PendingAgentResumeScheduler();
  queue.enqueue(pending("a"));
  queue.enqueue(pending("b"));
  const ready = queue.takeAllReady({ cols: 80, rows: 24 });
  expect(ready.map((entry) => entry.sessionId).sort()).toEqual(["a", "b"]);
  expect(queue.sessionIds()).toEqual([]);
});

testEffect("collectSessionResumePlans: a failing adapter leaves that session with no plan", () =>
  Effect.gen(function* () {
    const selective: ForeignHarnessAdapter = {
      ...claudeAdapter,
      planResume: (ref) =>
        ref.value === "fail-sess"
          ? Effect.fail(
              new ForeignHarnessPlanResumeError({
                adapter: "claude",
                message: "adapter exploded",
              }),
            )
          : claudeAdapter.planResume(ref),
    };
    const table = adapterLookupWith([selective]);
    const behaviour = buildPluginBehaviour(emptyCommands(), emptyAlgorithms(), table, stubSessions);
    const logs: string[] = [];
    const plans = yield* withCollectingLogger(
      collectSessionResumePlans([
        {
          sessionId: "s-fail",
          snapshot: {
            source: "amux:claude",
            agent: "claude",
            kind: "id",
            value: "fail-sess",
          },
        },
        {
          sessionId: "s-ok",
          snapshot: {
            source: "amux:claude",
            agent: "claude",
            kind: "id",
            value: "ok-sess",
          },
        },
      ]).pipe(Effect.provideService(PluginBehaviour, behaviour)),
      logs,
    );
    expect(Option.isNone(plans.get("s-fail") ?? Option.none())).toBe(true);
    expect(Option.isSome(plans.get("s-ok") ?? Option.none())).toBe(true);
    expect(logs.some((line) => line.includes("claude") && line.includes("fail-sess"))).toBe(true);
  }),
);

testClockEffect("collectSessionResumePlans: a hanging adapter hits the time limit", () =>
  Effect.gen(function* () {
    const hanging: ForeignHarnessAdapter = {
      ...claudeAdapter,
      planResume: () =>
        Effect.sleep(Duration.minutes(1)).pipe(
          Effect.as(
            Option.some({
              agent: "claude",
              argv: ["claude", "--resume", "late"],
              dedupeKey: "never",
            }),
          ),
        ),
    };
    const table = adapterLookupWith([hanging]);
    const behaviour = buildPluginBehaviour(emptyCommands(), emptyAlgorithms(), table, stubSessions);
    const logs: string[] = [];
    const fiber = yield* withCollectingLogger(
      collectSessionResumePlans([
        {
          sessionId: "s-late",
          snapshot: {
            source: "amux:claude",
            agent: "claude",
            kind: "id",
            value: "late-sess",
          },
        },
      ]).pipe(Effect.provideService(PluginBehaviour, behaviour)),
      logs,
    ).pipe(Effect.exit, Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(PLAN_RESUME_TIMEOUT_MS));
    const result = yield* Fiber.join(fiber);
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(Option.isNone(result.value.get("s-late") ?? Option.none())).toBe(true);
    }
    expect(logs.some((line) => line.includes("claude") && line.includes("late-sess"))).toBe(true);
  }),
);
