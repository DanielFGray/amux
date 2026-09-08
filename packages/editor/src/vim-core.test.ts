/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { charFromKey, initialEditor, reduceEditor } from "./vim-core.ts";
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

/** Drive a sequence of keys through the machine. A string is shorthand for a
 *  plain press of that name. */
function typeKeys(state: EditorState, keys: Array<string | KeyEvent>): EditorState {
  let current = state;
  for (const entry of keys) {
    const event = typeof entry === "string" ? key(entry) : entry;
    current = reduceEditor(current, { _tag: "key", key: event });
  }
  return current;
}

function text(state: EditorState): string {
  return state.lines.join("\n");
}

test("an empty editor starts in normal mode on one empty line", () => {
  const state = initialEditor();
  expect(state.mode).toBe("normal");
  expect(state.lines).toEqual([""]);
  expect(state.cursor).toEqual({ row: 0, col: 0 });
  expect(state.dirty).toBe(false);
  expect(state.request).toBeNull();
});

test("hjkl move the cursor and clamp at the edges", () => {
  const state = reduceEditor(
    {
      ...initialEditor(),
      lines: ["abc", "defgh"],
      cursor: { row: 0, col: 1 },
    },
    { _tag: "key", key: key("l") },
  );
  expect(state.cursor).toEqual({ row: 0, col: 2 });

  const topLeft = typeKeys(state, ["h", "h", "h", "k", "k"]);
  expect(topLeft.cursor).toEqual({ row: 0, col: 0 });

  const bottomRight = typeKeys(state, ["j", "l", "l", "l", "l", "l"]);
  expect(bottomRight.cursor).toEqual({ row: 1, col: 5 });
});

test("0 and $ jump to line start and end", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc", "defgh"], cursor: { row: 1, col: 2 } },
    { _tag: "key", key: key("0") },
  );
  expect(state.cursor).toEqual({ row: 1, col: 0 });

  const end = reduceEditor(state, { _tag: "key", key: key("$") });
  expect(end.cursor).toEqual({ row: 1, col: 5 });
});

test("i inserts before the cursor and escape returns to normal", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } },
    { _tag: "key", key: key("i") },
  );
  expect(state.mode).toBe("insert");

  const typed = typeKeys(state, ["x", "escape"]);
  expect(text(typed)).toBe("axbc");
  expect(typed.mode).toBe("normal");
  // vim steps the cursor back one column on leaving insert, onto the x.
  expect(typed.cursor).toEqual({ row: 0, col: 1 });
  expect(typed.dirty).toBe(true);
});

test("Ctrl-C leaves insert mode using OpenTUI's modifier event shape", () => {
  const state = reduceEditor(initialEditor(), { _tag: "key", key: key("i") });
  const exited = reduceEditor(state, { _tag: "key", key: key("c", { ctrl: true }) });
  expect(exited.mode).toBe("normal");
});

test("a inserts after the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } },
    { _tag: "key", key: key("a") },
  );
  const typed = typeKeys(state, ["x", "escape"]);
  expect(text(typed)).toBe("abxc");
});

test("A and I insert at line end and start", () => {
  const base = { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } };
  const atEnd = typeKeys(reduceEditor(base, { _tag: "key", key: key("A") }), ["y", "escape"]);
  expect(text(atEnd)).toBe("abcy");
  const atStart = typeKeys(reduceEditor(base, { _tag: "key", key: key("I") }), ["z", "escape"]);
  expect(text(atStart)).toBe("zabc");
});

test("o and O open lines below and above and enter insert", () => {
  const base = { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } };
  const below = typeKeys(reduceEditor(base, { _tag: "key", key: key("o") }), ["d", "escape"]);
  expect(text(below)).toBe("abc\nd");
  expect(below.cursor).toEqual({ row: 1, col: 0 });
  const above = typeKeys(reduceEditor(base, { _tag: "key", key: key("O") }), ["e", "escape"]);
  expect(text(above)).toBe("e\nabc");
  expect(above.cursor).toEqual({ row: 0, col: 0 });
});

