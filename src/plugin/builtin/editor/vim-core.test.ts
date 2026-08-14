/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  charFromKey,
  initialEditor,
  reduceEditor,
  type EditorState,
} from "./vim-core.ts";

function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    sequence: name,
    ...extra,
  } as unknown as KeyEvent;
}

/** Drive a sequence of keys through the machine. A string is shorthand for a
 *  plain press of that name. */
function typeKeys(state: EditorState, keys: Array<string | KeyEvent>): EditorState {
  let current = state;
  for (const entry of keys) {
    const event = typeof entry === "string" ? key(entry) : entry;
    current = reduceEditor(current, { type: "key", key: event });
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
    { type: "key", key: key("l") },
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
    { type: "key", key: key("0") },
  );
  expect(state.cursor).toEqual({ row: 1, col: 0 });

  const end = reduceEditor(state, { type: "key", key: key("$") });
  expect(end.cursor).toEqual({ row: 1, col: 5 });
});

test("i inserts before the cursor and escape returns to normal", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } },
    { type: "key", key: key("i") },
  );
  expect(state.mode).toBe("insert");

  const typed = typeKeys(state, ["x", "escape"]);
  expect(text(typed)).toBe("axbc");
  expect(typed.mode).toBe("normal");
  // vim steps the cursor back one column on leaving insert, onto the x.
  expect(typed.cursor).toEqual({ row: 0, col: 1 });
  expect(typed.dirty).toBe(true);
});

test("a inserts after the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } },
    { type: "key", key: key("a") },
  );
  const typed = typeKeys(state, ["x", "escape"]);
  expect(text(typed)).toBe("abxc");
});

test("A and I insert at line end and start", () => {
  const base = { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } };
  const atEnd = typeKeys(reduceEditor(base, { type: "key", key: key("A") }), ["y", "escape"]);
  expect(text(atEnd)).toBe("abcy");
  const atStart = typeKeys(reduceEditor(base, { type: "key", key: key("I") }), ["z", "escape"]);
  expect(text(atStart)).toBe("zabc");
});

test("o and O open lines below and above and enter insert", () => {
  const base = { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } };
  const below = typeKeys(reduceEditor(base, { type: "key", key: key("o") }), ["d", "escape"]);
  expect(text(below)).toBe("abc\nd");
  expect(below.cursor).toEqual({ row: 1, col: 0 });
  const above = typeKeys(reduceEditor(base, { type: "key", key: key("O") }), ["e", "escape"]);
  expect(text(above)).toBe("e\nabc");
  expect(above.cursor).toEqual({ row: 0, col: 0 });
});

test("enter splits a line at the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } },
    { type: "key", key: key("i") },
  );
  const split = typeKeys(state, ["return", "x", "escape"]);
  expect(text(split)).toBe("a\nxbc");
  expect(split.cursor).toEqual({ row: 1, col: 0 });
});

test("backspace joins lines at column zero", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc", "def"], cursor: { row: 1, col: 0 } },
    { type: "key", key: key("i") },
  );
  const joined = typeKeys(state, ["backspace", "escape"]);
  expect(text(joined)).toBe("abcdef");
  expect(joined.cursor).toEqual({ row: 0, col: 2 });
});

test("backspace removes the character before the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 2 } },
    { type: "key", key: key("i") },
  );
  const deleted = typeKeys(state, ["backspace", "escape"]);
  expect(text(deleted)).toBe("ac");
});

test("x deletes the character under the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: ["abc"], cursor: { row: 0, col: 1 } },
    { type: "key", key: key("x") },
  );
  expect(text(state)).toBe("ac");
  expect(state.dirty).toBe(true);
});

test("shifted characters insert as their real glyph", () => {
  const state = reduceEditor(
    { ...initialEditor(), lines: [""], cursor: { row: 0, col: 0 } },
    { type: "key", key: key("i") },
  );
  const typed = typeKeys(state, [key("a", { shift: true, sequence: "A" }), "escape"]);
  expect(text(typed)).toBe("A");
});

