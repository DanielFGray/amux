import { expect, test } from "bun:test";
import { Option } from "effect";
import {
  applySurround,
  beginSearch,
  beginSubstitute,
  beginSurround,
  charFromKey,
  initialEditor,
  reduceEditor,
} from "./vim-core.ts";
import { withExtraCursors } from "./cmd-atom.ts";
import type { EditorState } from "./schema.ts";
import { bufferFromLines, linesOf } from "./buffer-state.ts";
import { seedBuffer } from "./history.ts";
import { decodeKey, encodeKey, type Key } from "./key.ts";

function key(name: string, extra: Partial<Key> = {}): Key {
  return {
    name,
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    sequence: name,
    ...extra,
  };
}

/**
 * Drive keys through the machine. Builtin multi-key maps resolve inside
 * reduceEditor via pendingMap.
 */
function typeKeys(state: EditorState, keys: Array<string | Key>): EditorState {
  let current = state;
  for (const entry of keys) {
    const event = typeof entry === "string" ? key(entry) : entry;
    current = reduceEditor(current, { _tag: "key", key: event });
  }
  return current;
}

function text(state: EditorState): string {
  return linesOf(state.buffer).join("\n");
}

test("an empty editor starts in normal mode on one empty line", () => {
  const state = initialEditor();
  expect(state.mode).toBe("normal");
  expect(linesOf(state.buffer)).toEqual([""]);
  expect(state.cursor).toEqual({ row: 0, col: 0 });
  expect(state.dirty).toBe(false);
  expect(state.request).toBeNull();
});

test("hjkl move the cursor and clamp at the edges", () => {
  const state = reduceEditor(
    {
      ...initialEditor(),
      buffer: bufferFromLines(["abc", "defgh"]),
      cursor: { row: 0, col: 1 },
    },
    { _tag: "key", key: key("l") },
  );
  expect(state.cursor).toEqual({ row: 0, col: 2 });

  const topLeft = typeKeys(state, ["h", "h", "h", "k", "k"]);
  expect(topLeft.cursor).toEqual({ row: 0, col: 0 });

  const bottomRight = typeKeys(state, ["j", "l", "l", "l", "l", "l"]);
  // `l` stops on the last character (neovim oneright); no next line to wrap to.
  expect(bottomRight.cursor).toEqual({ row: 1, col: 4 });
});

test("j/k preserve the preferred column across shorter lines", () => {
  // neovim curswant: col 5 → short line clamps → long line restores
  const start = seedBuffer(initialEditor(), bufferFromLines(["abcdefghij", "ab", "abcdefghij"]), {
    row: 0,
    col: 5,
  });
  const mid = typeKeys(start, ["j"]);
  expect(mid.cursor).toEqual({ row: 1, col: 1 });
  const back = typeKeys(mid, ["j"]);
  expect(back.cursor).toEqual({ row: 2, col: 5 });
});

test("$ then j/k sticks to the end of each line", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abcdefghij", "ab", "abcdefghij"]), {
    row: 0,
    col: 0,
  });
  const atEnd = typeKeys(start, ["$"]);
  expect(atEnd.cursor.col).toBe(9);
  expect(atEnd.curswant).toBeGreaterThan(atEnd.cursor.col);
  const short = typeKeys(atEnd, ["j"]);
  expect(short.cursor).toEqual({ row: 1, col: 1 });
  const long = typeKeys(short, ["j"]);
  expect(long.cursor).toEqual({ row: 2, col: 9 });
});

test("j/k preserve display-cell curswant across wide characters", () => {
  // "你好abc" cells: 你@0-1 好@2-3 a@4 b@5 c@6. Cursor on 'a' (string 2, cell 4).
  // Short line "xy" has cells 0,1 — clamp to 'y'. Long line restores cell 4 → 'a'.
  const start = seedBuffer(initialEditor(), bufferFromLines(["你好abc", "xy", "你好abc"]), {
    row: 0,
    col: 2,
  });
  const mid = typeKeys(start, ["j"]);
  expect(mid.cursor).toEqual({ row: 1, col: 1 });
  const back = typeKeys(mid, ["j"]);
  expect(back.cursor).toEqual({ row: 2, col: 2 });
});

test("$ over an emoji lands on the grapheme, not a surrogate half", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a👨b"]), {
    row: 0,
    col: 0,
  });
  const atEnd = typeKeys(start, ["$"]);
  // "a👨b" — last grapheme is 'b' at string index 3 (👨 is two UTF-16 units).
  expect(atEnd.cursor).toEqual({ row: 0, col: 3 });
  expect(atEnd.curswant).toBeGreaterThan(atEnd.cursor.col);
});

test("| goes to a display column, not a UTF-16 index", () => {
  // 你@0-1, a@2 → `3|` is display cell 2 → 'a' at string index 1.
  const start = seedBuffer(initialEditor(), bufferFromLines(["你a"]), {
    row: 0,
    col: 0,
  });
  const landed = typeKeys(start, ["3", "|"]);
  expect(landed.cursor).toEqual({ row: 0, col: 1 });
});

test("0 and $ jump to line start and end", () => {
  const state = reduceEditor(
    { ...initialEditor(), buffer: bufferFromLines(["abc", "defgh"]), cursor: { row: 1, col: 2 } },
    { _tag: "key", key: key("0") },
  );
  expect(state.cursor).toEqual({ row: 1, col: 0 });

  const end = reduceEditor(state, { _tag: "key", key: key("$") });
  expect(end.cursor).toEqual({ row: 1, col: 4 });
});

test("h/l wrap across lines at BOL/EOL (whichwrap)", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abc", "de"]), {
    row: 1,
    col: 0,
  });
  const wrappedBack = typeKeys(start, ["h"]);
  expect(wrappedBack.cursor).toEqual({ row: 0, col: 2 });
  const wrappedFwd = typeKeys(wrappedBack, ["l"]);
  expect(wrappedFwd.cursor).toEqual({ row: 1, col: 0 });
});

test("i inserts before the cursor and escape returns to normal", () => {
  const state = reduceEditor(
    { ...initialEditor(), buffer: bufferFromLines(["abc"]), cursor: { row: 0, col: 1 } },
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
    { ...initialEditor(), buffer: bufferFromLines(["abc"]), cursor: { row: 0, col: 1 } },
    { _tag: "key", key: key("a") },
  );
  const typed = typeKeys(state, ["x", "escape"]);
  expect(text(typed)).toBe("abxc");
});

test("A and I insert at line end and start", () => {
  const base = { ...initialEditor(), buffer: bufferFromLines(["abc"]), cursor: { row: 0, col: 1 } };
  const atEnd = typeKeys(reduceEditor(base, { _tag: "key", key: key("A") }), ["y", "escape"]);
  expect(text(atEnd)).toBe("abcy");
  const atStart = typeKeys(reduceEditor(base, { _tag: "key", key: key("I") }), ["z", "escape"]);
  expect(text(atStart)).toBe("zabc");
});

test("o and O open lines below and above and enter insert", () => {
  const base = { ...initialEditor(), buffer: bufferFromLines(["abc"]), cursor: { row: 0, col: 1 } };
  const below = typeKeys(reduceEditor(base, { _tag: "key", key: key("o") }), ["d", "escape"]);
  expect(text(below)).toBe("abc\nd");
  expect(below.cursor).toEqual({ row: 1, col: 0 });
  const above = typeKeys(reduceEditor(base, { _tag: "key", key: key("O") }), ["e", "escape"]);
  expect(text(above)).toBe("e\nabc");
  expect(above.cursor).toEqual({ row: 0, col: 0 });
});

test("enter splits a line at the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), buffer: bufferFromLines(["abc"]), cursor: { row: 0, col: 1 } },
    { _tag: "key", key: key("i") },
  );
  const split = typeKeys(state, ["return", "x", "escape"]);
  expect(text(split)).toBe("a\nxbc");
  expect(split.cursor).toEqual({ row: 1, col: 0 });
});

test("backspace joins lines at column zero", () => {
  const state = reduceEditor(
    { ...initialEditor(), buffer: bufferFromLines(["abc", "def"]), cursor: { row: 1, col: 0 } },
    { _tag: "key", key: key("i") },
  );
  const joined = typeKeys(state, ["backspace", "escape"]);
  expect(text(joined)).toBe("abcdef");
  expect(joined.cursor).toEqual({ row: 0, col: 2 });
});

test("backspace removes the character before the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), buffer: bufferFromLines(["abc"]), cursor: { row: 0, col: 2 } },
    { _tag: "key", key: key("i") },
  );
  const deleted = typeKeys(state, ["backspace", "escape"]);
  expect(text(deleted)).toBe("ac");
});

