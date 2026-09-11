import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { BUILTIN_COMMANDS, createEditorApi, resolveCommand } from "./api.ts";
import { initialEditor, reduceEditor } from "./vim-core.ts";
import type { EditorState } from "./schema.ts";

function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    sequence: name,
    ...extra,
  } as KeyEvent;
}

function typeKeys(
  state: EditorState,
  keys: Array<string | KeyEvent>,
  commands = BUILTIN_COMMANDS,
): EditorState {
  let current = state;
  for (const entry of keys) {
    const event = typeof entry === "string" ? key(entry) : entry;
    current = reduceEditor(current, { _tag: "key", key: event }, commands);
  }
  return current;
}

test("createEditorApi ships the builtin ex commands", () => {
  const api = createEditorApi();
  expect(api.command.list().map((c) => c.name)).toEqual([
    "edit",
    "write",
    "quit",
    "wq",
    "x",
    "set",
    "nohlsearch",
    "substitute",
    "delete",
    "move",
    "copy",
    "put",
    "read",
  ]);
  const resolved = resolveCommand("e", api.command.list());
  expect(resolved && "found" in resolved ? resolved.found.name : null).toBe("edit");
});

test("command.add registers a user ex command that reduceEditor can invoke", () => {
  const api = createEditorApi();
  const seen: string[] = [];
  const dispose = api.command.add("Echo", {
    nargs: "1",
    aliases: ["Ec"],
    run: ({ arg, bang }) => {
      seen.push(`${bang ? "!" : ""}${arg}`);
    },
  });

  const state = typeKeys(
    initialEditor(),
    [":", "E", "c", "h", "o", " ", "h", "i", "return"],
    api.command.list(),
  );
  expect(state.request).toEqual({
    _tag: "invoke",
    name: "Echo",
    arg: "hi",
    bang: false,
  });

  api.command.invoke("Echo", { bang: false, arg: "hi", state });
  expect(seen).toEqual(["hi"]);

  dispose();
  const gone = typeKeys(initialEditor(), [":", "E", "c", "h", "o", "return"], api.command.list());
  expect(gone.message).toContain("not an editor command");
});

test("command.add alias and forceable bang reach the invoke request", () => {
  const api = createEditorApi();
  api.command.add("Reload", {
    aliases: ["R"],
    forceable: true,
    nargs: "0",
    run: () => undefined,
  });
  const byAlias = typeKeys(initialEditor(), [":", "R", "!", "return"], api.command.list());
  expect(byAlias.request).toEqual({
    _tag: "invoke",
    name: "Reload",
    arg: "",
    bang: true,
  });
});

test("keymap.set and lookup are mode-scoped and disposable", () => {
  const api = createEditorApi();
  const dispose = api.keymap.set("normal", "H", "0");
  expect(api.keymap.lookup("normal", "H")).toBe("0");
  expect(api.keymap.lookup("insert", "H")).toBeUndefined();
  dispose();
  expect(api.keymap.lookup("normal", "H")).toBeUndefined();
});

test("keymap.set accepts several modes at once", () => {
  const api = createEditorApi();
  api.keymap.set(["normal", "insert"], "jj", "<esc>");
  expect(api.keymap.lookup("normal", "jj")).toBe("<esc>");
  expect(api.keymap.lookup("insert", "jj")).toBe("<esc>");
});

test("duplicate command.add throws", () => {
  const api = createEditorApi();
  api.command.add("Foo", { run: () => undefined });
  expect(() => api.command.add("Foo", { run: () => undefined })).toThrow(/already registered/);
});
