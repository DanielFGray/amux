import { expect, test } from "bun:test";
import { Option } from "effect";
import { AgentResumeClaimSet } from "./agent-resume.ts";
import {
  paneRestoreStartup,
  PendingAgentResumeScheduler,
  type PendingAgentResume,
} from "./agent-restore.ts";
import { ForeignHarnessAdapterTable } from "./foreign-harness.ts";
import { claudeAdapter } from "../../plugin-agent-continuity/src/adapters/claude.ts";

const adapters = new ForeignHarnessAdapterTable();
adapters.register(claudeAdapter);

const claudeSnapshot = {
  source: "amux:claude",
  agent: "claude",
  kind: "id" as const,
  value: "claude-session",
};

const pending = (sessionId: string): PendingAgentResume => ({
  sessionId,
  paneId: `pane-${sessionId}`,
  cwd: "/tmp",
  plan: {
    agent: "claude",
    argv: ["claude", "--resume", "claude-session"],
    dedupeKey: "amux:claude\0claude\0id\0claude-session",
  },
});

test("paneRestoreStartup suppresses history when a native resume plan exists", () => {
  const claims = new AgentResumeClaimSet();
  const startup = paneRestoreStartup(claudeSnapshot, "RESTORED_HISTORY\r\n", {
    resumeEnabled: true,
    claims,
    adapters,
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
  const first = paneRestoreStartup(claudeSnapshot, "RESTORED_HISTORY\r\n", {
    resumeEnabled: true,
    claims,
    adapters,
  });
  const duplicate = paneRestoreStartup(claudeSnapshot, "RESTORED_HISTORY\r\n", {
    resumeEnabled: true,
    claims,
    adapters,
  });
  expect(Option.isSome(first.restorePlan)).toBe(true);
  expect(Option.isNone(first.initialHistory)).toBe(true);
  expect(Option.isNone(duplicate.restorePlan)).toBe(true);
  expect(Option.isNone(duplicate.initialHistory)).toBe(true);
  expect(duplicate.duplicateAgentSession).toBe(true);
});

test("paneRestoreStartup keeps history when resume is disabled", () => {
  const claims = new AgentResumeClaimSet();
  const startup = paneRestoreStartup(claudeSnapshot, "RESTORED_HISTORY\r\n", {
    resumeEnabled: false,
    claims,
    adapters,
  });
  expect(Option.isNone(startup.restorePlan)).toBe(true);
  expect(Option.getOrNull(startup.initialHistory)).toBe("RESTORED_HISTORY\r\n");
  expect(startup.duplicateAgentSession).toBe(false);
  expect(claims.has("amux:claude\0claude\0id\0claude-session")).toBe(false);
});

test("paneRestoreStartup keeps history for a plain shell pane (no agent session)", () => {
  const claims = new AgentResumeClaimSet();
  const startup = paneRestoreStartup(undefined, "shell-history\r\n", {
    resumeEnabled: true,
    claims,
    adapters,
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