test("x deletes the character under the cursor", () => {
  const state = reduceEditor(
    { ...initialEditor(), buffer: bufferFromLines(["abc"]), cursor: { row: 0, col: 1 } },
    { _tag: "key", key: key("x") },
  );
  expect(text(state)).toBe("ac");
  expect(state.dirty).toBe(true);
});

test("shifted characters insert as their real glyph", () => {
  const state = reduceEditor(
    { ...initialEditor(), buffer: bufferFromLines([""]), cursor: { row: 0, col: 0 } },
    { _tag: "key", key: key("i") },
  );
  const typed = typeKeys(state, [key("a", { shift: true, sequence: "A" }), "escape"]);
  expect(text(typed)).toBe("A");
});

test("charFromKey reads the glyph a shift-modified press actually produced", () => {
  // The parser reports a capital as a lowercase name plus a shift flag, so the
  // character has to come from `sequence`, not `name`.
  expect(
    charFromKey({ name: "a", shift: true, sequence: "A", ctrl: false, meta: false, option: false }),
  ).toBe("A");
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

test("charFromKey ignores modifier-only keys", () => {
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

test("loaded records store generation; remote replaces lines and clamps the cursor", () => {
  const loaded = reduceEditor(initialEditor(), {
    _tag: "loaded",
    file: "/tmp/a.ts",
    lines: ["one", "two", "three"],
    generation: 4,
  });
  expect(loaded.generation).toBe(4);

  const remote = reduceEditor(
    { ...loaded, cursor: { row: 2, col: 5 } },
    {
      _tag: "remote",
      lines: ["agent"],
      generation: 5,
      dirty: true,
    },
  );
  expect(linesOf(remote.buffer)).toEqual(["agent"]);
  expect(remote.generation).toBe(5);
  expect(remote.dirty).toBe(true);
  expect(remote.cursor).toEqual({ row: 0, col: 5 });
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

test(":<Tab> on empty lists every command", () => {
  const state = typeKeys(initialEditor(), [":", "tab"]);
  expect(state.mode).toBe("command");
  expect(state.command).toBe("");
  expect(state.message).toBe(
    "edit write quit quit! wq x set nohlsearch substitute delete move copy put read",
  );
});

test(":<Tab> expands toward the canonical name", () => {
  const edited = typeKeys(initialEditor(), [":", "e", "tab"]);
  expect(edited.command).toBe("edit ");
  expect(edited.message).toBeNull();
  const quit = typeKeys(initialEditor(), [":", "q", "tab"]);
  expect(quit.command).toBe("quit");
  expect(quit.message).toBeNull();
  const partial = typeKeys(initialEditor(), [":", "w", "r", "tab"]);
  expect(partial.command).toBe("write");
  const forced = typeKeys(initialEditor(), [":", "q", "!", "tab"]);
  expect(forced.command).toBe("quit!");
  expect(forced.message).toBeNull();
});

test(":<Tab> with no match says so", () => {
  const state = typeKeys(initialEditor(), [":", "z", "tab"]);
  expect(state.command).toBe("z");
  expect(state.message).toBe("no command matches: z");
  const forced = typeKeys(initialEditor(), [":", "w", "!", "tab"]);
  expect(forced.command).toBe("w!");
  expect(forced.message).toBe("no command matches: w!");
});

test(":<Tab> past the first space is the file picker's job", () => {
  const state = typeKeys(initialEditor(), [":", "e", "d", "i", "t", " ", "tab"]);
  expect(state.command).toBe("edit ");
});

test(":<Tab> completion still runs the command", () => {
  const state = typeKeys(initialEditor(), [":", "e", "tab", "s", "r", "c", "return"]);
  expect(state.request).toEqual({ _tag: "open", path: "src" });
});

test("commands run by canonical name or shortest unambiguous prefix", () => {
  const loaded = reduceEditor(initialEditor(), {
    _tag: "loaded",
    file: "/tmp/a.ts",
    lines: ["one"],
  });
  const byPrefix = typeKeys(loaded, [":", "w", "r", "i", "t", "return"]);
  expect(byPrefix.request).toEqual({ _tag: "write" });
  const byCanonical = typeKeys(loaded, [":", "q", "u", "i", "t", "return"]);
  expect(byCanonical.request).toEqual({ _tag: "close" });
  const canonicalForce = typeKeys(loaded, [":", "q", "u", "i", "t", "!", "return"]);
  expect(canonicalForce.request).toEqual({ _tag: "close" });
  const canonicalEdit = typeKeys(initialEditor(), [
    ":",
    "e",
    "d",
    "i",
    "t",
    " ",
    "s",
    "r",
    "c",
    "return",
  ]);
  expect(canonicalEdit.request).toEqual({ _tag: "open", path: "src" });
});

test("force and arguments are rejected where they do not belong", () => {
  const loaded = reduceEditor(initialEditor(), {
    _tag: "loaded",
    file: "/tmp/a.ts",
    lines: ["one"],
  });
  const forcedWrite = typeKeys(loaded, [":", "w", "!", "return"]);
  expect(forcedWrite.request).toBeNull();
  expect(forcedWrite.message).toBe("not an editor command: w!");
  const argWrite = typeKeys(loaded, [":", "w", "r", "i", "t", "e", " ", "x", "return"]);
  expect(argWrite.request).toBeNull();
  expect(argWrite.message).toBe("not an editor command: write x");
  const bareEdit = typeKeys(initialEditor(), [":", "e", "d", "return"]);
  expect(bareEdit.request).toBeNull();
  expect(bareEdit.message).toBe("usage: :edit path");
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
    buffer: bufferFromLines(["one two three"]),
    cursor: { row: 0, col: 0 },
  };
  const moved = typeKeys(start, ["w"]);
  expect(moved.cursor).toEqual({ row: 0, col: 4 });
});

test("b backs up to the start of the previous word", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["one two three"]),
    cursor: { row: 0, col: 4 },
  };
  const moved = typeKeys(start, ["b"]);
  expect(moved.cursor).toEqual({ row: 0, col: 0 });
});

test("e moves to the end of the current word", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["one two three"]),
    cursor: { row: 0, col: 0 },
  };
  const moved = typeKeys(start, ["e"]);
  expect(moved.cursor).toEqual({ row: 0, col: 2 });
});

test("w treats punctuation as its own word; W skips to the next blank-separated WORD", () => {
  // neovim: `foo.bar baz` — word breaks at `.`, WORD only at the space.
  const start = seedBuffer(initialEditor(), bufferFromLines(["foo.bar baz"]), {
    row: 0,
    col: 0,
  });
  expect(typeKeys(start, ["w"]).cursor).toEqual({ row: 0, col: 3 });
  expect(typeKeys(start, ["w", "w"]).cursor).toEqual({ row: 0, col: 4 });
  expect(typeKeys(start, ["W"]).cursor).toEqual({ row: 0, col: 8 });
  expect(typeKeys(start, [key("w", { shift: true, sequence: "W" })]).cursor).toEqual({
    row: 0,
    col: 8,
  });
});

test("iskeyword Latin1: accented letters are word chars; punctuation still breaks", () => {
  // Default isk `@,48-57,_,192-255` — é (0xE9) is keyword; `.` is not.
  const start = seedBuffer(initialEditor(), bufferFromLines(["caf\u00e9.bar"]), { row: 0, col: 0 });
  expect(typeKeys(start, ["e"]).cursor).toEqual({ row: 0, col: 3 }); // end of café
  expect(typeKeys(start, ["w"]).cursor).toEqual({ row: 0, col: 4 }); // onto `.`
});

test("e lands on the end of a punctuation run; E on the end of a WORD", () => {
  const punct = seedBuffer(initialEditor(), bufferFromLines(["!!! xyz"]), { row: 0, col: 0 });
  expect(typeKeys(punct, ["e"]).cursor).toEqual({ row: 0, col: 2 });
  const mixed = seedBuffer(initialEditor(), bufferFromLines(["foo.bar"]), { row: 0, col: 0 });
  expect(typeKeys(mixed, ["e"]).cursor).toEqual({ row: 0, col: 2 });
  expect(typeKeys(mixed, ["E"]).cursor).toEqual({ row: 0, col: 6 });
});

test("b and B back up across word vs WORD boundaries", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["foo.bar"]), {
    row: 0,
    col: 6,
  });
  expect(typeKeys(start, ["b"]).cursor).toEqual({ row: 0, col: 4 });
  expect(typeKeys(start, ["B"]).cursor).toEqual({ row: 0, col: 0 });
});

test("gE moves to the end of the previous WORD", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["foo.bar baz"]), {
    row: 0,
    col: 8,
  });
  expect(typeKeys(start, ["g", "E"]).cursor).toEqual({ row: 0, col: 6 });
});

test("diW deletes the WORD under the cursor", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["pre foo.bar post"]), {
    row: 0,
    col: 6,
  });
  const deleted = typeKeys(start, ["d", "i", "W"]);
  expect(text(deleted)).toBe("pre  post");
});

