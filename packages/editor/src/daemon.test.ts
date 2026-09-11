import { expect, test } from "bun:test";
import type { WorkspaceDraft } from "@danielfgray/amux";
import { editorDaemonCommands } from "./daemon.ts";

const editorOpen = editorDaemonCommands.find((registration) => registration.tag === "editor.open")!;

test("editor.open is a human workspace command that places the editor pane", () => {
  let placed: { type: string; descriptor: unknown; mode?: string } | undefined;
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
    placePluginPane: (type, descriptor, opts) => {
      placed = { type, descriptor, mode: opts?.mode };
      return "pane-1";
    },
    pushAction: () => {},
    setResult: (value) => {
      result = value;
    },
    listAgents: () => [],
    getAgent: () => null,
  };

  expect(editorOpen.meta).toEqual({
    desc: "open an editor pane",
    group: "editor",
    target: "workspace",
    exposure: "human",
  });
  editorOpen.reduce!(draft, { _tag: "editor.open" }, {} as never);
  expect(placed).toEqual({ type: "amux.editor", descriptor: {}, mode: "split" });
  expect(result).toEqual({ pane: "pane-1" });
});

test("editor.open <file> places the editor with that file in the descriptor", () => {
  let placed: { type: string; descriptor: unknown; mode?: string } | undefined;
  const draft: WorkspaceDraft = {
    activeWindow: () => null,
    findSession: () => null,
    addSession: () => {
      throw new Error("unused");
    },
    placeSessionPane: () => {
      throw new Error("unused");
    },
    placePluginPane: (type, descriptor, opts) => {
      placed = { type, descriptor, mode: opts?.mode };
      return "pane-1";
    },
    pushAction: () => {},
    setResult: () => {},
    listAgents: () => [],
    getAgent: () => null,
  };
  editorOpen.reduce!(draft, { _tag: "editor.open", file: "src/note.ts" }, {
    cwd: "/work",
    shell: ["sh"],
    size: { cols: 80, rows: 24 },
  } as never);
  expect(placed).toEqual({
    type: "amux.editor",
    descriptor: { file: "/work/src/note.ts" },
    mode: "split",
  });
});

test("editor.open replaces the calling pane when context.pane is set", () => {
  let mode: string | undefined;
  const draft: WorkspaceDraft = {
    activeWindow: () => null,
    findSession: () => null,
    addSession: () => {
      throw new Error("unused");
    },
    placeSessionPane: () => {
      throw new Error("unused");
    },
    placePluginPane: (_type, _descriptor, opts) => {
      mode = opts?.mode;
      return "pane-1";
    },
    pushAction: () => {},
    setResult: () => {},
    listAgents: () => [],
    getAgent: () => null,
  };
  editorOpen.reduce!(draft, { _tag: "editor.open" }, {
    pane: "pane-shell",
    cwd: "/tmp",
    shell: ["sh"],
    size: { cols: 80, rows: 24 },
  } as never);
  expect(mode).toBe("replace");
});

test("editor.open --split forces a sibling even from a calling pane", () => {
  let mode: string | undefined;
  const draft: WorkspaceDraft = {
    activeWindow: () => null,
    findSession: () => null,
    addSession: () => {
      throw new Error("unused");
    },
    placeSessionPane: () => {
      throw new Error("unused");
    },
    placePluginPane: (_type, _descriptor, opts) => {
      mode = opts?.mode;
      return "pane-1";
    },
    pushAction: () => {},
    setResult: () => {},
    listAgents: () => [],
    getAgent: () => null,
  };
  editorOpen.reduce!(draft, { _tag: "editor.open", split: true }, {
    pane: "pane-shell",
    cwd: "/tmp",
    shell: ["sh"],
    size: { cols: 80, rows: 24 },
  } as never);
  expect(mode).toBe("split");
});