test("charFromKey reads the glyph a shift-modified press actually produced", () => {
  // The parser reports a capital as a lowercase name plus a shift flag, so the
  // character has to come from `sequence`, not `name`.
  expect(charFromKey({ name: "a", shift: true, sequence: "A" } as KeyEvent)).toBe("A");
});

test("charFromKey ignores releases and modifier-only keys", () => {
  expect(charFromKey(key("a", { eventType: "release" }))).toBeNull();
  expect(charFromKey(key("a", { ctrl: true }))).toBeNull();
  expect(charFromKey(key("a", { meta: true }))).toBeNull();
  expect(charFromKey(key("enter"))).toBeNull();
  expect(charFromKey(key("a"))).toBe("a");
});

test(": enters command mode and escape cancels it", () => {
  const state = reduceEditor(initialEditor(), { type: "key", key: key(":") });
  expect(state.mode).toBe("command");
  const typed = typeKeys(state, ["e", "x", "escape"]);
  expect(typed.mode).toBe("normal");
  expect(typed.command).toBe("");
});

test(":e path asks the shell to open a file", () => {
  const state = typeKeys(initialEditor(), [":", "e", " ", "s", "r", "c", "/", "a", ".", "t", "s", "return"]);
  expect(state.mode).toBe("normal");
  expect(state.request).toEqual({ type: "open", path: "src/a.ts" });
});

test(":w asks to write only once a file is open", () => {
  const noFile = typeKeys(initialEditor(), [":", "w", "return"]);
  expect(noFile.request).toBeNull();
  expect(noFile.message).toContain("no file name");

  const loaded = reduceEditor(initialEditor(), {
    type: "loaded",
    file: "/tmp/a.ts",
    lines: ["one", "two"],
  });
  const writing = typeKeys(loaded, [":", "w", "return"]);
  expect(writing.request).toEqual({ type: "write" });
});

test(":q closes when clean and refuses when dirty", () => {
  const clean = typeKeys(initialEditor(), [":", "q", "return"]);
  expect(clean.request).toEqual({ type: "close" });

  const loaded = reduceEditor(initialEditor(), { type: "loaded", file: "/tmp/a.ts", lines: ["one"] });
  const dirty = typeKeys(loaded, ["i", "x", "escape"]);
  const refused = typeKeys(dirty, [":", "q", "return"]);
  expect(refused.request).toBeNull();
  expect(refused.message).toContain("no write since last change");

  const forced = typeKeys(dirty, [":", "q", "!", "return"]);
  expect(forced.request).toEqual({ type: "close" });
});

test(":wq writes and closes", () => {
  const loaded = reduceEditor(initialEditor(), { type: "loaded", file: "/tmp/a.ts", lines: ["one"] });
  const saved = typeKeys(loaded, [":", "w", "q", "return"]);
  expect(saved.request).toEqual({ type: "write-close" });
});

test("unknown commands surface on the status line", () => {
  const state = typeKeys(initialEditor(), [":", "f", "o", "o", "return"]);
  expect(state.request).toBeNull();
  expect(state.message).toBe("not an editor command: foo");
});

test("loading a file resets the buffer and reports the line count", () => {
  const state = reduceEditor(initialEditor(), {
    type: "loaded",
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
  const loaded = reduceEditor(initialEditor(), { type: "loaded", file: "/tmp/a.ts", lines: ["one"] });
  const dirty = typeKeys(loaded, ["i", "x", "escape"]);
  const written = reduceEditor(dirty, { type: "written" });
  expect(written.dirty).toBe(false);
  expect(written.request).toBeNull();
  expect(written.message).toContain("written");
});

test("a failed write leaves the buffer dirty with the error on the status line", () => {
  const loaded = reduceEditor(initialEditor(), { type: "loaded", file: "/tmp/a.ts", lines: ["one"] });
  const failed = reduceEditor(loaded, { type: "write-error", message: "permission denied" });
  expect(failed.dirty).toBe(true);
  expect(failed.message).toBe("permission denied");
});