test("gg jumps to the first non-blank of the first line", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["  one", "two", "three"]),
    cursor: { row: 2, col: 0 },
  };
  const moved = typeKeys(start, ["g", "g"]);
  expect(moved.cursor).toEqual({ row: 0, col: 2 });
});

test("G jumps to the first non-blank of the last line", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["one", "two", "  three"]),
    cursor: { row: 0, col: 0 },
  };
  const moved = typeKeys(start, ["G"]);
  expect(moved.cursor).toEqual({ row: 2, col: 2 });
});

test("dj deletes the current and next line (linewise)", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["alpha", "beta", "gamma"]), {
    row: 0,
    col: 2,
  });
  const deleted = typeKeys(start, ["d", "j"]);
  expect(text(deleted)).toBe("gamma");
  expect(deleted.register.linewise).toBe(true);
  expect(deleted.register.text).toEqual(["alpha", "beta"]);
});

test("yj yanks two lines linewise", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["alpha", "beta", "gamma"]), {
    row: 0,
    col: 2,
  });
  const yanked = typeKeys(start, ["y", "j"]);
  expect(yanked.register.linewise).toBe(true);
  expect(yanked.register.text).toEqual(["alpha", "beta"]);
  expect(text(yanked)).toBe("alpha\nbeta\ngamma");
});

test("counts repeat a motion", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["one two three four five"]),
    cursor: { row: 0, col: 0 },
  };
  const moved = typeKeys(start, ["3", "w"]);
  expect(moved.cursor.col).toBe(14);
});

test("2dw deletes two words with their trailing space", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["one two three four"]),
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
    buffer: bufferFromLines(["one two three"]),
    cursor: { row: 0, col: 0 },
  };
  const deleted = typeKeys(start, ["d", "w"]);
  expect(text(deleted)).toBe("two three");
  expect(deleted.cursor).toEqual({ row: 0, col: 0 });
});

test("dd deletes the entire current line", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["alpha", "beta", "gamma"]),
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
    buffer: bufferFromLines(["one two three"]),
    cursor: { row: 0, col: 0 },
  };
  const changed = typeKeys(start, ["c", "w", "X", "escape"]);
  expect(text(changed)).toBe("X two three");
  expect(changed.mode).toBe("normal");
  expect(changed.dirty).toBe(true);
});

test("cw at word end changes only one character", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["one two"]), {
    row: 0,
    col: 2,
  });
  const changed = typeKeys(start, ["c", "w", "X", "escape"]);
  expect(text(changed)).toBe("onX two");
});

test("cw leaves the trailing space that dw would delete", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["one two"]), {
    row: 0,
    col: 0,
  });
  const changed = typeKeys(start, ["c", "w", "X", "escape"]);
  expect(text(changed)).toBe("X two");
  const deleted = typeKeys(start, ["d", "w"]);
  expect(text(deleted)).toBe("two");
});

test("dw on the last word of a line does not pull in the next line", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["hello foo", "bar"]), {
    row: 0,
    col: 6,
  });
  const deleted = typeKeys(start, ["d", "w"]);
  expect(text(deleted)).toBe("hello \nbar");
  expect(deleted.cursor).toEqual({ row: 0, col: 6 });
});

test("+/−/<CR> move to first non-blank of the next/prev line", () => {
  const start = seedBuffer(
    initialEditor(),
    bufferFromLines(["alpha", "  beta", "   gamma", "delta"]),
    { row: 0, col: 3 },
  );
  const down = typeKeys(start, ["+"]);
  expect(down.cursor).toEqual({ row: 1, col: 2 });
  const cr = typeKeys(down, ["return"]);
  expect(cr.cursor).toEqual({ row: 2, col: 3 });
  const up = typeKeys(cr, ["-"]);
  expect(up.cursor).toEqual({ row: 1, col: 2 });
  const counted = typeKeys(start, ["2", "+"]);
  expect(counted.cursor).toEqual({ row: 2, col: 3 });
});

test("y$ yanks to end of line and p pastes after the cursor", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["alpha beta"]),
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
    buffer: bufferFromLines(["alpha", "beta"]),
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
    buffer: bufferFromLines(["one two three"]),
    cursor: { row: 0, col: 5 },
  };
  const deleted = typeKeys(start, ["d", "i", "w"]);
  expect(text(deleted)).toBe("one  three");
  expect(deleted.cursor).toEqual({ row: 0, col: 4 });
});

test("daw deletes the word and the trailing space", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["one two three"]),
    cursor: { row: 0, col: 0 },
  };
  const deleted = typeKeys(start, ["d", "a", "w"]);
  expect(text(deleted)).toBe("two three");
});

test("dip deletes the current paragraph", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["para one", "still para", "", "next para"]),
    cursor: { row: 1, col: 0 },
  };
  const deleted = typeKeys(start, ["d", "i", "p"]);
  expect(text(deleted)).toBe("next para");
});

test("di( deletes the contents of the surrounding parens", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["foo(bar baz)tail"]),
    cursor: { row: 0, col: 5 },
  };
  const deleted = typeKeys(start, ["d", "i", "("]);
  expect(text(deleted)).toBe("foo()tail");
});

test("da( deletes the parens and their contents", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["foo(bar baz)tail"]),
    cursor: { row: 0, col: 5 },
  };
  const deleted = typeKeys(start, ["d", "a", "("]);
  expect(text(deleted)).toBe("footail");
});

test("di) accepts the closing delimiter like di(", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["foo(bar)tail"]), { row: 0, col: 5 });
  expect(text(typeKeys(start, ["d", "i", ")"]))).toBe("foo()tail");
});

test("di{ works across lines via nested bracket search", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["outer{", "  inner", "}tail"]), {
    row: 1,
    col: 2,
  });
  expect(text(typeKeys(start, ["d", "i", "{"]))).toBe("outer{}tail");
});

test("dis deletes the sentence under the cursor", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["Hello world. Next one."]), {
    row: 0,
    col: 2,
  });
  expect(text(typeKeys(start, ["d", "i", "s"]))).toBe(" Next one.");
});

test("das deletes the sentence and trailing space", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["Hello world. Next one."]), {
    row: 0,
    col: 2,
  });
  expect(text(typeKeys(start, ["d", "a", "s"]))).toBe("Next one.");
});

test("escape cancels a pending operator", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["alpha"]),
    cursor: { row: 0, col: 0 },
  };
  const armed = typeKeys(start, ["d"]);
  expect(armed.pending).not.toBeNull();
  const cancelled = typeKeys(armed, ["escape"]);
  expect(cancelled.pending).toBeNull();
  expect(text(cancelled)).toBe("alpha");
});

test("escape cancels a typed count", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["abc"]),
    cursor: { row: 0, col: 0 },
  };
  const typed = typeKeys(start, ["1", "2", "escape"]);
  expect(typed.count).toBe("");
  expect(typed.cursor).toEqual({ row: 0, col: 0 });
});

test("f finds a character forward and ; /, repeat it", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["abxcdxef"]),
    cursor: { row: 0, col: 0 },
  };
  const found = typeKeys(start, ["f", "x"]);
  expect(found.cursor).toEqual({ row: 0, col: 2 });
  expect(found.lastFind).toEqual({ kind: "f", char: "x" });
  const again = typeKeys(found, [";"]);
  expect(again.cursor).toEqual({ row: 0, col: 5 });
  const back = typeKeys(again, [","]);
  expect(back.cursor).toEqual({ row: 0, col: 2 });
});

test("f and ; search across lines", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["a = 1", "b {", "  c {", "  }", "}"]),
    cursor: { row: 0, col: 0 },
  };
  const first = typeKeys(start, ["f", "{"]);
  expect(first.cursor).toEqual({ row: 1, col: 2 });
  const second = typeKeys(first, [";"]);
  expect(second.cursor).toEqual({ row: 2, col: 4 });
  const third = typeKeys(second, [";"]);
  // No further `{` — stay put.
  expect(third.cursor).toEqual({ row: 2, col: 4 });
  const back = typeKeys(second, [","]);
  expect(back.cursor).toEqual({ row: 1, col: 2 });
});

test("t stops before a match on a later line", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["hello", "{world"]),
    cursor: { row: 0, col: 0 },
  };
  const till = typeKeys(start, ["t", "{"]);
  // Just before `{` at the start of the next line → end of "hello".
  expect(till.cursor).toEqual({ row: 0, col: 5 });
});

test("t stops before the character; T and F go backward", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["abxcd"]),
    cursor: { row: 0, col: 0 },
  };
  const till = typeKeys(start, ["t", "x"]);
  expect(till.cursor).toEqual({ row: 0, col: 1 });
  const fromEnd: EditorState = { ...start, cursor: { row: 0, col: 4 } };
  const findBack = typeKeys(fromEnd, ["F", "x"]);
  expect(findBack.cursor).toEqual({ row: 0, col: 2 });
  const tillBack = typeKeys(fromEnd, ["T", "x"]);
  expect(tillBack.cursor).toEqual({ row: 0, col: 3 });
});

