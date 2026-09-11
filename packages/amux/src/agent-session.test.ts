import { expect, test } from "bun:test";
import { Option } from "effect";
import {
  AgentSessionTable,
  agentSessionRefId,
  agentSessionRefPath,
  applyAgentSessionReport,
  isOfficialAgentSource,
  isRootSessionReport,
  normalizeSessionStartSource,
  sessionRefFromReport,
  sessionRefFromSnapshot,
} from "./agent-session.ts";

const abs = (name: string) => `/tmp/amux-agent-session-test/${name}`;

test("unknown and mismatched source/agent pairs are refused", () => {
  expect(isOfficialAgentSource("amux:claude", "claude")).toBe(true);
  expect(isOfficialAgentSource("herdr:claude", "claude")).toBe(false);
  expect(isOfficialAgentSource("amux:claude", "codex")).toBe(false);
  expect(isOfficialAgentSource("evil:claude", "claude")).toBe(false);

  expect(
    applyAgentSessionReport(undefined, undefined, {
      paneId: "p1",
      source: "evil:claude",
      agent: "claude",
      seq: 1,
      agentSessionId: "s1",
    })._tag,
  ).toBe("rejected");
  expect(
    (
      applyAgentSessionReport(undefined, undefined, {
        paneId: "p1",
        source: "evil:claude",
        agent: "claude",
        seq: 1,
        agentSessionId: "s1",
      }) as { reason: string }
    ).reason,
  ).toBe("unknown_source");

  expect(
    (
      applyAgentSessionReport(undefined, undefined, {
        paneId: "p1",
        source: "amux:claude",
        agent: "codex",
        seq: 1,
        agentSessionId: "s1",
      }) as { reason: string }
    ).reason,
  ).toBe("mismatched_source");
});

test("id and path refs reject control chars, over-length, and relative paths", () => {
  expect(Option.isNone(agentSessionRefId(""))).toBe(true);
  expect(Option.isNone(agentSessionRefId("bad\nid"))).toBe(true);
  expect(Option.isNone(agentSessionRefId("x".repeat(513)))).toBe(true);
  expect(Option.getOrNull(agentSessionRefId("ok-id"))).toEqual({ kind: "id", value: "ok-id" });

  expect(Option.isNone(agentSessionRefPath("relative.jsonl"))).toBe(true);
  expect(Option.isNone(agentSessionRefPath("/tmp/bad\npath"))).toBe(true);
  expect(Option.isNone(agentSessionRefPath(`/${"x".repeat(4096)}`))).toBe(true);
  const path = abs("pi-session.jsonl");
  expect(Option.getOrNull(agentSessionRefPath(path))).toEqual({ kind: "path", value: path });
});

test("pi/omp prefer a path ref; everyone else takes an id", () => {
  const path = abs("omp.jsonl");
  expect(
    Option.getOrNull(sessionRefFromReport("amux:omp", "omp", "id-fallback", path)),
  ).toEqual({ kind: "path", value: path });
  expect(Option.getOrNull(sessionRefFromReport("amux:pi", "pi", "id-only", undefined))).toEqual({
    kind: "id",
    value: "id-only",
  });
  expect(
    Option.getOrNull(sessionRefFromReport("amux:claude", "claude", "c1", path)),
  ).toEqual({ kind: "id", value: "c1" });
  expect(Option.isNone(sessionRefFromReport("amux:claude", "claude", undefined, path))).toBe(true);
});

test("snapshot reload re-runs the allowlist and path rules", () => {
  const path = abs("pi.jsonl");
  expect(
    Option.getOrNull(sessionRefFromSnapshot("amux:pi", "pi", "path", path)),
  ).toEqual({ kind: "path", value: path });
  expect(Option.isNone(sessionRefFromSnapshot("amux:claude", "claude", "path", path))).toBe(true);
  expect(Option.isNone(sessionRefFromSnapshot("amux:pi", "pi", "path", "relative.jsonl"))).toBe(
    true,
  );
  expect(Option.isNone(sessionRefFromSnapshot("evil:pi", "pi", "id", "x"))).toBe(true);
});

