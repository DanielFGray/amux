import { expect } from "bun:test";
import { Effect, Option } from "effect";
import { agentHarnessDaemonCommands } from "./daemon.ts";
import { agentInterruptCommand, agentListCommand, agentNewCommand } from "./command-args.ts";
import type { WorkspaceCommandContext, WorkspaceReadPackage } from "@danielfgray/amux";
import { registeredCommand } from "@danielfgray/amux";
import { nestOwnerArgs, testEffect } from "@danielfgray/amux/testing";
import { OpaqueJsonText, decodeOpaqueJsonText } from "./protocol.ts";

const jt = (value: typeof OpaqueJsonText.Encoded) => Option.getOrThrow(decodeOpaqueJsonText(value));

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
      command: yield* agentNewCommand({ prompt: "hello" }),
      context: context(),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
    });
    expect(answer.changes[0]).toMatchObject({
      _tag: "session.add",
      provider: "native",
      firstMessage: jt({ _tag: "agent.prompt", text: "hello" }),
    });
    expect(answer.changes.some((change) => change._tag === "result.set")).toBe(true);
  }),
);

testEffect("agent.new emits no firstMessage when no prompt is given", () =>
  Effect.gen(function* () {
    const answer = yield* agentNew.reduce!({
      command: yield* agentNewCommand({}),
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
      command: yield* agentNewCommand({}),
      context: context("pane-a"),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
    });
    expect(replace.changes.find((c) => c._tag === "session.place")).toMatchObject({
      mode: "replace",
    });
    expect(replace.changes.find((c) => c._tag === "session.place")).not.toHaveProperty("pane");
    expect(replace.changes.find((c) => c._tag === "result.set")).toEqual(
      expect.objectContaining({
        _tag: "result.set",
        result: expect.stringContaining('"pane":"pane-a"'),
      }),
    );
    const split = yield* agentNew.reduce!({
      command: yield* agentNewCommand({ split: true }),
      context: context("pane-a"),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
    });
    expect(split.changes.find((c) => c._tag === "session.place")).toMatchObject({ mode: "split" });
  }),
);

testEffect("agent.interrupt pushes a typed action", () =>
  Effect.gen(function* () {
    const answer = yield* agentInterrupt.reduce!({
      command: yield* agentInterruptCommand({ target: "agent-a", reason: "stop" }),
      context: context(),
      reads: emptyReads(null),
    });
    expect(answer.changes).toEqual([
      {
        _tag: "action.push",
        action: jt({ _tag: "agent.interrupt", agent: "agent-a", reason: "stop" }),
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
      command: yield* agentListCommand({}),
      context: context(),
      reads: { ...emptyReads(null), agents },
    });
    expect(answer.changes).toEqual([{ _tag: "result.set", result: jt(agents) }]);
  }),
);

testEffect("agent.new reduce is an Effect (contract smoke)", () =>
  Effect.gen(function* () {
    const answer = yield* agentNew.reduce!({
      command: yield* agentNewCommand({}),
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
        command: registeredCommand("agent.new", yield* nestOwnerArgs({ split: "yes" })),
        context: context(),
        reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp" }),
      }),
    );
    expect(result._tag).toBe("Failure");
  }),
);