test("dfx deletes through the found character", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["abxcd"]),
    cursor: { row: 0, col: 0 },
  };
  const deleted = typeKeys(start, ["d", "f", "x"]);
  expect(text(deleted)).toBe("cd");
  expect(deleted.cursor).toEqual({ row: 0, col: 0 });
});

test("{} move by paragraph", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["one", "two", "", "three", "four", "", "five"]),
    cursor: { row: 3, col: 0 },
  };
  const next = typeKeys(start, ["}"]);
  expect(next.cursor.row).toBe(5);
  const prev = typeKeys(next, ["{"]);
  expect(prev.cursor.row).toBe(3);
  const first = typeKeys(prev, ["{"]);
  expect(first.cursor.row).toBe(0);
});

test("H M L respect the viewport", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(lines),
    cursor: { row: 10, col: 0 },
    viewport: { top: 5, height: 10 },
  };
  expect(typeKeys(start, ["H"]).cursor.row).toBe(5);
  expect(typeKeys(start, ["M"]).cursor.row).toBe(9);
  expect(typeKeys(start, ["L"]).cursor.row).toBe(14);
});

test("Ctrl-D and Ctrl-U move by half the viewport", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line${i}`);
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(lines),
    cursor: { row: 20, col: 3 },
    viewport: { top: 10, height: 10 },
  };
  const down = typeKeys(start, [key("d", { ctrl: true })]);
  expect(down.cursor).toEqual({ row: 25, col: 3 });
  const up = typeKeys(down, [key("u", { ctrl: true })]);
  expect(up.cursor).toEqual({ row: 20, col: 3 });
});

test("Ctrl-F/B and PageDown/PageUp move by a full viewport", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line${i}`);
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(lines),
    cursor: { row: 20, col: 3 },
    viewport: { top: 10, height: 10 },
  };
  const cases: Array<{ label: string; input: Key; row: number }> = [
    { label: "Ctrl-f", input: key("f", { ctrl: true }), row: 30 },
    { label: "Ctrl-b", input: key("b", { ctrl: true }), row: 10 },
    { label: "PageDown", input: key("pagedown"), row: 30 },
    { label: "PageUp", input: key("pageup"), row: 10 },
  ];
  for (const { input, row } of cases) {
    const moved = typeKeys(start, [input]);
    expect(moved.cursor).toEqual({ row, col: 3 });
  }
  const counted = typeKeys(start, ["2", key("f", { ctrl: true })]);
  expect(counted.cursor.row).toBe(39);
});

test("Key codec round-trips vim notation", () => {
  const samples: Key[] = [
    key("j"),
    key("w", { ctrl: true }),
    key("escape", { sequence: "\x1b" }),
    key("return", { sequence: "\r" }),
    key("a", { shift: true, sequence: "A" }),
    key("space", { sequence: " " }),
  ];
  for (const sample of samples) {
    const encoded = encodeKey(sample);
    expect(encoded).not.toBeNull();
    if (encoded === null) continue;
    const decoded = decodeKey(encoded);
    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isNone(decoded)) continue;
    expect(decoded.value.ctrl).toBe(sample.ctrl);
    expect(decoded.value.name === sample.name || decoded.value.sequence === sample.sequence).toBe(
      true,
    );
  }
  expect(encodeKey(key("w", { ctrl: true }))).toBe("<C-w>");
  expect(encodeKey(key("escape", { sequence: "\x1b" }))).toBe("<Esc>");
  expect(encodeKey(key("return", { sequence: "\r" }))).toBe("<CR>");
  expect(Option.getOrThrow(decodeKey("<C-w>"))).toMatchObject({ name: "w", ctrl: true });
  expect(Option.getOrThrow(decodeKey("<Esc>")).name).toBe("escape");
  expect(Option.getOrThrow(decodeKey("<CR>")).name).toBe("return");
  expect(Option.isNone(decodeKey("escape"))).toBe(true);
  expect(Option.isNone(decodeKey("return"))).toBe(true);
});

test("ysiw) surrounds the inner word", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["hello world"]),
    cursor: { row: 0, col: 7 },
  };
  const wrapped = typeKeys(start, ["y", "s", "i", "w", ")"]);
  expect(text(wrapped)).toBe("hello (world)");
  expect(wrapped.cursor).toEqual({ row: 0, col: 6 });
  expect(wrapped.pendingSurround).toBeNull();
});

test('ysiw( surrounds with spaces; yss" wraps the line', () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["hello world"]),
    cursor: { row: 0, col: 0 },
  };
  const spaced = typeKeys(start, ["y", "s", "i", "w", "("]);
  expect(text(spaced)).toBe("( hello ) world");

  const line: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["  hello"]),
    cursor: { row: 0, col: 3 },
  };
  const quoted = typeKeys(line, ["y", "s", "s", '"']);
  expect(text(quoted)).toBe('  "hello"');
});

test("ds) deletes surrounding parens; ds( also strips spaces", () => {
  const tight: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["(foo)"]),
    cursor: { row: 0, col: 2 },
  };
  expect(text(typeKeys(tight, ["d", "s", ")"]))).toBe("foo");

  const spaced: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["( foo )"]),
    cursor: { row: 0, col: 3 },
  };
  expect(text(typeKeys(spaced, ["d", "s", "("]))).toBe("foo");
  expect(text(typeKeys(spaced, ["d", "s", ")"]))).toBe(" foo ");
});

test("cs)] changes surrounding parens to brackets", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["(foo)"]),
    cursor: { row: 0, col: 2 },
  };
  const changed = typeKeys(start, ["c", "s", ")", "]"]);
  expect(text(changed)).toBe("[foo]");
  expect(changed.mode).toBe("normal");
});

test("escape cancels a pending surround", () => {
  const start: EditorState = {
    ...initialEditor(),
    buffer: bufferFromLines(["hello"]),
    cursor: { row: 0, col: 0 },
  };
  const armed = typeKeys(start, ["y", "s"]);
  expect(armed.pendingSurround).toEqual({ mode: "add", phase: "motion", count: 1 });
  const cancelled = typeKeys(armed, ["escape"]);
  expect(cancelled.pendingSurround).toBeNull();
  expect(text(cancelled)).toBe("hello");
});

test("insert accumulates pendingEdits and undo restores prior buffer", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["ab"]), { row: 0, col: 1 });
  const before = start.buffer;
  const inserted = typeKeys(start, ["i", "x", "escape"]);
  expect(text(inserted)).toBe("axb");
  expect(inserted.pendingEdits.length).toBeGreaterThan(0);
  expect(inserted.pendingEdits[0]).toEqual({
    range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
    newText: "x",
  });
  expect(inserted.buffer).not.toBe(before);
  const undone = typeKeys(inserted, ["u"]);
  expect(text(undone)).toBe("ab");
  expect(undone.buffer).toBe(before);
  expect(undone.pendingEdits).toEqual([]);
});

test("undo tree keeps a branch after undo-then-edit; g- reaches the abandoned tip", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["base"]), { row: 0, col: 4 });
  const branchA = typeKeys(start, ["a", "A", "escape"]);
  expect(text(branchA)).toBe("baseA");
  const undone = typeKeys(branchA, ["u"]);
  expect(text(undone)).toBe("base");
  const branchB = typeKeys(undone, ["a", "B", "escape"]);
  expect(text(branchB)).toBe("baseB");
  // Prefer child is B; Ctrl-R stays on B's branch. g- walks time to A.
  const older = typeKeys(branchB, ["g", "-"]);
  expect(text(older)).toBe("baseA");
  const newer = typeKeys(older, ["g", "+"]);
  expect(text(newer)).toBe("baseB");
  // From base (after undoing B), Ctrl-R prefers B.
  const atBase = typeKeys(branchB, ["u"]);
  expect(text(atBase)).toBe("base");
  const redone = typeKeys(atBase, [key("r", { ctrl: true })]);
  expect(text(redone)).toBe("baseB");
});

test("de is inclusive through word end; dw is exclusive of next word", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["foo bar"]), { row: 0, col: 0 });
  const deletedE = typeKeys(start, ["d", "e"]);
  expect(text(deletedE)).toBe(" bar");
  const deletedW = typeKeys(start, ["d", "w"]);
  expect(text(deletedW)).toBe("bar");
});

test("dfx deletes through the found character via inclusive flag", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abxcd"]), { row: 0, col: 0 });
  const deleted = typeKeys(start, ["d", "f", "x"]);
  expect(text(deleted)).toBe("cd");
});