test("a subagent payload never replaces the pane's root session id", () => {
  expect(isRootSessionReport({})).toBe(true);
  expect(isRootSessionReport({ agentId: "" })).toBe(true);
  expect(isRootSessionReport({ agentId: "sub-1" })).toBe(false);

  const table = new AgentSessionTable();
  expect(
    table.report({
      paneId: "p1",
      source: "amux:claude",
      agent: "claude",
      seq: 1,
      agentSessionId: "root",
    })._tag,
  ).toBe("accepted");
  expect(
    (
      table.report({
        paneId: "p1",
        source: "amux:claude",
        agent: "claude",
        seq: 2,
        agentSessionId: "sub",
        agentId: "sub-1",
      }) as { reason: string }
    ).reason,
  ).toBe("subagent");
  expect(table.get("p1")?.sessionRef.value).toBe("root");
});

test("stale seq reports are rejected; monotonic seq advances", () => {
  const table = new AgentSessionTable();
  expect(
    table.report({
      paneId: "p1",
      source: "amux:opencode",
      agent: "opencode",
      seq: 10,
      agentSessionId: "a",
    })._tag,
  ).toBe("accepted");
  expect(
    (
      table.report({
        paneId: "p1",
        source: "amux:opencode",
        agent: "opencode",
        seq: 10,
        agentSessionId: "a",
      }) as { reason: string }
    ).reason,
  ).toBe("stale_seq");
  expect(
    (
      table.report({
        paneId: "p1",
        source: "amux:opencode",
        agent: "opencode",
        seq: 9,
        agentSessionId: "b",
        sessionStartSource: "select",
      }) as { reason: string }
    ).reason,
  ).toBe("stale_seq");
  expect(
    table.report({
      paneId: "p1",
      source: "amux:opencode",
      agent: "opencode",
      seq: 11,
      agentSessionId: "a",
      lifecycle: "idle",
    })._tag,
  ).toBe("accepted");
  expect(table.get("p1")?.lifecycle).toBe("idle");
});

test("a new conversation replaces the stored ref only with a recognized session_start_source", () => {
  expect(normalizeSessionStartSource("  new ")).toBe("new");
  expect(normalizeSessionStartSource("noise")).toBeUndefined();

  const table = new AgentSessionTable();
  table.report({
    paneId: "p1",
    source: "amux:claude",
    agent: "claude",
    seq: 1,
    agentSessionId: "first",
  });
  expect(
    (
      table.report({
        paneId: "p1",
        source: "amux:claude",
        agent: "claude",
        seq: 2,
        agentSessionId: "second",
      }) as { reason: string }
    ).reason,
  ).toBe("noise_replacement");
  expect(table.get("p1")?.sessionRef.value).toBe("first");

  expect(
    table.report({
      paneId: "p1",
      source: "amux:claude",
      agent: "claude",
      seq: 3,
      agentSessionId: "second",
      sessionStartSource: "clear",
    })._tag,
  ).toBe("accepted");
  expect(table.get("p1")?.sessionRef).toEqual({ kind: "id", value: "second" });
});

test("pid and lifecycle ride with an accepted report for hibernation later", () => {
  const table = new AgentSessionTable();
  const accepted = table.report({
    paneId: "p1",
    source: "amux:codex",
    agent: "codex",
    seq: 1,
    agentSessionId: "c1",
    lifecycle: "needsInput",
    pid: 4242,
  });
  expect(accepted).toEqual({
    _tag: "accepted",
    record: {
      paneId: "p1",
      source: "amux:codex",
      agent: "codex",
      sessionRef: { kind: "id", value: "c1" },
      seq: 1,
      lifecycle: "needsInput",
      pid: 4242,
    },
  });
});

test("load seeds the table from a re-validated snapshot and refuses a bogus one", () => {
  const table = new AgentSessionTable();
  expect(
    table.load("p1", {
      source: "amux:claude",
      agent: "claude",
      kind: "id",
      value: "from-disk",
    }),
  ).toBe(true);
  expect(table.get("p1")?.sessionRef).toEqual({ kind: "id", value: "from-disk" });
  expect(
    table.load("p2", {
      source: "evil:claude",
      agent: "claude",
      kind: "id",
      value: "nope",
    }),
  ).toBe(false);
  expect(table.get("p2")).toBeUndefined();
});
