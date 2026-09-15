import { expect } from "bun:test";
import { Effect, Schema as S } from "effect";
import { EditorDescriptorSchema, editorDaemonCommands } from "./daemon.ts";
import type { WorkspaceCommandContext, WorkspaceReadPackage } from "@danielfgray/amux";
import { creationResultSchema } from "@danielfgray/amux";
import { testEffect } from "@danielfgray/amux/testing";

const editorOpen = editorDaemonCommands.find((entry) => entry.tag === "editor.open")!;
const CreationResult = creationResultSchema("pane.open-plugin");

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
      command: yield* editorOpen.command({}),
      context: context(),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp/project" }),
    });
    const place = answer.changes[0] as {
      _tag: "plugin.place";
      pane: string;
      type: string;
      mode: string;
      descriptor: string;
    };
    expect(place).toMatchObject({
      _tag: "plugin.place",
      pane: "space-a:p1",
      type: "amux.editor",
      mode: "split",
    });
    expect(
      yield* S.decodeEffect(S.fromJsonString(EditorDescriptorSchema))(place.descriptor),
    ).toEqual({});
    const result = answer.changes[1] as { _tag: "result.set"; result: string };
    expect(result._tag).toBe("result.set");
    expect(yield* S.decodeEffect(S.fromJsonString(CreationResult))(result.result)).toEqual({
      pane: "space-a:p1",
    });
  }),
);

testEffect("editor.open replaces when invoked from a pane", () =>
  Effect.gen(function* () {
    const answer = yield* editorOpen.reduce!({
      command: yield* editorOpen.command({}),
      context: context("pane-a"),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp/project" }),
    });
    expect(answer.changes[0]).toMatchObject({ _tag: "plugin.place", mode: "replace" });
    expect(answer.changes[0]).not.toHaveProperty("pane");
    const result = answer.changes[1] as { _tag: "result.set"; result: string };
    expect(result._tag).toBe("result.set");
    expect(yield* S.decodeEffect(S.fromJsonString(CreationResult))(result.result)).toEqual({
      pane: "pane-a",
    });
  }),
);

testEffect("editor.open --split forces a sibling even from a calling pane", () =>
  Effect.gen(function* () {
    const answer = yield* editorOpen.reduce!({
      command: yield* editorOpen.command({ split: true }),
      context: context("pane-a"),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp/project" }),
    });
    expect(answer.changes[0]).toMatchObject({ _tag: "plugin.place", mode: "split" });
  }),
);

testEffect("editor.open resolves a relative file against the calling cwd", () =>
  Effect.gen(function* () {
    const answer = yield* editorOpen.reduce!({
      command: yield* editorOpen.command({ file: "src/foo.ts" }),
      context: context(),
      reads: emptyReads({ space: "space-a", window: 1, dir: "/tmp/project" }),
    });
    const place = answer.changes[0] as { _tag: "plugin.place"; descriptor: string };
    expect(place._tag).toBe("plugin.place");
    expect(
      yield* S.decodeEffect(S.fromJsonString(EditorDescriptorSchema))(place.descriptor),
    ).toEqual({
      file: "/tmp/project/src/foo.ts",
    });
  }),
);