test("dVw forces linewise delete of the motion span", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["aaa", "bbb", "ccc"]), {
    row: 0,
    col: 0,
  });
  // dVj — force linewise, then j: deletes lines 0-1
  const deleted = typeKeys(start, ["d", "V", "j"]);
  expect(text(deleted)).toBe("ccc");
});

test("finishChange records a CmdAtom that . replays", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abc"]), { row: 0, col: 0 });
  const edited = typeKeys(start, ["x"]);
  expect(edited.lastAtom).not.toBeNull();
  expect(edited.lastAtom?.type).toBe("operator");
  expect(edited.lastAtom?.keys.some((k) => k.name === "x")).toBe(true);
  const again = typeKeys(edited, ["."]);
  expect(text(again)).toBe("c");
  expect(again.lastAtom?.keys).toEqual(edited.lastAtom?.keys);
});

test("CmdAtom cascade: x at extra cursors, one u undoes all", () => {
  const start = withExtraCursors(
    seedBuffer(initialEditor(), bufferFromLines(["aaa", "bbb", "ccc"]), { row: 0, col: 0 }),
    [
      { row: 1, col: 0 },
      { row: 2, col: 0 },
    ],
  );
  expect(start.atomGeneration).toBe(0);
  const deleted = typeKeys(start, ["x"]);
  expect(text(deleted)).toBe("aa\nbb\ncc");
  expect(deleted.extraCursors).toEqual([
    { row: 1, col: 0 },
    { row: 2, col: 0 },
  ]);
  expect(deleted.atomGeneration).toBe(1);
  expect(deleted.lastAtom?.keys.some((k) => k.name === "x")).toBe(true);
  const undone = typeKeys(deleted, ["u"]);
  expect(text(undone)).toBe("aaa\nbbb\nccc");
});

test("CmdAtom cascade: . repeats at primary and extras", () => {
  const start = withExtraCursors(
    seedBuffer(initialEditor(), bufferFromLines(["abcd", "efgh"]), { row: 0, col: 0 }),
    [{ row: 1, col: 0 }],
  );
  const once = typeKeys(start, ["x"]);
  expect(text(once)).toBe("bcd\nfgh");
  const twice = typeKeys(once, ["."]);
  expect(text(twice)).toBe("cd\ngh");
});

test("marks: '' returns to the previous jump (linewise)", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["one", "two", "three"]), {
    row: 0,
    col: 0,
  });
  const atEnd = typeKeys(start, ["G"]);
  expect(atEnd.cursor.row).toBe(2);
  const back = typeKeys(atEnd, ["'", "'"]);
  expect(back.cursor).toEqual({ row: 0, col: 0 });
});

test("marks: ma then 'a jumps linewise to first non-blank", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["  alpha", "  beta", "  gamma"]), {
    row: 2,
    col: 4,
  });
  const marked = typeKeys(start, ["m", "a"]);
  expect(marked.marks.a).toEqual({ row: 2, col: 4 });
  const moved = typeKeys(marked, ["g", "g"]);
  expect(moved.cursor).toEqual({ row: 0, col: 2 });
  const jumped = typeKeys(moved, ["'", "a"]);
  expect(jumped.cursor).toEqual({ row: 2, col: 2 });
});

test("marks: `a jumps to exact column", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["  alpha", "beta"]), {
    row: 0,
    col: 4,
  });
  const marked = typeKeys(start, ["m", "a", "G"]);
  expect(marked.cursor.row).toBe(1);
  const jumped = typeKeys(marked, ["`", "a"]);
  expect(jumped.cursor).toEqual({ row: 0, col: 4 });
});

test("jumplist: G then Ctrl-o returns; Ctrl-i goes forward", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["one", "two", "three"]), {
    row: 0,
    col: 0,
  });
  const atEnd = typeKeys(start, ["G"]);
  expect(atEnd.cursor.row).toBe(2);
  expect(atEnd.jumpList.entries.length).toBeGreaterThan(0);
  const older = typeKeys(atEnd, [key("o", { ctrl: true })]);
  expect(older.cursor).toEqual({ row: 0, col: 0 });
  const newer = typeKeys(older, [key("i", { ctrl: true })]);
  expect(newer.cursor.row).toBe(2);
});

test("changelist: edit then g; returns to the change", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abc", "def"]), { row: 0, col: 0 });
  const edited = typeKeys(start, ["x", "G"]);
  expect(edited.cursor.row).toBe(1);
  expect(edited.changeList.entries.length).toBeGreaterThan(0);
  const back = typeKeys(edited, ["g", ";"]);
  expect(back.cursor.row).toBe(0);
});

test("gv reselects the last visual selection", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 1 });
  const selected = typeKeys(start, ["v", "l", "l", "escape"]);
  expect(selected.mode).toBe("normal");
  expect(selected.lastVisual).not.toBeNull();
  const again = typeKeys(selected, ["g", "v"]);
  expect(again.mode).toBe("visual");
  expect(again.visual?.kind).toBe("char");
  expect(again.visual?.anchor).toEqual({ row: 0, col: 1 });
  expect(again.cursor).toEqual({ row: 0, col: 3 });
});

test("gi resumes insert at the last insert exit", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["ab"]), { row: 0, col: 1 });
  const left = typeKeys(start, ["i", "X", "escape"]);
  expect(left.mode).toBe("normal");
  expect(left.lastInsert).toEqual({ row: 0, col: 2 });
  const moved = typeKeys(left, ["0"]);
  expect(moved.cursor).toEqual({ row: 0, col: 0 });
  const resume = typeKeys(moved, ["g", "i"]);
  expect(resume.mode).toBe("insert");
  expect(resume.cursor).toEqual({ row: 0, col: 2 });
});

test("ge moves to the end of the previous word", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["hello world"]), { row: 0, col: 6 });
  const moved = typeKeys(start, ["g", "e"]);
  expect(moved.cursor).toEqual({ row: 0, col: 4 });
});

test("_ lands on first non-blank of the count'th line", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["  a", "  b", "  c"]), {
    row: 0,
    col: 0,
  });
  expect(typeKeys(start, ["_"]).cursor).toEqual({ row: 0, col: 2 });
  expect(typeKeys(start, ["2", "_"]).cursor).toEqual({ row: 1, col: 2 });
  // Count before operator (`2d_`); mid-op digits (`d2_`) are not composed yet.
  expect(text(typeKeys(start, ["2", "d", "_"]))).toBe("  c");
});

test("| goes to the count-th column", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 0 });
  const moved = typeKeys(start, ["5", "|"]);
  expect(moved.cursor).toEqual({ row: 0, col: 4 });
});

test("50% jumps to the middle of the file", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a", "b", "c", "d", "e", "f", "g"]), {
    row: 0,
    col: 0,
  });
  const moved = typeKeys(start, ["5", "0", "%"]);
  expect(moved.cursor.row).toBe(3);
});

test("% jumps to the matching paren", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a(b(c)d)"]), { row: 0, col: 1 });
  const moved = typeKeys(start, ["%"]);
  expect(moved.cursor).toEqual({ row: 0, col: 7 });
});

test("zz snaps the viewport so the cursor is centered", () => {
  const start = {
    ...seedBuffer(initialEditor(), bufferFromLines(Array.from({ length: 40 }, (_, i) => `L${i}`)), {
      row: 20,
      col: 0,
    }),
    viewport: { top: 0, height: 10 },
  };
  const snapped = typeKeys(start, ["z", "z"]);
  expect(snapped.viewport.top).toBe(20 - Math.floor((10 - 1) / 2));
});

test("Ctrl-e scrolls the viewport down", () => {
  const start = {
    ...seedBuffer(initialEditor(), bufferFromLines(Array.from({ length: 40 }, (_, i) => `L${i}`)), {
      row: 5,
      col: 0,
    }),
    viewport: { top: 0, height: 10 },
  };
  const scrolled = typeKeys(start, [key("e", { ctrl: true })]);
  expect(scrolled.viewport.top).toBe(1);
});

test("scroll event pans the viewport like the mouse wheel", () => {
  const start = {
    ...seedBuffer(initialEditor(), bufferFromLines(Array.from({ length: 40 }, (_, i) => `L${i}`)), {
      row: 0,
      col: 0,
    }),
    viewport: { top: 0, height: 10 },
  };
  const down = reduceEditor(start, { _tag: "scroll", delta: 3 });
  expect(down.viewport.top).toBe(3);
  expect(down.cursor.row).toBe(3);
  const up = reduceEditor(down, { _tag: "scroll", delta: -2 });
  expect(up.viewport.top).toBe(1);
});

test("visual o swaps the ends of the selection", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 1 });
  const selected = typeKeys(start, ["v", "l", "l"]);
  expect(selected.cursor).toEqual({ row: 0, col: 3 });
  expect(selected.visual?.anchor).toEqual({ row: 0, col: 1 });
  const swapped = typeKeys(selected, ["o"]);
  expect(swapped.cursor).toEqual({ row: 0, col: 1 });
  expect(swapped.visual?.anchor).toEqual({ row: 0, col: 3 });
});

