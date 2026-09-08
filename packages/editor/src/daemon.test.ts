import { expect, test } from "bun:test";
import type { WorkspaceDraft } from "@danielfgray/amux";
import { editorDaemonCommands } from "./daemon.ts";

const editorOpen = editorDaemonCommands.find((registration) => registration.tag === "editor.open")!;

test("editor.open is a human workspace command that places the editor pane", () => {
  let placed: { type: string; descriptor: unknown } | undefined;
  let result: unknown;
  const draft: WorkspaceDraft = {
    activeWindow: () => null,
    findSession: () => null,
    addSession: () => {
      throw new Error("editor.open must not spawn a session");
    },
    placeSessionPane: () => {
      throw new Error("editor.open must place a plugin pane");
    },
    placePluginPane: (type, descriptor) => {
      placed = { type, descriptor };
      return "pane-1";
    },
    pushAction: () => {},
    setResult: (value) => {
      result = value;
    },
    listAgents: () => [],
    getAgent: () => null,
  };

  expect(editorOpen.fields).toEqual({});
  expect(editorOpen.meta).toEqual({
    desc: "open an editor pane",
    group: "editor",
    target: "workspace",
    exposure: "human",
  });
  editorOpen.reduce!(draft, { _tag: "editor.open" }, {} as never);
  expect(placed).toEqual({ type: "amux.editor", descriptor: {} });
  expect(result).toEqual({ pane: "pane-1" });
});
