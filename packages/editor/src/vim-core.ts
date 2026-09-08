/**
 * The vim state machine the editor plugin runs — pure, renderer-free, and the
 * part "much will depend on". The plugin shell only feeds it key events and
 * file-load/write outcomes; every rule of normal/insert/command mode lives here
 * so the mode-switching behaviour is testable without a screen.
 *
 * State is replaced, never mutated: each transition returns a fresh object.
 * Requests are how the shell learns what to do (read a file, write one, close
 * the panel); the shell fulfils them and reports back through the `loaded` /
 * `written` / `write-error` events, which are themselves transitions.
 *
 * The data model lives in `./schema.ts`; this file owns the reducer.
 */
import type { KeyEvent } from "@opentui/core";
import { allMotions, applyMotion, type Motion, type MotionRange } from "./motions.ts";
import type { EditorEvent, EditorMode, EditorState, OperatorKind } from "./schema.ts";

// ---------------------------------------------------------------------------
// Public state factory
// ---------------------------------------------------------------------------

/** An editor with no file: a scratch buffer rooted at the workspace. */
export function initialEditor(): EditorState {
  return {
    mode: "normal",
    lines: [""],
    cursor: { row: 0, col: 0 },
    command: "",
    file: null,
    dirty: false,
    message: null,
    request: null,
    count: "",
    pendingG: false,
    pending: null,
    register: { text: [], linewise: false },
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Feed one event into the state machine and get the next state. */
export function reduceEditor(state: EditorState, event: EditorEvent): EditorState {
  switch (event._tag) {
    case "key":
      return onKey(state, event.key);
    case "loaded":
      return {
        ...state,
        mode: "normal",
        lines: event.lines.length > 0 ? event.lines : [""],
        cursor: { row: 0, col: 0 },
        file: event.file,
        dirty: false,
        command: "",
        message: `${event.lines.length} ${event.lines.length === 1 ? "line" : "lines"}`,
        request: null,
        count: "",
        pendingG: false,
        pending: null,
      };
    case "written":
      return {
        ...state,
        dirty: false,
        message: `"${state.file ?? "buffer"}" written`,
        request: null,
      };
    case "write-error":
      return { ...state, dirty: true, message: event.message, request: null };
  }
}

function onKey(state: EditorState, key: KeyEvent): EditorState {
  // A request is a one-shot instruction to the shell. Only `:wq`-style
  // execution produces one; any other key must not carry a stale request
  // forward, or the shell would fulfil it again. executeCommand sets the new
  // one after this spread.
  const base = { ...state, request: null };
  if (base.mode === "insert") return insertKey(base, key);
  if (base.mode === "command") return commandKey(base, key);
  return normalKey(base, key);
}

/**
 * The printable character a keypress carries, or null.
 *
 * Named control keys (enter, backspace…) come back null so their callers switch
 * on `key.name` instead. OpenTUI calls printable space `space`, however, so it
 * is the named-key exception. The parser reports capitals as lowercase names
 * plus a shift flag, so the *character* has to come from `sequence`, which
 * carries the actual glyph. Releases and ctrl/meta combos are never text.
 */
export function charFromKey(key: KeyEvent): string | null {
  if (key.eventType === "release") return null;
  if (key.ctrl || key.meta || key.option) return null;
  if (key.name === "space" && key.sequence === " ") return " ";
  const name = key.name;
  if (!name || name.length > 1) return null;
  const sequence = key.sequence;
  return sequence && [...sequence].length === 1 ? sequence : name;
}

// ---------------------------------------------------------------------------
// Normal mode
// ---------------------------------------------------------------------------

function normalKey(state: EditorState, key: KeyEvent): EditorState {
  // Esc clears anything pending — operator, count, or gg. After escape the
  // next keystroke starts a fresh sequence.
  if (key.name === "escape") return cancelPendingOnEscape(state);

  // An armed operator consumes the next motion or text object.
  if (state.pending) return continueOperator(state, key);

  // Two-key `gg` is a motion, so it composes with operators just like the
  // others. It only fires in normal mode and only with no pendingG flag set.
  if (state.pendingG) return continueGPrefix(state, key);

  if (isCountDigit(state, key)) {
    return { ...state, count: state.count === "0" ? key.name : state.count + key.name };
  }

  return dispatchNormalKey(state, key);
}

const cancelPendingOnEscape = (state: EditorState): EditorState => {
  if (state.pending || state.pendingG || state.count !== "")
    return { ...state, pending: null, pendingG: false, count: "", message: null };
  return { ...state, message: null };
};

const continueOperator = (state: EditorState, key: KeyEvent): EditorState => {
  const pending = state.pending!;
  // `d i` / `d a` — promote to text-object wait; the following key names
  // the symbol (w, p, (, ", etc.).
  if (!("textObject" in pending) && (key.name === "i" || key.name === "a")) {
    return {
      ...state,
      pending: {
        kind: pending.kind,
        count: pending.count,
        textObject: key.name === "i" ? "inner" : "outer",
      },
    };
  }
  const range = resolveMotion(state, key);
  if (range === null) return unknownKey(state, key.name);
  return applyOperator(state, range.range);
};

const continueGPrefix = (state: EditorState, key: KeyEvent): EditorState => {
  if (key.name === "g") {
    const cleared: EditorState = { ...state, pendingG: false, count: "", message: null };
    return moveTo(state, allMotions.firstLine!, cleared);
  }
  // A different second key aborts the gg prefix.
  return normalKey({ ...state, pendingG: false }, key);
};

const dispatchNormalKey = (state: EditorState, key: KeyEvent): EditorState => {
  const motion = singleKeyMotion(key.name);
  if (motion !== undefined) return moveTo(state, motion);
  switch (key.name) {
    case "g":
      return { ...state, pendingG: true, count: "", message: null };
    case "i":
      return enterInsert(state, "here");
    case "a":
      return enterInsert(state, "after");
    case "A":
      return enterInsert(state, "end");
    case "I":
      return enterInsert(state, "start");
    case "o":
      return openLine(state, "below");
    case "O":
      return openLine(state, "above");
    case "x":
      return deleteCharAt(state);
    case "d":
    case "c":
    case "y":
      return armOperator(state, key.name);
    case "p":
      return putAfter(state);
    case "P":
      return putBefore(state);
    case ":":
      return {
        ...state,
        mode: "command",
        command: "",
        count: "",
        message: null,
      };
    case "u":
      return { ...state, message: "undo not implemented" };
    default:
      return unknownKey(state, key.name);
  }
};

type MotionKey = "h" | "j" | "k" | "l" | "w" | "b" | "e" | "0" | "$" | "^" | "G";

const isMotionKey = (name: string): name is MotionKey =>
  name === "h" ||
  name === "j" ||
  name === "k" ||
  name === "l" ||
  name === "w" ||
  name === "b" ||
  name === "e" ||
  name === "0" ||
  name === "$" ||
  name === "^" ||
  name === "G";

const singleKeyMotion = (name: string): Motion | undefined => {
  if (!isMotionKey(name)) return undefined;
  return allMotions[name];
};

/** The count has been filled in; turn it into a number (defaulting to 1)
 *  for the next consumer. */
function parsedCount(state: EditorState): number {
  if (state.count === "") return 1;
  const value = parseInt(state.count, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function isCountDigit(state: EditorState, key: KeyEvent): boolean {
  if (state.pending) return false;
  if (state.pendingG) return false;
  if (key.ctrl || key.meta || key.option) return false;
  if (key.name.length !== 1) return false;
  // A leading zero is itself a motion, not a count. Subsequent digits
  // appended to a non-empty count are still digits.
  if (key.name === "0" && state.count === "") return false;
  return /[0-9]/.test(key.name);
}

function moveTo(state: EditorState, motion: Motion, base = state): EditorState {
  const count = parsedCount(state);
  const next = applyMotion(motion, { lines: state.lines, cursor: state.cursor, count });
  const cleared: EditorState = { ...base, cursor: next.to, count: "", pendingG: false };
  return cleared;
}

function armOperator(state: EditorState, name: string): EditorState {
  // An operator always waits for a motion or text object. `dd`/`cc`/`yy`
  // means "operate on the current line" — we detect that in the motion
  // resolver when the second key matches the operator letter, not here.
  if (state.pending) return unknownKey(state, name);
  return {
    ...state,
    pending: { kind: operatorKind(name), count: parsedCount(state) },
    count: "",
  };
}

const operatorKind = (name: string): OperatorKind =>
  name === "d" ? "delete" : name === "c" ? "change" : "yank";

/** Resolve the next key as a motion or text object against an armed
 *  operator. Returns null for keys that don't constitute a motion. */
function resolveMotion(
  state: EditorState,
  key: KeyEvent,
): { range: MotionRange; message?: string } | null {
  if (key.ctrl || key.meta || key.option) return null;
  if (key.name.length !== 1) return null;

  const pending = state.pending;
  if (pending === null) return null;

  // `dd`, `cc`, `yy` — the operator doubled acts on the current line.
  if (key.name === operatorLetter(pending.kind)) {
    return {
      range: {
        from: { row: state.cursor.row, col: 0 },
        to: {
          row: state.cursor.row,
          col: state.lines[state.cursor.row]!.length,
        },
        linewise: true,
      },
    };
  }

  // After `d i`/`d a` the next key names the text-object symbol.
  if ("textObject" in pending) {
    return readTextObject(state, key, pending.textObject === "inner");
  }

  if (key.name === "G") {
    return {
      range: applyMotion(allMotions.G!, {
        lines: state.lines,
        cursor: state.cursor,
        count: effectiveCount(state),
      }),
    };
  }

  const motion = (allMotions as Record<string, Motion>)[key.name];
  if (motion === undefined) return null;
  return {
    range: applyMotion(motion, {
      lines: state.lines,
      cursor: state.cursor,
      count: effectiveCount(state),
    }),
  };
}

/** The motion's count is the user-typed prefix times the operator's count.
 *  `2dw` = motion count 2; `d2w` = motion count 2; `2d3w` = motion count 6. */
const effectiveCount = (state: EditorState): number => {
  const base = parsedCount(state);
  const pending = state.pending;
  if (pending === null) return base;
  const operatorCount = pending.count;
  return base * operatorCount;
};

const operatorLetter = (kind: OperatorKind): string =>
  kind === "delete" ? "d" : kind === "change" ? "c" : "y";

/** Read the closing character of a text object from the key's sequence.
 *  OpenTUI's `i<` and `a<` arrive as `name: "a"` (or `"i"`) with a
 *  shift-modified sequence carrying the punctuation glyph. */
function readTextObject(
  state: EditorState,
  key: KeyEvent,
  inner: boolean,
): { range: MotionRange; message?: string } | null {
  const symbol = textObjectSymbol(key);
  if (symbol === null) return null;
  const range = textObjectRange(state, symbol, inner);
  if (range === null)
    return {
      range: { from: state.cursor, to: state.cursor, linewise: false },
      message: `no ${inner ? "inner" : "outer"} ${symbol}`,
    };
  return { range };
}

const textObjectSymbol = (key: KeyEvent): string | null => {
  // OpenTUI reports shift+punctuation as name == punctuation with shift
  // true; bare punctuation as name == punctuation, shift false. The sequence
  // carries the printable glyph in both cases.
  const sequence = key.sequence;
  if (sequence && sequence.length === 1) return sequence;
  if (key.shift && key.name.length === 1) return key.name;
  return null;
};

function textObjectRange(state: EditorState, symbol: string, inner: boolean): MotionRange | null {
  if (symbol === "p") return paragraph(state, inner);
  if (symbol === "w") return word(state, inner);
  if ('("{[<'.includes(symbol)) return quote(state, symbol, inner);
  return null;
}

function word(state: EditorState, inner: boolean): MotionRange | null {
  // `iw` covers the word under the cursor; `aw` covers it plus the
  // trailing whitespace, mirroring vim's "whitespace after the word, but
  // not before it" rule.
  const start = applyMotion(allMotions.b!, {
    lines: state.lines,
    cursor: state.cursor,
    count: 1,
  }).to;
  // `e` lands on the last char; for an exclusive `[from, to)` range we
  // need one past, which is also where the trailing whitespace begins.
  const endChar = applyMotion(allMotions.e!, { lines: state.lines, cursor: start, count: 1 }).to;
  if (inner) {
    return { from: start, to: { row: endChar.row, col: endChar.col + 1 }, linewise: false };
  }
  // `aw` extends the range to the start of the next word, or to the next
  // non-empty line when the current word is the last token of the file.
  const line = state.lines[endChar.row]!;
  if (endChar.col + 1 < line.length) {
    // The trailing whitespace lives on this line: skip blanks to land on
    // the next word's first character.
    const advanced = applyMotion(allMotions.w!, {
      lines: state.lines,
      cursor: endChar,
      count: 1,
    }).to;
    return { from: start, to: advanced, linewise: false };
  }
  if (endChar.row < state.lines.length - 1 && state.lines[endChar.row + 1]!.length > 0) {
    return { from: start, to: { row: endChar.row + 1, col: 0 }, linewise: false };
  }
  return { from: start, to: { row: endChar.row, col: endChar.col + 1 }, linewise: false };
}

function paragraph(state: EditorState, _inner: boolean): MotionRange {
  // A paragraph here is the contiguous run of non-empty lines containing
  // the cursor, plus any blank line that separates it from the next
  // paragraph — `dip` on the first paragraph removes the trailing blank
  // so the remaining buffer doesn't grow a stray empty line.
  let start = state.cursor.row;
  while (start > 0 && state.lines[start - 1]!.length > 0) start -= 1;
  let end = state.cursor.row;
  while (end < state.lines.length - 1 && state.lines[end + 1]!.length > 0) end += 1;
  // The range stays linewise, but the linewise delete already removes
  // `end` plus every line in between. Extend `end` to swallow the blank
  // that follows the paragraph when there is one and more content after.
  if (end < state.lines.length - 1 && state.lines[end + 1]!.length === 0) end += 1;
  return {
    from: { row: start, col: 0 },
    to: { row: end, col: state.lines[end]!.length },
    linewise: true,
  };
}

type QuotePair = "(" | "{" | "[" | "<" | '"' | "'";

const isQuotePair = (symbol: string): symbol is QuotePair =>
  symbol === "(" ||
  symbol === "{" ||
  symbol === "[" ||
  symbol === "<" ||
  symbol === '"' ||
  symbol === "'";

const QUOTE_PAIRS = {
  "(": ")",
  "{": "}",
  "[": "]",
  "<": ">",
  '"': '"',
  "'": "'",
} satisfies Record<QuotePair, string>;

function quote(state: EditorState, symbol: string, inner: boolean): MotionRange | null {
  // The symbol the user types is always the open delimiter for a pair.
  // The matching close is the conventional counterpart, and the search is
  // for the open to the left and the close to the right.
  if (!isQuotePair(symbol)) return null;
  const close = QUOTE_PAIRS[symbol];
  const line = state.lines[state.cursor.row]!;
  const from = line.lastIndexOf(symbol, state.cursor.col);
  if (from === -1) return null;
  const to = line.indexOf(close, from + 1);
  if (to === -1 || to <= from) return null;
  if (inner) {
    return {
      from: { row: state.cursor.row, col: from + 1 },
      to: { row: state.cursor.row, col: to },
      linewise: false,
    };
  }
  return {
    from: { row: state.cursor.row, col: from },
    to: { row: state.cursor.row, col: to + 1 },
    linewise: false,
  };
}

function applyOperator(state: EditorState, range: MotionRange): EditorState {
  if (range.from.row === range.to.row && range.from.col === range.to.col) {
    return { ...state, pending: null, message: "no range" };
  }
  const cleared: EditorState = { ...state, pending: null, count: "" };
  switch (state.pending?.kind) {
    case "yank":
      return yankRange(cleared, range);
    case "delete":
      return deleteRange(cleared, range);
    case "change":
      return changeRange(cleared, range);
    default:
      return cleared;
  }
}

function yankRange(state: EditorState, range: MotionRange): EditorState {
  const text = rangeText(state, range);
  return {
    ...state,
    register: { text, linewise: range.linewise },
    cursor: range.from,
    message: `yanked ${describe(text, range.linewise)}`,
  };
}

function deleteRange(state: EditorState, range: MotionRange): EditorState {
  const text = rangeText(state, range);
  const lines = [...state.lines];
  if (range.linewise) {
    lines.splice(range.from.row, range.to.row - range.from.row + 1);
    if (lines.length === 0) lines.push("");
    const cursor = { row: Math.min(range.from.row, lines.length - 1), col: 0 };
    return {
      ...state,
      lines,
      cursor,
      dirty: true,
      register: { text, linewise: true },
      message: `${text.length} fewer lines`,
    };
  }
  // Charwise range is `[from, to)`: the end cursor sits one past the last
  // deleted character. That mirrors vim's word motions, which cover the
  // word plus its trailing space without including the next word's first
  // character.
  const start = lines[range.from.row]!;
  const end = lines[range.to.row]!;
  if (range.from.row === range.to.row) {
    lines[range.from.row] = start.slice(0, range.from.col) + start.slice(range.to.col);
  } else {
    const merged = start.slice(0, range.from.col) + end.slice(range.to.col);
    lines.splice(range.from.row, range.to.row - range.from.row + 1, merged);
  }
  return {
    ...state,
    lines,
    cursor: range.from,
    dirty: true,
    register: { text, linewise: false },
    message: `${text.join("").length} chars deleted`,
  };
}

function changeRange(state: EditorState, range: MotionRange): EditorState {
  // `c` mirrors `d` but stops at the end of the last affected token so the
  // user can keep typing immediately. Word motions (w) include a trailing
  // space in their range; `c` shrinks that off.
  const adjusted = shrinkTrailingSpace(range, state.lines);
  const deleted = deleteRange(state, adjusted);
  return { ...deleted, mode: "insert", message: null };
}

const shrinkTrailingSpace = (range: MotionRange, lines: readonly string[]): MotionRange => {
  if (range.linewise) return range;
  if (range.from.row !== range.to.row) return range;
  const line = lines[range.to.row]!;
  if (range.to.col <= 0) return range;
  const last = line[range.to.col - 1] ?? "";
  if (last !== " " && last !== "\t") return range;
  return { ...range, to: { row: range.to.row, col: range.to.col - 1 } };
};

function rangeText(state: EditorState, range: MotionRange): string[] {
  if (range.linewise) return [...state.lines.slice(range.from.row, range.to.row + 1)];
  if (range.from.row === range.to.row) {
    return [state.lines[range.from.row]!.slice(range.from.col, range.to.col)];
  }
  const out: string[] = [];
  out.push(state.lines[range.from.row]!.slice(range.from.col));
  for (let row = range.from.row + 1; row < range.to.row; row++) {
    out.push(state.lines[row]!);
  }
  out.push(state.lines[range.to.row]!.slice(0, range.to.col));
  return out;
}

function describe(text: string[], linewise: boolean): string {
  if (linewise) return `${text.length} line${text.length === 1 ? "" : "s"}`;
  const chars = text.join("").length;
  return `${chars} char${chars === 1 ? "" : "s"}`;
}

function putAfter(state: EditorState): EditorState {
  return put(state, "after");
}

function putBefore(state: EditorState): EditorState {
  return put(state, "before");
}

/** Place the register on either side of the cursor. Charwise yanks split
 *  the current line at the boundary and insert the yanked text; linewise
 *  yanks splice whole lines above or below the current one. */
function put(state: EditorState, side: "after" | "before"): EditorState {
  const register = state.register;
  if (register.text.length === 0) return state;
  if (register.linewise) {
    const insert = register.text;
    const lines = [...state.lines];
    const targetRow = side === "after" ? state.cursor.row + 1 : state.cursor.row;
    lines.splice(targetRow, 0, ...insert);
    return {
      ...state,
      lines,
      cursor: { row: targetRow, col: 0 },
      dirty: true,
      message: `put ${insert.length} line${insert.length === 1 ? "" : "s"}`,
    };
  }
  const line = state.lines[state.cursor.row]!;
  const split = side === "after" ? state.cursor.col + 1 : state.cursor.col;
  const merged = line.slice(0, split) + register.text.join("\n") + line.slice(split);
  const lines = [...state.lines];
  lines[state.cursor.row] = merged;
  const firstInserted = register.text[0] ?? "";
  const cursorCol = side === "after" ? split + firstInserted.length - 1 : split;
  return {
    ...state,
    lines,
    cursor: { row: state.cursor.row, col: cursorCol },
    dirty: true,
    message: `put ${register.text.join("").length} chars`,
  };
}

function unknownKey(state: EditorState, name: string): EditorState {
  return {
    ...state,
    pending: null,
    pendingG: false,
    count: "",
    message: `not a normal-mode key: ${name}`,
  };
}

function insertCol(
  state: EditorState,
  line: string,
  where: "here" | "after" | "start" | "end",
): number {
  switch (where) {
    case "start":
      return 0;
    case "end":
      return line.length;
    case "after":
      return state.cursor.col + 1;
    case "here":
      return state.cursor.col;
  }
}

function enterInsert(state: EditorState, where: "here" | "after" | "start" | "end"): EditorState {
  const line = state.lines[state.cursor.row]!;
  const col = insertCol(state, line, where);
  return {
    ...state,
    mode: "insert",
    cursor: { row: state.cursor.row, col: clamp(col, 0, line.length) },
    count: "",
    message: null,
  };
}

function openLine(state: EditorState, where: "above" | "below"): EditorState {
  const row = state.cursor.row;
  const lines = [...state.lines];
  lines.splice(where === "above" ? row : row + 1, 0, "");
  return {
    ...state,
    mode: "insert",
    lines,
    cursor: { row: where === "above" ? row : row + 1, col: 0 },
    dirty: true,
    count: "",
    message: null,
  };
}

function deleteCharAt(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  const line = state.lines[row]!;
  if (col >= line.length) return { ...state, message: null };
  const lines = [...state.lines];
  lines[row] = line.slice(0, col) + line.slice(col + 1);
  return { ...state, lines, cursor: { row, col }, dirty: true, message: null };
}

// ---------------------------------------------------------------------------
// Insert mode
// ---------------------------------------------------------------------------

function insertKey(state: EditorState, key: KeyEvent): EditorState {
  if (key.ctrl && key.name === "c") return leaveInsert(state);
  switch (key.name) {
    case "escape":
      return leaveInsert(state);
    case "backspace":
      return insertBackspace(state);
    case "return":
    case "enter":
      return insertNewline(state);
    default: {
      const char = charFromKey(key);
      if (char === null) return state;
      return insertChar(state, char);
    }
  }
}

function leaveInsert(state: EditorState): EditorState {
  return {
    ...state,
    mode: "normal",
    // vim steps the cursor back one column when insert closes; it never walks
    // off the front of a line.
    cursor: { ...state.cursor, col: Math.max(0, state.cursor.col - 1) },
    count: "",
    pendingG: false,
    pending: null,
    message: null,
  };
}

function insertChar(state: EditorState, char: string): EditorState {
  const { row, col } = state.cursor;
  const line = state.lines[row]!;
  const lines = [...state.lines];
  lines[row] = line.slice(0, col) + char + line.slice(col);
  return {
    ...state,
    lines,
    cursor: { row, col: col + char.length },
    dirty: true,
    message: null,
  };
}

function insertNewline(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  const line = state.lines[row]!;
  const lines = [...state.lines];
  lines.splice(row + 1, 0, line.slice(col));
  lines[row] = line.slice(0, col);
  return { ...state, lines, cursor: { row: row + 1, col: 0 }, dirty: true, message: null };
}

function insertBackspace(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  if (col > 0) {
    const lines = [...state.lines];
    const line = lines[row]!;
    lines[row] = line.slice(0, col - 1) + line.slice(col);
    return { ...state, lines, cursor: { row, col: col - 1 }, dirty: true };
  }
  if (row > 0) {
    const lines = [...state.lines];
    const prev = lines[row - 1]!;
    lines[row - 1] = prev + lines[row]!;
    lines.splice(row, 1);
    return { ...state, lines, cursor: { row: row - 1, col: prev.length }, dirty: true };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Command mode
// ---------------------------------------------------------------------------

function commandKey(state: EditorState, key: KeyEvent): EditorState {
  switch (key.name) {
    case "escape":
      return { ...state, mode: "normal", command: "", message: null };
    case "backspace":
      return { ...state, command: state.command.slice(0, -1) };
    case "return":
    case "enter":
      return executeCommand(state);
    default: {
      const char = charFromKey(key);
      if (char === null) return state;
      return { ...state, command: state.command + char };
    }
  }
}

function executeCommand(state: EditorState): EditorState {
  const command = state.command.trim();
  const next = { ...state, mode: "normal" as EditorMode, command: "" };

  if (command === "w") {
    if (state.file === null) return { ...next, message: "no file name (open one with :e path)" };
    return { ...next, request: { _tag: "write" } };
  }
  if (command === "q") {
    if (state.dirty)
      return { ...next, message: "no write since last change (:wq to save and quit)" };
    return { ...next, request: { _tag: "close" } };
  }
  if (command === "q!") {
    return { ...next, request: { _tag: "close" } };
  }
  if (command === "wq" || command === "x") {
    if (state.file === null) return { ...next, message: "no file name (open one with :e path)" };
    return { ...next, request: { _tag: "write-close" } };
  }
  const open = command.match(/^e(?:\s+(.+))?$/);
  if (open) {
    const path = open[1]?.trim();
    if (!path) return { ...next, message: "usage: :e path" };
    return { ...next, request: { _tag: "open", path } };
  }
  return { ...next, message: `not an editor command: ${command}` };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