test("shift-v enters line visual mode", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["one", "two"]), { row: 0, col: 1 });
  const selected = typeKeys(start, [key("v", { shift: true, sequence: "V" })]);
  expect(selected.mode).toBe("visual");
  expect(selected.visual?.kind).toBe("line");
});

test("ctrl-v does not claim unsupported visual block mode", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["one"]), { row: 0, col: 0 });
  const next = typeKeys(start, [key("v", { ctrl: true })]);
  expect(next.mode).toBe("normal");
  expect(next.message).toContain("not supported");
});

test("~ toggles case under the cursor", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abc"]), { row: 0, col: 0 });
  const toggled = typeKeys(start, ["~"]);
  expect(text(toggled)).toBe("Abc");
  expect(toggled.cursor).toEqual({ row: 0, col: 1 });
});

test("guu lowercases the current line", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["ABC"]), { row: 0, col: 0 });
  const lower = typeKeys(start, ["g", "u", "u"]);
  expect(text(lower)).toBe("abc");
});

test("gUw uppercases a word", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["hello world"]), { row: 0, col: 0 });
  const upper = typeKeys(start, ["g", "U", "w"]);
  expect(text(upper).startsWith("HELLO")).toBe(true);
});

test("== autoindents the current line from the line above", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["  foo", "bar"]), { row: 1, col: 0 });
  const indented = typeKeys(start, ["=", "="]);
  expect(text(indented)).toBe("  foo\n  bar");
});

// ---------------------------------------------------------------------------
// Slice D — insert-mode editing
// ---------------------------------------------------------------------------

test("Ctrl-r pastes the unnamed register in insert mode", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["hello"]), { row: 0, col: 0 });
  const yanked = typeKeys(start, ["y", "w", "A", " "]);
  const pasted = typeKeys(yanked, [key("r", { ctrl: true }), '"', "escape"]);
  expect(text(pasted)).toBe("hello hello");
});

test("Ctrl-w deletes the word before the cursor in insert", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["one two"]), { row: 0, col: 0 });
  const inserted = typeKeys(start, ["A"]);
  expect(inserted.mode).toBe("insert");
  expect(inserted.cursor).toEqual({ row: 0, col: 7 });
  const deleted = typeKeys(inserted, [key("w", { ctrl: true }), "escape"]);
  expect(text(deleted)).toBe("one ");
});

test("Ctrl-u clears from line start to the cursor in insert", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 3 });
  const cleared = typeKeys(typeKeys(start, ["i"]), [key("u", { ctrl: true }), "escape"]);
  expect(text(cleared)).toBe("def");
});

test("Ctrl-t and Ctrl-d shift indent in insert mode", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["foo"]), { row: 0, col: 0 });
  const indented = typeKeys(typeKeys(start, ["i"]), [key("t", { ctrl: true }), "escape"]);
  expect(text(indented)).toBe("  foo");
  const dedented = typeKeys(typeKeys(indented, ["I"]), [key("d", { ctrl: true }), "escape"]);
  expect(text(dedented)).toBe("foo");
});

test("Ctrl-o runs one normal command then returns to insert", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abc"]), { row: 0, col: 0 });
  // A → type x → Ctrl-o x (delete char under normal cursor) → type y → Esc
  const out = typeKeys(start, ["A", "x", key("o", { ctrl: true }), "x", "y", "escape"]);
  expect(out.mode).toBe("normal");
  // "abc" + "x" → "abcx"; Ctrl-o steps back onto x; x deletes it; insert resumes; y typed
  expect(text(out)).toBe("abcy");
});

// ---------------------------------------------------------------------------
// Slice E — macros
// ---------------------------------------------------------------------------

test("qa records a macro and @a replays it", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abc", "def"]), { row: 0, col: 0 });
  const recorded = typeKeys(start, ["q", "a", "x", "q"]);
  expect(recorded.macroReg).toBeNull();
  expect(recorded.macros.a).toEqual([key("x")]);
  expect(text(recorded)).toBe("bc\ndef");
  const replayed = typeKeys(recorded, ["j", "0", "@", "a"]);
  expect(text(replayed)).toBe("bc\nef");
  expect(replayed.lastMacro).toBe("a");
});

test("@@ replays the last macro", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["aaa", "bbb", "ccc"]), {
    row: 0,
    col: 0,
  });
  const recorded = typeKeys(start, ["q", "a", "x", "q"]);
  const once = typeKeys(recorded, ["j", "0", "@", "a"]);
  const twice = typeKeys(once, ["j", "0", "@", "@"]);
  expect(text(twice)).toBe("aa\nbb\ncc");
});

test("macro recording does not overwrite the . change tape", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abc"]), { row: 0, col: 0 });
  const changed = typeKeys(start, ["x"]);
  const withMacro = typeKeys(changed, ["q", "a", "l", "q"]);
  expect(withMacro.macros.a).toEqual([key("l")]);
  // `.` still repeats the delete at the current cursor (line start).
  expect(text(typeKeys(withMacro, ["0", "."]))).toBe("c");
});

// ---------------------------------------------------------------------------
// Slice F — replace mode
// ---------------------------------------------------------------------------

test("R overwrites characters until escape", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 1 });
  const replaced = typeKeys(start, ["R", "X", "Y", "escape"]);
  expect(text(replaced)).toBe("aXYdef");
  expect(replaced.mode).toBe("normal");
});

test("R past end of line appends like insert", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["ab"]), { row: 0, col: 0 });
  const replaced = typeKeys(start, ["R", "x", "y", "z", "escape"]);
  expect(text(replaced)).toBe("xyz");
});

// ---------------------------------------------------------------------------
// Slice G — registers realism
// ---------------------------------------------------------------------------

test('"_ black-hole delete does not clobber the unnamed register', () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["keep", "drop"]), { row: 0, col: 0 });
  const yanked = typeKeys(start, ["y", "y"]);
  expect(yanked.register.text).toEqual(["keep"]);
  const dropped = typeKeys(yanked, ["j", '"', "_", "d", "d"]);
  expect(text(dropped)).toBe("keep");
  expect(dropped.register.text).toEqual(["keep"]);
});

test("deletes rotate into numbered registers 1-9", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a", "b", "c"]), { row: 0, col: 0 });
  const first = typeKeys(start, ["d", "d"]);
  expect(first.registers["1"]?.text).toEqual(["a"]);
  const second = typeKeys(first, ["d", "d"]);
  expect(second.registers["1"]?.text).toEqual(["b"]);
  expect(second.registers["2"]?.text).toEqual(["a"]);
});

test('"ayy then "ap pastes from the named register', () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["alpha", "beta"]), { row: 0, col: 0 });
  const yanked = typeKeys(start, ['"', "a", "y", "y", "j"]);
  expect(yanked.registers.a?.text).toEqual(["alpha"]);
  const putted = typeKeys(yanked, ['"', "a", "p"]);
  expect(text(putted)).toBe("alpha\nbeta\nalpha");
});

test('special ". stores last inserted text', () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["ab"]), { row: 0, col: 1 });
  const typed = typeKeys(start, ["i", "X", "Y", "escape"]);
  expect(typed.registers["."]?.text).toEqual(["XY"]);
});

test('special "/ stores the last search pattern', () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["hello world"]), { row: 0, col: 0 });
  const searched = typeKeys(start, ["/", "w", "o", "return"]);
  expect(searched.registers["/"]?.text).toEqual(["wo"]);
});

test('special ": stores the last cmdline', () => {
  const start = seedBuffer(initialEditor(), bufferFromLines([""]), { row: 0, col: 0 });
  const commanded = typeKeys(start, [":", "e", "d", "i", "t", " ", "x", "return"]);
  expect(commanded.registers[":"]?.text).toEqual(["edit x"]);
});

test('"+yy emits a clipboard request for OSC 52', () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["hello", "world"]), {
    row: 0,
    col: 0,
  });
  const yanked = typeKeys(start, ['"', "+", "y", "y"]);
  expect(yanked.registers["+"]?.text).toEqual(["hello"]);
  expect(yanked.request).toEqual({
    _tag: "clipboard",
    text: "hello\n",
    target: "clipboard",
  });
});

test('"*yy emits a primary-selection clipboard request', () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["alpha"]), { row: 0, col: 0 });
  const yanked = typeKeys(start, ['"', "*", "y", "y"]);
  expect(yanked.request).toEqual({
    _tag: "clipboard",
    text: "alpha\n",
    target: "primary",
  });
});

// ---------------------------------------------------------------------------
// Slice H — Ex depth
// ---------------------------------------------------------------------------