test("enter splits a line at the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } },
    { _tag: "key", key: key("i") },
  );
  const split = typeKeys(state, ["return", "x", "escape"]);
  expect(text(split)).toBe("a\nxbc");
  expect(split.cursor).toEqual({ row: 1, col: 0 });
});

test("backspace joins lines at column zero", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc", "def"], cursor: { row: 1, col: 0 } },
    { _tag: "key", key: key("i") },
  );
  const joined = typeKeys(state, ["backspace", "escape"]);
  expect(text(joined)).toBe("abcdef");
  expect(joined.cursor).toEqual({ row: 0, col: 2 });
});

test("backspace removes the character before the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 2 } },
    { _tag: "key", key: key("i") },
  );
  const deleted = typeKeys(state, ["backspace", "escape"]);
  expect(text(deleted)).toBe("ac");
});

test("x deletes the character under the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } },
    { _tag: "key", key: key("x") },
  );
  expect(text(state)).toBe("ac");
  expect(state.dirty).toBe(true);
});

test("shifted characters insert as their real glyph", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: [""], cursor: { row: 0, col: 0 } },
    { _tag: "key", key: key("i") },
  );
  const typed = typeKeys(state, [key("a", { shift: true, sequence: "A" }), "escape"]);
  expect(text(typed)).toBe("A");
});

test("charFromKey reads the glyph a shift-modified press actually produced", () => {
  // The parser reports a capital as a lowercase name plus a shift flag, so the
  // character has to come from `sequence`, not `name`.
  expect(charFromKey({ name: "a", shift: true, sequence: "A" } as KeyEvent)).toBe("A");
});

test("charFromKey accepts OpenTUI's named printable space", () => {
  expect(charFromKey(key("space", { sequence: " " }))).toBe(" ");
  const opened = typeKeys(initialEditor(), [
    ":",
    "e",
    key("space", { sequence: " " }),
    "n",
    "o",
    "t",
    "e",
    "return",
  ]);
  expect(opened.request).toEqual({ _tag: "open", path: "note" });
});

test("charFromKey ignores releases and modifier-only keys", () => {
  expect(charFromKey(key("a", { eventType: "release" }))).toBeNull();
  expect(charFromKey(key("a", { ctrl: true }))).toBeNull();
  expect(charFromKey(key("a", { meta: true }))).toBeNull();
  expect(charFromKey(key("enter"))).toBeNull();
  expect(charFromKey(key("a"))).toBe("a");
});

test(": enters command mode and escape cancels it", () => {
  const state = reduceEditor(initialEditor(), { _tag: "key", key: key(":") });
  expect(state.mode).toBe("command");
  const typed = typeKeys(state, ["e", "x", "escape"]);
  expect(typed.mode).toBe("normal");
  expect(typed.command).toBe("");
});

test(":e path asks the shell to open a file", () => {
  const state = typeKeys(initialEditor(), [
    ":",
    "e",
    " ",
    "s",
    "r",
    "c",
    "/",
    "a",
    ".",
    "t",
    "s",
    "return",
  ]);
  expect(state.mode).toBe("normal");
  expect(state.request).toEqual({ _tag: "open", path: "src/a.ts" });
});

test(":w asks to write only once a file is open", () => {
  const noFile = typeKeys(initialEditor(), [":", "w", "return"]);
  expect(noFile.request).toBeNull();
  expect(noFile.message).toContain("no file name");

  const loaded = reduceEditor(initialEditor(), {
    _tag: "loaded",
    file: "/tmp/a.ts",
    lines: ["one", "two"],
  });
  const writing = typeKeys(loaded, [":", "w", "return"]);
  expect(writing.request).toEqual({ _tag: "write" });
});

