import { expect } from "bun:test";
import { Effect } from "effect";
import { editorDaemonCommands } from "./daemon.ts";
import type { WorkspaceCommandContext, WorkspaceReadPackage } from "@danielfgray/amux";
import { runtimeCommand } from "@danielfgray/amux";
import { testEffect } from "@danielfgray/amux/testing";

const editorOpen = editorDaemonCommands.find((entry) => entry.tag === "editor.open")!;

const emptyReads = (activeWindow: WorkspaceReadPackage["activeWindow"]): WorkspaceReadPackage => ({
  activeWindow,
  focusedSession: null,
  sessionsById: {},
  agents: [],
  nextPaneBySpace: activeWindow === null ? {} : { [activeWindow.space]: 1 },
});

const context = (pane?: string): WorkspaceCommandContext => {
  const base: WorkspaceCommandContext = {
    cwd: "/tmp/project",
    shell: ["sh"],
    size: { cols: 80, rows: 24 },
  };
  if (pane !== undefined) Object.assign(base, { pane });
  return base;
};

testEffect("editor.open splits when there is no calling pane", () =>
  Effect.gen(function* () {
    const answer = yield* editorOpen.reduce!({
      command: runtimeCommand("editor.open", {}),
      context: context(),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp/project" }),
    });
    expect(answer.changes[0]).toMatchObject({
      _tag: "plugin.place",
      pane: "space-a:p1",
      type: "amux.editor",
      descriptor: {},
      mode: "split",
    });
    expect(answer.changes[1]).toMatchObject({
      _tag: "result.set",
      result: { pane: "space-a:p1" },
    });
  }),
);

testEffect("editor.open replaces when invoked from a pane", () =>
  Effect.gen(function* () {
    const answer = yield* editorOpen.reduce!({
      command: runtimeCommand("editor.open", {}),
      context: context("pane-a"),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp/project" }),
    });
    expect(answer.changes[0]).toMatchObject({ _tag: "plugin.place", mode: "replace" });
    expect(answer.changes[0]).not.toHaveProperty("pane");
    expect(answer.changes[1]).toMatchObject({
      _tag: "result.set",
      result: { pane: "pane-a" },
    });
  }),
);

testEffect("editor.open --split forces a sibling even from a calling pane", () =>
  Effect.gen(function* () {
    const answer = yield* editorOpen.reduce!({
      command: runtimeCommand("editor.open", { split: true }),
      context: context("pane-a"),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp/project" }),
    });
    expect(answer.changes[0]).toMatchObject({ _tag: "plugin.place", mode: "split" });
  }),
);

testEffect("editor.open resolves a relative file against the calling cwd", () =>
  Effect.gen(function* () {
    const answer = yield* editorOpen.reduce!({
      command: runtimeCommand("editor.open", { file: "src/foo.ts" }),
      context: context(),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp/project" }),
    });
    expect(answer.changes[0]).toMatchObject({
      _tag: "plugin.place",
      descriptor: { file: "/tmp/project/src/foo.ts" },
    });
  }),
);