test(":%s/foo/bar/g substitutes across the buffer", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["foo one", "two foo", "foo"]), {
    row: 0,
    col: 0,
  });
  const next = typeKeys(start, [
    ":",
    "%",
    "s",
    "/",
    "f",
    "o",
    "o",
    "/",
    "b",
    "a",
    "r",
    "/",
    "g",
    "return",
  ]);
  expect(text(next)).toBe("bar one\ntwo bar\nbar");
  expect(next.mode).toBe("normal");
});

test(":2,3d deletes a line range into the numbered register", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a", "b", "c", "d"]), {
    row: 0,
    col: 0,
  });
  const next = typeKeys(start, [":", "2", ",", "3", "d", "return"]);
  expect(text(next)).toBe("a\nd");
  expect(next.registers["1"]?.text).toEqual(["b", "c"]);
});

test(":m and :t move and copy lines", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a", "b", "c"]), { row: 0, col: 0 });
  const moved = typeKeys(start, [":", "1", "m", "2", "return"]);
  expect(text(moved)).toBe("b\na\nc");
  const copied = typeKeys(
    seedBuffer(initialEditor(), bufferFromLines(["a", "b", "c"]), { row: 0, col: 0 }),
    [":", "1", "t", "2", "return"],
  );
  expect(text(copied)).toBe("a\nb\na\nc");
});

test(":put inserts a register after the range", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a", "b"]), { row: 0, col: 0 });
  const yanked = typeKeys(start, ["y", "y"]);
  const put = typeKeys(yanked, [":", "p", "u", "t", "return"]);
  expect(text(put)).toBe("a\na\nb");
});

test(":set toggles number / hlsearch; :noh clears search highlight", () => {
  const start = initialEditor();
  expect(start.options.number).toBe(true);
  const nonu = typeKeys(start, [
    ":",
    "s",
    "e",
    "t",
    " ",
    "n",
    "o",
    "n",
    "u",
    "m",
    "b",
    "e",
    "r",
    "return",
  ]);
  expect(nonu.options.number).toBe(false);
  const searched = typeKeys(
    seedBuffer(initialEditor(), bufferFromLines(["hello", "world"]), { row: 0, col: 0 }),
    ["/", "w", "o", "r", "return"],
  );
  expect(searched.searchHighlight).toBe(true);
  const noh = typeKeys(searched, [":", "n", "o", "h", "return"]);
  expect(noh.searchHighlight).toBe(false);
  expect(noh.options.hlsearch).toBe(true);
});

test(":r emits a read request after the current line", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a", "b"]), { row: 0, col: 0 });
  const next = typeKeys(start, [":", "r", " ", "n", "o", "t", "e", ".", "t", "x", "t", "return"]);
  expect(next.request).toEqual({ _tag: "read", path: "note.txt", afterRow: 0 });
});

test(":0r! emits shell-read at the top of the buffer", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["keep"]), { row: 0, col: 0 });
  const keys = [":", "0", "r", "!", " ", ..."curl -sL https://example.com".split(""), "return"];
  const next = typeKeys(start, keys);
  expect(next.request).toEqual({
    _tag: "shell-read",
    cmd: "curl -sL https://example.com",
    afterRow: -1,
  });
});

test(":r! without address inserts after the current line", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a", "b"]), { row: 1, col: 0 });
  const next = typeKeys(start, [":", "r", "!", " ", "e", "c", "h", "o", " ", "h", "i", "return"]);
  expect(next.request).toEqual({
    _tag: "shell-read",
    cmd: "echo hi",
    afterRow: 1,
  });
});

test("command-mode Up/Down walks cmdline history", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["x"]), { row: 0, col: 0 });
  const afterSet = typeKeys(start, [
    ":",
    "s",
    "e",
    "t",
    " ",
    "n",
    "u",
    "m",
    "b",
    "e",
    "r",
    "return",
  ]);
  expect(afterSet.commandHistory).toEqual(["set number"]);
  const browsing = typeKeys(afterSet, [":", "up"]);
  expect(browsing.mode).toBe("command");
  expect(browsing.command).toBe("set number");
  const cleared = typeKeys(browsing, ["down"]);
  expect(cleared.command).toBe("");
});

test(":3 jumps to line 3", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["a", "b", "c", "d"]), {
    row: 0,
    col: 0,
  });
  const next = typeKeys(start, [":", "3", "return"]);
  expect(next.cursor).toEqual({ row: 2, col: 0 });
});

test("X deletes the character before the cursor", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abcd"]), { row: 0, col: 2 });
  expect(text(typeKeys(start, ["X"]))).toBe("acd");
  expect(typeKeys(start, ["X"]).cursor).toEqual({ row: 0, col: 1 });
  expect(text(typeKeys(start, ["2", "X"]))).toBe("cd");
  // At BOL, X is a no-op.
  expect(
    text(typeKeys(seedBuffer(initialEditor(), bufferFromLines(["ab"]), { row: 0, col: 0 }), ["X"])),
  ).toBe("ab");
});

test("( ) move by sentences", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["Hello world. Next one. Third."]), {
    row: 0,
    col: 2,
  });
  expect(typeKeys(start, [")"]).cursor).toEqual({ row: 0, col: 13 });
  expect(typeKeys(start, [")", ")"]).cursor).toEqual({ row: 0, col: 23 });
  const atSecond = typeKeys(start, [")"]);
  expect(typeKeys(atSecond, ["("]).cursor).toEqual({ row: 0, col: 0 });
});

test("* / # search the keyword under the cursor (whole-word)", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["foo bar foobar foo"]), {
    row: 0,
    col: 0,
  });
  const starred = typeKeys(start, ["*"]);
  expect(starred.cursor).toEqual({ row: 0, col: 15 });
  expect(starred.lastSearch).toEqual({ needle: "foo", direction: "forward", wholeWord: true });
  // Wrap: next *n from the second foo returns to the first.
  expect(typeKeys(start, ["*", "n"]).cursor).toEqual({ row: 0, col: 0 });

  const hashed = typeKeys(
    seedBuffer(initialEditor(), bufferFromLines(["foo bar foo"]), { row: 0, col: 8 }),
    ["#"],
  );
  expect(hashed.cursor).toEqual({ row: 0, col: 0 });
  expect(hashed.lastSearch?.direction).toBe("backward");
});

test("g* / g# search without whole-word bounds", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["foo bar foobar"]), {
    row: 0,
    col: 0,
  });
  const next = typeKeys(start, ["g", "*"]);
  expect(next.cursor).toEqual({ row: 0, col: 8 }); // foobar
  expect(next.lastSearch).toEqual({ needle: "foo", direction: "forward", wholeWord: false });
});

// ---------------------------------------------------------------------------
// CUA / modeless profile (ep-b64a91 / ts-e7d63c)
// ---------------------------------------------------------------------------

function withCua(state: EditorState): EditorState {
  return {
    ...state,
    mode: "insert",
    options: { ...state.options, keyProfile: "cua" },
  };
}

test("CUA types and navigates without entering vim insert", () => {
  const start = withCua(seedBuffer(initialEditor(), bufferFromLines(["ab"]), { row: 0, col: 0 }));
  const typed = typeKeys(start, ["x", "y"]);
  expect(typed.mode).toBe("insert");
  expect(text(typed)).toBe("xyab");
  expect(typed.cursor).toEqual({ row: 0, col: 2 });
  const moved = typeKeys(typed, ["left", "left", "end"]);
  expect(moved.cursor).toEqual({ row: 0, col: 4 });
  const still = typeKeys(moved, ["escape", "z"]);
  expect(still.mode).toBe("insert");
  expect(text(still)).toBe("xyabz");
});

test("readline Ctrl-a/e/k work in vim insert; CUA uses Home + Ctrl-e/k", () => {
  const vim = typeKeys(
    seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 3 }),
    ["i", key("e", { ctrl: true })],
  );
  expect(vim.cursor).toEqual({ row: 0, col: 6 });
  const killed = typeKeys(
    seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 3 }),
    ["i", key("a", { ctrl: true }), key("k", { ctrl: true }), "escape"],
  );
  expect(text(killed)).toBe("");

  // CUA: Ctrl+A is select-all; line start is Home.
  const cua = typeKeys(
    withCua(seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 3 })),
    ["home", key("k", { ctrl: true })],
  );
  expect(text(cua)).toBe("");
  expect(cua.mode).toBe("insert");
});

test("CUA Delete removes forward; Ctrl-z undoes", () => {
  const start = withCua(seedBuffer(initialEditor(), bufferFromLines(["abcd"]), { row: 0, col: 1 }));
  const deleted = typeKeys(start, ["delete"]);
  expect(text(deleted)).toBe("acd");
  const undone = typeKeys(deleted, [key("z", { ctrl: true })]);
  expect(text(undone)).toBe("abcd");
});