test(":q closes when clean and refuses when dirty", () => {
  const clean = typeKeys(initialEditor(), [":", "q", "return"]);
  expect(clean.request).toEqual({ _tag: "close" });

  const loaded = reduceEditor(initialEditor(), {
    _tag: "loaded",
    file: "/tmp/a.ts",
    lines: ["one"],
  });
  const dirty = typeKeys(loaded, ["i", "x", "escape"]);
  const refused = typeKeys(dirty, [":", "q", "return"]);
  expect(refused.request).toBeNull();
  expect(refused.message).toContain("no write since last change");

  const forced = typeKeys(dirty, [":", "q", "!", "return"]);
  expect(forced.request).toEqual({ _tag: "close" });
});

test(":wq writes and closes", () => {
  const loaded = reduceEditor(initialEditor(), {
    _tag: "loaded",
    file: "/tmp/a.ts",
    lines: ["one"],
  });
  const saved = typeKeys(loaded, [":", "w", "q", "return"]);
  expect(saved.request).toEqual({ _tag: "write-close" });
});

test("unknown commands surface on the status line", () => {
  const state = typeKeys(initialEditor(), [":", "f", "o", "o", "return"]);
  expect(state.request).toBeNull();
  expect(state.message).toBe("not an editor command: foo");
});

test("loading a file resets the buffer and reports the line count", () => {
  const state = reduceEditor(initialEditor(), {
    _tag: "loaded",
    file: "/tmp/a.ts",
    lines: ["one", "two", "three"],
  });
  expect(text(state)).toBe("one\ntwo\nthree");
  expect(state.file).toBe("/tmp/a.ts");
  expect(state.cursor).toEqual({ row: 0, col: 0 });
  expect(state.dirty).toBe(false);
  expect(state.message).toBe("3 lines");
});

test("a successful write clears dirty", () => {
  const loaded = reduceEditor(initialEditor(), {
    _tag: "loaded",
    file: "/tmp/a.ts",
    lines: ["one"],
  });
  const dirty = typeKeys(loaded, ["i", "x", "escape"]);
  const written = reduceEditor(dirty, { _tag: "written" });
  expect(written.dirty).toBe(false);
  expect(written.request).toBeNull();
  expect(written.message).toContain("written");
});

test("a failed write leaves the buffer dirty with the error on the status line", () => {
  const loaded = reduceEditor(initialEditor(), {
    _tag: "loaded",
    file: "/tmp/a.ts",
    lines: ["one"],
  });
  const failed = reduceEditor(loaded, { _tag: "write-error", message: "permission denied" });
  expect(failed.dirty).toBe(true);
  expect(failed.message).toBe("permission denied");
});

test("w moves to the start of the next word", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one two three"],
    cursor: { row: 0, col: 0 },
  };
  const moved = typeKeys(start, ["w"]);
  expect(moved.cursor).toEqual({ row: 0, col: 4 });
});

test("b backs up to the start of the previous word", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one two three"],
    cursor: { row: 0, col: 4 },
  };
  const moved = typeKeys(start, ["b"]);
  expect(moved.cursor).toEqual({ row: 0, col: 0 });
});

test("e moves to the end of the current word", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one two three"],
    cursor: { row: 0, col: 0 },
  };
  const moved = typeKeys(start, ["e"]);
  expect(moved.cursor).toEqual({ row: 0, col: 2 });
});

test("gg jumps to the first non-blank of the first line", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one", "two", "three"],
    cursor: { row: 2, col: 0 },
  };
  const moved = typeKeys(start, ["g", "g"]);
  expect(moved.cursor).toEqual({ row: 0, col: 0 });
});

test("G jumps to the start of the last line", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one", "two", "three"],
    cursor: { row: 0, col: 0 },
  };
  const moved = typeKeys(start, ["G"]);
  expect(moved.cursor).toEqual({ row: 2, col: 0 });
});

test("counts repeat a motion", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one two three four five"],
    cursor: { row: 0, col: 0 },
  };
  const moved = typeKeys(start, ["3", "w"]);
  expect(moved.cursor.col).toBe(14);
});

test("2dw deletes two words with their trailing space", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one two three four"],
    cursor: { row: 0, col: 0 },
  };
  const deleted = typeKeys(start, ["2", "d", "w"]);
  expect(text(deleted)).toBe("three four");
  expect(deleted.dirty).toBe(true);
  expect(deleted.register.linewise).toBe(false);
});

