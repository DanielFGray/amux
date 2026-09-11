import { expect, test } from "bun:test";
import { BUILTIN_COMMANDS, createEditor } from "./api.ts";
import { fileArgCompletion, fileCompletionItems, splitPathPrefix } from "./command-completion.ts";

test("edit declares complete=file", () => {
  const edit = BUILTIN_COMMANDS.find((command) => command.name === "edit");
  expect(edit?.complete).toBe("file");
});

test("fileArgCompletion arms after the first space on :e", () => {
  expect(fileArgCompletion("e", BUILTIN_COMMANDS)).toBeNull();
  expect(fileArgCompletion("edit", BUILTIN_COMMANDS)).toBeNull();
  expect(fileArgCompletion("e ", BUILTIN_COMMANDS)).toEqual({
    kind: "file",
    head: "edit",
    prefix: "",
  });
  expect(fileArgCompletion("edit src/f", BUILTIN_COMMANDS)).toEqual({
    kind: "file",
    head: "edit",
    prefix: "src/f",
  });
  expect(fileArgCompletion("write ", BUILTIN_COMMANDS)).toBeNull();
});

test("user commands can opt into file completion", () => {
  const editor = createEditor();
  editor.command.add("Open", { nargs: "1", complete: "file", run: () => undefined });
  expect(fileArgCompletion("Open foo", editor.command.list())).toEqual({
    kind: "file",
    head: "Open",
    prefix: "foo",
  });
});

test("splitPathPrefix separates the directory to list from the basename filter", () => {
  expect(splitPathPrefix("")).toEqual({ dir: "", base: "" });
  expect(splitPathPrefix("note")).toEqual({ dir: "", base: "note" });
  expect(splitPathPrefix("src/")).toEqual({ dir: "src", base: "" });
  expect(splitPathPrefix("src/fo")).toEqual({ dir: "src", base: "fo" });
});

test("fileCompletionItems filter by basename and mark directories", () => {
  const items = fileCompletionItems("edit", "n", [
    { name: "note.txt", kind: "file" },
    { name: "nested", kind: "directory" },
    { name: "other.ts", kind: "file" },
    { name: ".hidden", kind: "file" },
  ]);
  expect(items.map((item) => item.replacement)).toEqual(["edit nested/", "edit note.txt"]);
  expect(items[0]?.detail).toBe("directory");
});

test("fileCompletionItems keep the directory prefix while filtering", () => {
  const items = fileCompletionItems("edit", "src/a", [
    { name: "a.ts", kind: "file" },
    { name: "b.ts", kind: "file" },
    { name: "app", kind: "directory" },
  ]);
  expect(items.map((item) => item.label)).toEqual(["src/a.ts", "src/app/"]);
});