test("CUA loaded file opens in insert mode", () => {
  const loaded = reduceEditor(withCua(initialEditor()), {
    _tag: "loaded",
    file: "/tmp/x",
    lines: ["hi"],
  });
  expect(loaded.mode).toBe("insert");
  expect(text(loaded)).toBe("hi");
});

test("CUA Shift-select, copy, cut, paste, and typing replace", () => {
  const start = withCua(
    seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 1 }),
  );
  const selected = typeKeys(start, [
    key("right", { shift: true }),
    key("right", { shift: true }),
    key("right", { shift: true }),
  ]);
  expect(selected.visual?.anchor).toEqual({ row: 0, col: 1 });
  expect(selected.cursor).toEqual({ row: 0, col: 4 });

  const copied = typeKeys(selected, [key("c", { ctrl: true })]);
  expect(copied.registers["+"]?.text).toEqual(["bcd"]);
  expect(copied.request).toEqual({
    _tag: "clipboard",
    text: "bcd",
    target: "clipboard",
  });
  expect(copied.visual?.anchor).toEqual({ row: 0, col: 1 });
  expect(text(copied)).toBe("abcdef");

  const cut = typeKeys(copied, [key("x", { ctrl: true })]);
  expect(text(cut)).toBe("aef");
  expect(cut.visual).toBeNull();
  expect(cut.registers["+"]?.text).toEqual(["bcd"]);

  const pasted = typeKeys(cut, [key("v", { ctrl: true })]);
  expect(text(pasted)).toBe("abcdef");

  const reselect = typeKeys(
    withCua(seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 0 })),
    [
      key("right", { shift: true }),
      key("right", { shift: true }),
      key("right", { shift: true }),
      "Z",
    ],
  );
  expect(text(reselect)).toBe("Zdef");
  expect(reselect.visual).toBeNull();
});

test("CUA Ctrl-a selects all; Escape clears selection", () => {
  const start = withCua(
    seedBuffer(initialEditor(), bufferFromLines(["ab", "cd"]), { row: 0, col: 1 }),
  );
  const all = typeKeys(start, [key("a", { ctrl: true })]);
  expect(all.visual?.anchor).toEqual({ row: 0, col: 0 });
  expect(all.cursor).toEqual({ row: 1, col: 2 });
  const cleared = typeKeys(all, ["escape"]);
  expect(cleared.visual).toBeNull();
  expect(cleared.mode).toBe("insert");
  expect(text(cleared)).toBe("ab\ncd");
});

test("applySurround wraps the word under the cursor", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["hello world"]), {
    row: 0,
    col: 0,
  });
  const wrapped = applySurround(start, ")");
  expect(text(wrapped)).toBe("(hello) world");
  expect(wrapped.pendingSurround).toBeNull();
});

test("applySurround wraps a CUA selection", () => {
  const start = withCua(
    seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 1 }),
  );
  const selected = typeKeys(start, [
    key("right", { shift: true }),
    key("right", { shift: true }),
    key("right", { shift: true }),
  ]);
  const wrapped = applySurround(selected, '"');
  expect(text(wrapped)).toBe('a"bcd"ef');
  expect(wrapped.visual).toBeNull();
  expect(wrapped.mode).toBe("insert");
});

test("beginSurround waits for a delimiter then wraps", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["word"]), { row: 0, col: 0 });
  const armed = beginSurround(start);
  expect(armed.pendingSurround?.mode).toBe("add");
  expect(armed.message).toContain("delimiter");
  const wrapped = typeKeys(armed, [")"]);
  expect(text(wrapped)).toBe("(word)");
});

test("beginSearch under CUA opens / and returns to insert", () => {
  const start = withCua(
    seedBuffer(initialEditor(), bufferFromLines(["alpha", "beta"]), { row: 0, col: 0 }),
  );
  const searching = beginSearch(start, "forward");
  expect(searching.mode).toBe("search");
  const done = typeKeys(searching, ["b", "e", "t", "a", "return"]);
  expect(done.mode).toBe("insert");
  expect(done.cursor).toEqual({ row: 1, col: 0 });
  expect(done.lastSearch?.needle).toBe("beta");
});

test("beginSubstitute under CUA prefills :%s/ and runs :s", () => {
  const start = withCua(
    seedBuffer(initialEditor(), bufferFromLines(["foo bar foo"]), { row: 0, col: 0 }),
  );
  const cmd = beginSubstitute(start);
  expect(cmd.mode).toBe("command");
  expect(cmd.command).toBe("%s/");
  const done = typeKeys(cmd, ["f", "o", "o", "/", "x", "/", "g", "return"]);
  expect(text(done)).toBe("x bar x");
  expect(done.mode).toBe("insert");
});

const nomod = (state: EditorState): EditorState => ({ ...state, nomodifiable: true });

test(":set nomodifiable and :set modifiable toggle the flag", () => {
  const start = seedBuffer(initialEditor(), bufferFromLines(["abc"]), { row: 0, col: 0 });
  const off = typeKeys(start, [":", ..."set nomodifiable".split(""), "return"]);
  expect(off.nomodifiable).toBe(true);
  const on = typeKeys(off, [":", ..."set modifiable".split(""), "return"]);
  expect(on.nomodifiable).toBe(false);
});

test("nomodifiable refuses mutating operators and keeps the buffer", () => {
  const base = nomod(
    seedBuffer(initialEditor(), bufferFromLines(["hello world", "second"]), {
      row: 0,
      col: 1,
    }),
  );
  const cases: string[][] = [
    ["x"],
    ["X"],
    ["d", "d"],
    ["d", "w"],
    ["c", "w"],
    ["C"],
    ["D"],
    ["r"],
    ["R"],
    ["~"],
    ["i"],
    ["a"],
    ["A"],
    ["I"],
    ["o"],
    ["O"],
    ["J"],
    [">", ">"],
    ["<", "<"],
    ["=", "="],
  ];
  for (const keys of cases) {
    const next = typeKeys(base, keys);
    expect(text(next)).toBe("hello world\nsecond");
    expect(next.message).toBe("E21: Cannot make changes, 'modifiable' is off");
    expect(next.mode).toBe("normal");
    expect(next.nomodifiable).toBe(true);
  }

  // p/P need a filled register; yank while modifiable, then lock and paste.
  const withYank = typeKeys(
    seedBuffer(initialEditor(), bufferFromLines(["hello world"]), { row: 0, col: 0 }),
    ["y", "y"],
  );
  const locked = nomod(withYank);
  for (const keyName of ["p", "P"] as const) {
    const next = typeKeys(locked, [keyName]);
    expect(text(next)).toBe("hello world");
    expect(next.message).toBe("E21: Cannot make changes, 'modifiable' is off");
  }
});

test("nomodifiable still allows motions, search, visual, and yank", () => {
  const start = nomod(
    seedBuffer(initialEditor(), bufferFromLines(["alpha", "bravo", "charlie"]), {
      row: 0,
      col: 0,
    }),
  );
  const moved = typeKeys(start, ["j", "l"]);
  expect(moved.cursor).toEqual({ row: 1, col: 1 });
  expect(text(moved)).toBe("alpha\nbravo\ncharlie");
  expect(moved.message).toBeNull();

  const searched = typeKeys(start, ["/", "c", "h", "a", "return"]);
  expect(searched.cursor).toEqual({ row: 2, col: 0 });
  expect(text(searched)).toBe("alpha\nbravo\ncharlie");

  const visual = typeKeys(start, ["v", "l", "l"]);
  expect(visual.mode).toBe("visual");
  expect(text(visual)).toBe("alpha\nbravo\ncharlie");

  const yanked = typeKeys(start, ["y", "y"]);
  expect(text(yanked)).toBe("alpha\nbravo\ncharlie");
  expect(yanked.message).toContain("yanked");
  expect(yanked.nomodifiable).toBe(true);
});

test("nomodifiable refuses visual delete but allows visual yank", () => {
  const start = nomod(seedBuffer(initialEditor(), bufferFromLines(["abcdef"]), { row: 0, col: 0 }));
  const deleted = typeKeys(start, ["v", "l", "l", "d"]);
  expect(text(deleted)).toBe("abcdef");
  expect(deleted.message).toBe("E21: Cannot make changes, 'modifiable' is off");

  const yanked = typeKeys(start, ["v", "l", "l", "y"]);
  expect(text(yanked)).toBe("abcdef");
  expect(yanked.message).toContain("yanked");
});

test("nomodifiable refuses :substitute", () => {
  const start = nomod(
    seedBuffer(initialEditor(), bufferFromLines(["foo bar"]), { row: 0, col: 0 }),
  );
  const next = typeKeys(start, [":", ..."%s/foo/baz/g".split(""), "return"]);
  expect(text(next)).toBe("foo bar");
  expect(next.message).toBe("E21: Cannot make changes, 'modifiable' is off");
});