test("dw deletes one word and leaves cursor at the gap", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one two three"],
    cursor: { row: 0, col: 0 },
  };
  const deleted = typeKeys(start, ["d", "w"]);
  expect(text(deleted)).toBe("two three");
  expect(deleted.cursor).toEqual({ row: 0, col: 0 });
});

test("dd deletes the entire current line", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["alpha", "beta", "gamma"],
    cursor: { row: 1, col: 1 },
  };
  const deleted = typeKeys(start, ["d", "d"]);
  expect(text(deleted)).toBe("alpha\ngamma");
  expect(deleted.cursor).toEqual({ row: 1, col: 0 });
  expect(deleted.register.linewise).toBe(true);
});

test("cw changes the current word and enters insert mode", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one two three"],
    cursor: { row: 0, col: 0 },
  };
  const changed = typeKeys(start, ["c", "w", "X", "escape"]);
  expect(text(changed)).toBe("X two three");
  expect(changed.mode).toBe("normal");
  expect(changed.dirty).toBe(true);
});

test("y$ yanks to end of line and p pastes after the cursor", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["alpha beta"],
    cursor: { row: 0, col: 6 },
  };
  const yanked = typeKeys(start, ["y", "$"]);
  expect(yanked.register.linewise).toBe(false);
  expect(yanked.register.text).toEqual(["beta"]);
  const putted = typeKeys(yanked, ["p"]);
  // Charwise put inserts at col+1, splitting the line right after the cursor.
  expect(text(putted)).toBe("alpha bbetaeta");
  expect(putted.dirty).toBe(true);
});

test("yy yanks the current line and p pastes a copy below", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["alpha", "beta"],
    cursor: { row: 0, col: 0 },
  };
  const yanked = typeKeys(start, ["y", "y"]);
  expect(yanked.register.linewise).toBe(true);
  const putted = typeKeys(yanked, ["p"]);
  expect(text(putted)).toBe("alpha\nalpha\nbeta");
});

test("diw deletes the word under the cursor", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one two three"],
    cursor: { row: 0, col: 5 },
  };
  const deleted = typeKeys(start, ["d", "i", "w"]);
  expect(text(deleted)).toBe("one  three");
  expect(deleted.cursor).toEqual({ row: 0, col: 4 });
});

test("daw deletes the word and the trailing space", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["one two three"],
    cursor: { row: 0, col: 0 },
  };
  const deleted = typeKeys(start, ["d", "a", "w"]);
  expect(text(deleted)).toBe("two three");
});

test("dip deletes the current paragraph", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["para one", "still para", "", "next para"],
    cursor: { row: 1, col: 0 },
  };
  const deleted = typeKeys(start, ["d", "i", "p"]);
  expect(text(deleted)).toBe("next para");
});

test("di( deletes the contents of the surrounding parens", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["foo(bar baz)tail"],
    cursor: { row: 0, col: 5 },
  };
  const deleted = typeKeys(start, ["d", "i", "("]);
  expect(text(deleted)).toBe("foo()tail");
});

test("da( deletes the parens and their contents", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["foo(bar baz)tail"],
    cursor: { row: 0, col: 5 },
  };
  const deleted = typeKeys(start, ["d", "a", "("]);
  expect(text(deleted)).toBe("footail");
});

test("escape cancels a pending operator", () => {
  const start: EditorState = {
    ...initialEditor(),
    lines: ["alpha"],
    cursor: { row: 0, col: 0 },
  };
  const armed = typeKeys(start, ["d"]);
  expect(armed.pending).not.toBeNull();
  const cancelled = typeKeys(armed, ["escape"]);
  expect(cancelled.pending).toBeNull();
  expect(text(cancelled)).toBe("alpha");
});

test("escape cancels a typed count", () => {
  const start: EditorState = { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 0 } };
  const typed = typeKeys(start, ["1", "2", "escape"]);
  expect(typed.count).toBe("");
  expect(typed.cursor).toEqual({ row: 0, col: 0 });
});
