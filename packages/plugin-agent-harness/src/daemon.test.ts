import { expect } from "bun:test";
import { Effect } from "effect";
import { agentHarnessDaemonCommands } from "./daemon.ts";
import type { WorkspaceCommandContext, WorkspaceReadPackage } from "@danielfgray/amux";
import { runtimeCommand } from "@danielfgray/amux";
import { testEffect } from "@danielfgray/amux/testing";

const agentNew = agentHarnessDaemonCommands.find((entry) => entry.tag === "agent.new")!;
const agentInterrupt = agentHarnessDaemonCommands.find((entry) => entry.tag === "agent.interrupt")!;
const agentList = agentHarnessDaemonCommands.find((entry) => entry.tag === "agent.list")!;

const emptyReads = (activeWindow: WorkspaceReadPackage["activeWindow"]): WorkspaceReadPackage => ({
  activeWindow,
  focusedSession: null,
  sessionsById: {},
  agents: [],
  nextPaneBySpace: activeWindow === null ? {} : { [activeWindow.space]: 1 },
});

const context = (pane?: string): WorkspaceCommandContext => {
  const base: WorkspaceCommandContext = {
    cwd: "/tmp",
    shell: ["sh"],
    size: { cols: 80, rows: 24 },
  };
  if (pane !== undefined) Object.assign(base, { pane });
  return base;
};

testEffect("agent.new emits session.add with firstMessage when a prompt is given", () =>
  Effect.gen(function* () {
    const answer = yield* agentNew.reduce!({
      command: runtimeCommand("agent.new", { prompt: "hello" }),
      context: context(),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
    });
    expect(answer.changes[0]).toMatchObject({
      _tag: "session.add",
      provider: "native",
      firstMessage: { _tag: "agent.prompt", text: "hello" },
    });
    expect(answer.changes.some((change) => change._tag === "result.set")).toBe(true);
  }),
);

testEffect("agent.new emits no firstMessage when no prompt is given", () =>
  Effect.gen(function* () {
    const answer = yield* agentNew.reduce!({
      command: runtimeCommand("agent.new", {}),
      context: context(),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
    });
    const add = answer.changes.find((change) => change._tag === "session.add");
    expect(add).toBeDefined();
    expect(add).not.toHaveProperty("firstMessage");
  }),
);

testEffect("agent.new from a calling pane replaces; --split forces a sibling", () =>
  Effect.gen(function* () {
    const replace = yield* agentNew.reduce!({
      command: runtimeCommand("agent.new", {}),
      context: context("pane-a"),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
    });
    expect(replace.changes.find((c) => c._tag === "session.place")).toMatchObject({
      mode: "replace",
    });
    expect(replace.changes.find((c) => c._tag === "session.place")).not.toHaveProperty("pane");
    expect(replace.changes.find((c) => c._tag === "result.set")).toMatchObject({
      result: { pane: "pane-a" },
    });
    const split = yield* agentNew.reduce!({
      command: runtimeCommand("agent.new", { split: true }),
      context: context("pane-a"),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
    });
    expect(split.changes.find((c) => c._tag === "session.place")).toMatchObject({ mode: "split" });
  }),
);

testEffect("agent.interrupt pushes a typed action", () =>
  Effect.gen(function* () {
    const answer = yield* agentInterrupt.reduce!({
      command: runtimeCommand("agent.interrupt", { target: "agent-a", reason: "stop" }),
      context: context(),
      reads: emptyReads(null),
    });
    expect(answer.changes).toEqual([
      {
        _tag: "action.push",
        action: { _tag: "agent.interrupt", agent: "agent-a", reason: "stop" },
      },
    ]);
  }),
);

testEffect("agent.list sets the agents read package as the result", () =>
  Effect.gen(function* () {
    const agents = [
      {
        id: "a1",
        name: "a",
        cols: 80,
        rows: 24,
        exited: false,
        exitCode: null,
        space: "space-a",
        window: 1,
      },
    ];
    const answer = yield* agentList.reduce!({
      command: runtimeCommand("agent.list", {}),
      context: context(),
      reads: { ...emptyReads(null), agents },
    });
    expect(answer.changes).toEqual([{ _tag: "result.set", result: agents }]);
  }),
);

testEffect("agent.new reduce is an Effect (contract smoke)", () =>
  Effect.gen(function* () {
    const answer = yield* agentNew.reduce!({
      command: runtimeCommand("agent.new", {}),
      context: context(),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
    });
    expect(answer.changes.length).toBeGreaterThan(0);
  }),
);

testEffect("agent.new rejects undecodable fields before reduce body", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      agentNew.reduce!({
        command: runtimeCommand("agent.new", { split: "yes" }),
        context: context(),
        reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
      }),
    );
    expect(result._tag).toBe("Failure");
  }),
);
