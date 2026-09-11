/**
 * Daily-driver vim slices A–E helpers — marks/jumps, viewport scroll,
 * case/indent, insert-mode edits, and macros. Called from vim-core.
 */
import type { KeyEvent } from "@opentui/core";
import type { CaseKind, Cursor, EditorState, LastVisual, MotionForce } from "./schema.ts";
import {
  changeNewer,
  changeOlder,
  emptyChangeList,
  emptyJumpList,
  jumpNewer,
  jumpOlder,
  pushChange,
  pushJump,
} from "./jumps.ts";
import { exclusiveEnd, firstNonBlank, wordBackwardSmall, type MotionRange } from "./motions.ts";
import {
  editDelete,
  editInsert,
  editReplaceLines,
  lineAtRow,
  linesOf,
  rowCount,
} from "./buffer-state.ts";
import { appendChangeKey } from "./history.ts";
import { readRegister } from "./registers.ts";

export {
  emptyChangeList,
  emptyJumpList,
  pushChange,
  pushJump,
  jumpOlder,
  jumpNewer,
  changeOlder,
  changeNewer,
};

export { isRegisterName } from "./registers.ts";

export const initialSliceState = () =>
  ({
    marks: {} as Readonly<Record<string, Cursor>>,
    jumpList: emptyJumpList(),
    changeList: emptyChangeList(),
    lastInsert: null as Cursor | null,
    lastVisual: null as LastVisual | null,
    pendingMark: false,
    pendingJump: null as "'" | "`" | null,
    pendingCase: null as EditorState["pendingCase"],
    pendingEqual: null as EditorState["pendingEqual"],
    pendingInsertReg: false,
    insertCtrlO: false,
    insertAccum: "",
    pendingRegister: "",
    pendingMacro: false,
    pendingAt: false,
    macroReg: null as string | null,
    macroKeys: [] as readonly string[],
    macros: {} as Readonly<Record<string, readonly string[]>>,
    lastMacro: null as string | null,
    replayingMacro: false,
  }) as const;

// ---------------------------------------------------------------------------
// Marks / jumps
// ---------------------------------------------------------------------------

export const setMark = (state: EditorState, name: string): EditorState => {
  if (!/^[a-z]$/.test(name)) {
    return { ...state, pendingMark: false, message: null };
  }
  return {
    ...state,
    marks: { ...state.marks, [name]: { ...state.cursor } },
    pendingMark: false,
    message: null,
  };
};

const firstNonBlankCol = (state: EditorState, row: number): number =>
  firstNonBlank({
    lines: linesOf(state.buffer),
    cursor: { row, col: 0 },
    count: 1,
    curswant: state.curswant,
    viewport: state.viewport,
  }).col;

export const jumpToMark = (state: EditorState, name: string, linewise: boolean): EditorState => {
  const cleared = { ...state, pendingJump: null as "'" | "`" | null, message: null };
  if (name === "'" || name === "`") {
    const walked = jumpOlder(state.jumpList, state.cursor);
    if (walked === null) return cleared;
    const cursor = linewise
      ? { row: walked.cursor.row, col: firstNonBlankCol(state, walked.cursor.row) }
      : walked.cursor;
    return { ...cleared, jumpList: walked.list, cursor };
  }
  const mark = state.marks[name];
  if (mark === undefined) return { ...cleared, message: `mark '${name}' not set` };
  const withJump = { ...cleared, jumpList: pushJump(state.jumpList, state.cursor) };
  const cursor = linewise ? { row: mark.row, col: firstNonBlankCol(state, mark.row) } : { ...mark };
  return { ...withJump, cursor };
};

export const walkJump = (state: EditorState, dir: "older" | "newer"): EditorState => {
  const walked =
    dir === "older" ? jumpOlder(state.jumpList, state.cursor) : jumpNewer(state.jumpList);
  if (walked === null) return { ...state, message: null };
  return { ...state, jumpList: walked.list, cursor: walked.cursor, count: "", message: null };
};

export const walkChange = (state: EditorState, dir: "older" | "newer"): EditorState => {
  const walked = dir === "older" ? changeOlder(state.changeList) : changeNewer(state.changeList);
  if (walked === null) return { ...state, mapKeys: [], message: null };
  return {
    ...state,
    mapKeys: [],
    changeList: walked.list,
    cursor: walked.cursor,
    count: "",
    message: null,
  };
};

/** Motions that push the jump list before moving (nvim jumplist setters). */
export const isJumpMotionKey = (name: string): boolean =>
  name === "G" ||
  name === "H" ||
  name === "M" ||
  name === "L" ||
  name === "%" ||
  name === "percent" ||
  name === "percentOfFile" ||
  name === "firstLine";

export const rememberVisual = (state: EditorState): EditorState => {
  if (state.visual === null) return state;
  return {
    ...state,
    lastVisual: {
      kind: state.visual.kind,
      anchor: { ...state.visual.anchor },
      cursor: { ...state.cursor },
    },
  };
};

export const restoreVisual = (state: EditorState): EditorState => {
  const last = state.lastVisual;
  if (last === null) return { ...state, mapKeys: [], message: null };
  return {
    ...state,
    mapKeys: [],
    mode: "visual",
    visual: { kind: last.kind, anchor: { ...last.anchor } },
    cursor: { ...last.cursor },
    count: "",
    message: null,
  };
};

export const resumeInsert = (state: EditorState): EditorState => {
  const at = state.lastInsert ?? state.cursor;
  const line = lineAtRow(state.buffer, at.row);
  const col = Math.min(at.col, line.length);
  return {
    ...state,
    mapKeys: [],
    mode: "insert",
    cursor: { row: at.row, col },
    count: "",
    insertAccum: "",
    message: null,
  };
};

/** Leave visual: remember selection for `gv`, then clear visual state. */
export const leaveVisual = (state: EditorState): EditorState => {
  const remembered = rememberVisual(state);
  return {
    ...remembered,
    mode: "normal",
    visual: null,
    pending: null,
    count: "",
    message: null,
  };
};

/** `o` / `O` in visual — swap cursor and anchor. */
export const swapVisualEnds = (state: EditorState): EditorState => {
  if (state.visual === null) return state;
  return {
    ...state,
    cursor: { ...state.visual.anchor },
    visual: { ...state.visual, anchor: { ...state.cursor } },
    message: null,
  };
};

// ---------------------------------------------------------------------------
// Viewport scroll (Ctrl-e/y, zz/zt/zb)
// ---------------------------------------------------------------------------

export const scrollViewport = (state: EditorState, delta: number): EditorState => {
  const maxTop = Math.max(0, rowCount(state.buffer) - state.viewport.height);
  const top = Math.max(0, Math.min(maxTop, state.viewport.top + delta));
  // Keep the cursor inside the viewport when it would scroll off.
  let cursor = state.cursor;
  if (cursor.row < top) cursor = { ...cursor, row: top };
  if (cursor.row >= top + state.viewport.height) {
    cursor = { ...cursor, row: top + state.viewport.height - 1 };
  }
  return {
    ...state,
    viewport: { ...state.viewport, top },
    cursor,
    count: "",
    message: null,
  };
};

/**
 * Resize / follow-cursor without recentering (vim default). `zz` uses
 * `snapViewport` instead. Cite: checklist B Ctrl-e/y must stick across keys.
 */
export const fitViewport = (state: EditorState, height: number): EditorState => {
  const rows = Math.max(1, height);
  const n = rowCount(state.buffer);
  const maxTop = Math.max(0, n - rows);
  let top = Math.max(0, Math.min(state.viewport.top, maxTop));
  if (state.cursor.row < top) top = state.cursor.row;
  if (state.cursor.row >= top + rows) top = state.cursor.row - rows + 1;
  top = Math.max(0, Math.min(top, maxTop));
  if (state.viewport.top === top && state.viewport.height === rows) return state;
  return { ...state, viewport: { top, height: rows } };
};

export const snapViewport = (
  state: EditorState,
  where: "middle" | "top" | "bottom",
): EditorState => {
  const h = Math.max(1, state.viewport.height);
  const maxTop = Math.max(0, rowCount(state.buffer) - h);
  let top: number;
  if (where === "top") top = state.cursor.row;
  else if (where === "bottom") top = state.cursor.row - h + 1;
  else top = state.cursor.row - Math.floor((h - 1) / 2);
  top = Math.max(0, Math.min(maxTop, top));
  return {
    ...state,
    viewport: { ...state.viewport, top },
    mapKeys: [],
    count: "",
    message: null,
  };
};

// ---------------------------------------------------------------------------
// Case + autoindent
// ---------------------------------------------------------------------------

const mapCase = (ch: string, kind: CaseKind): string => {
  if (kind === "lower") return ch.toLowerCase();
  if (kind === "upper") return ch.toUpperCase();
  return ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
};

export const toggleCaseChars = (state: EditorState, count: number): EditorState => {
  const { row, col } = state.cursor;
  const line = lineAtRow(state.buffer, row);
  const n = Math.min(count, Math.max(0, line.length - col));
  if (n === 0) return { ...state, count: "", message: null };
  let out = "";
  for (let i = 0; i < n; i++) out += mapCase(line[col + i]!, "toggle");
  const next = editDelete(state, { row, col }, { row, col: col + n });
  const inserted = editInsert(next, row, col, out);
  return {
    ...inserted,
    cursor: { row, col: Math.min(col + n, lineAtRow(inserted.buffer, row).length) },
    count: "",
    message: null,
  };
};

export const applyCaseRange = (
  state: EditorState,
  range: MotionRange,
  kind: CaseKind,
): EditorState => {
  const lines = linesOf(state.buffer);
  if (range.linewise) {
    const start = Math.min(range.from.row, range.to.row);
    const end = Math.max(range.from.row, range.to.row);
    const next = lines
      .slice(start, end + 1)
      .map((line) => [...line].map((ch) => mapCase(ch, kind)).join(""));
    return {
      ...editReplaceLines(state, start, end + 1, next),
      cursor: { row: start, col: 0 },
      pendingCase: null,
      count: "",
      message: null,
    };
  }
  const end = exclusiveEnd(range, lines);
  const text = rangeText(state, { ...range, to: end, inclusive: false });
  const mapped = text.map((line) => [...line].map((ch) => mapCase(ch, kind)).join(""));
  const deleted = editDelete(state, range.from, end);
  const joined = mapped.join("\n");
  const inserted = editInsert(deleted, range.from.row, range.from.col, joined);
  return {
    ...inserted,
    cursor: range.from,
    pendingCase: null,
    count: "",
    message: null,
  };
};

const leadingWs = (line: string): string => {
  const m = line.match(/^[\t ]*/);
  return m?.[0] ?? "";
};

/** Naive `=`: copy indent from the nearest non-blank line above. */
export const autoIndentRows = (state: EditorState, fromRow: number, toRow: number): EditorState => {
  const start = Math.max(0, Math.min(fromRow, toRow));
  const end = Math.min(rowCount(state.buffer) - 1, Math.max(fromRow, toRow));
  const lines = linesOf(state.buffer);
  let indent = "";
  for (let r = start - 1; r >= 0; r--) {
    if (lines[r]!.trim().length > 0) {
      indent = leadingWs(lines[r]!);
      break;
    }
  }
  const next = lines.slice(start, end + 1).map((line) => {
    if (line.trim().length === 0) return line;
    return indent + line.replace(/^[\t ]*/, "");
  });
  return {
    ...editReplaceLines(state, start, end + 1, next),
    cursor: { row: start, col: 0 },
    pendingEqual: null,
    count: "",
    message: null,
  };
};

function rangeText(state: EditorState, range: MotionRange): string[] {
  const lines = linesOf(state.buffer);
  if (range.linewise) return [...lines.slice(range.from.row, range.to.row + 1)];
  if (range.from.row === range.to.row) {
    return [lines[range.from.row]!.slice(range.from.col, range.to.col)];
  }
  const out: string[] = [];
  out.push(lines[range.from.row]!.slice(range.from.col));
  for (let row = range.from.row + 1; row < range.to.row; row++) out.push(lines[row]!);
  out.push(lines[range.to.row]!.slice(0, range.to.col));
  return out;
}

/** Linewise span covering a motion — used by `=` / `g~` line forms. */
export type LinewiseSpan = { readonly from: number; readonly to: number };

export const linewiseSpan = (range: MotionRange): LinewiseSpan => ({
  from: Math.min(range.from.row, range.to.row),
  to: Math.max(range.from.row, range.to.row),
});

// ---------------------------------------------------------------------------
// Insert-mode editing (slice D)
// ---------------------------------------------------------------------------

const INSERT_TAB = "  ";

/** Ctrl-r {reg}: insert register text at the cursor. */
export const insertPasteRegister = (state: EditorState, reg: string): EditorState => {
  const text = readRegister(state, reg).text.join("\n");
  const cleared = { ...state, pendingInsertReg: false, message: null };
  if (text.length === 0) return cleared;
  const { row, col } = cleared.cursor;
  let next = editInsert(cleared, row, col, text);
  // Record pasted glyphs so `.` replays the inserted text, not Ctrl-r.
  for (const ch of text) {
    if (ch === "\n") continue;
    next = appendChangeKey(next, ch);
  }
  const parts = text.split("\n");
  const last = parts[parts.length - 1] ?? "";
  const cursor =
    parts.length === 1
      ? { row, col: col + text.length }
      : { row: row + parts.length - 1, col: last.length };
  return { ...next, cursor };
};

/** Ctrl-w: delete the word before the cursor (may cross a line boundary). */
export const insertDeleteWord = (state: EditorState): EditorState => {
  const { row, col } = state.cursor;
  if (row === 0 && col === 0) return state;
  const start = wordBackwardSmall({
    lines: linesOf(state.buffer),
    cursor: { row, col },
    count: 1,
    curswant: state.curswant,
    viewport: state.viewport,
  });
  if (start.row === row && start.col === col) return state;
  return {
    ...editDelete(state, start, { row, col }),
    cursor: start,
    message: null,
  };
};

/** Ctrl-u: clear from line start to the cursor. */
export const insertClearLineStart = (state: EditorState): EditorState => {
  const { row, col } = state.cursor;
  if (col === 0) return state;
  return {
    ...editDelete(state, { row, col: 0 }, { row, col }),
    cursor: { row, col: 0 },
    message: null,
  };
};

/** Ctrl-k (readline): clear from the cursor to end of line. */
export const insertClearLineEnd = (state: EditorState): EditorState => {
  const { row, col } = state.cursor;
  const line = lineAtRow(state.buffer, row);
  if (col >= line.length) return state;
  return {
    ...editDelete(state, { row, col }, { row, col: line.length }),
    cursor: { row, col },
    message: null,
  };
};

/** Ctrl-t / Ctrl-d: add/remove one indent unit at the start of the line. */
export const insertShiftIndent = (state: EditorState, dir: 1 | -1): EditorState => {
  const { row, col } = state.cursor;
  const line = lineAtRow(state.buffer, row);
  if (dir === 1) {
    return {
      ...editReplaceLines(state, row, row + 1, [INSERT_TAB + line]),
      cursor: { row, col: col + INSERT_TAB.length },
      message: null,
    };
  }
  let removed = 0;
  let stripped = line;
  if (line.startsWith(INSERT_TAB)) {
    stripped = line.slice(INSERT_TAB.length);
    removed = INSERT_TAB.length;
  } else if (line.startsWith("\t")) {
    stripped = line.slice(1);
    removed = 1;
  } else if (line.startsWith(" ")) {
    stripped = line.slice(1);
    removed = 1;
  } else {
    return state;
  }
  return {
    ...editReplaceLines(state, row, row + 1, [stripped]),
    cursor: { row, col: Math.max(0, col - removed) },
    message: null,
  };
};

/**
 * Ctrl-o: drop to normal for one command without sealing the insert change.
 * Cursor steps back like Esc so normal mode sits on a real character.
 */
export const armInsertCtrlO = (state: EditorState): EditorState => ({
  ...state,
  mode: "normal",
  insertCtrlO: true,
  cursor: { ...state.cursor, col: Math.max(0, state.cursor.col - 1) },
  message: null,
});

/** True while an incomplete normal-mode sequence is still armed. */
export const hasArmedInput = (state: EditorState): boolean =>
  state.pending !== null ||
  state.pendingSurround !== null ||
  state.pendingReplace !== null ||
  state.pendingIndent !== null ||
  state.mapKeys.length > 0 ||
  state.pendingFind !== null ||
  state.pendingMark ||
  state.pendingJump !== null ||
  state.pendingCase !== null ||
  state.pendingEqual !== null ||
  state.pendingMacro ||
  state.pendingAt ||
  state.pendingRegister !== "" ||
  state.count !== "" ||
  state.mode === "visual" ||
  state.mode === "search" ||
  state.mode === "command" ||
  state.mode === "replace";

/**
 * After a Ctrl-o command settles (no pending input, back in normal), resume
 * insert just after the normal-mode cursor — undoing the Esc-style step-back.
 * Only runs on a keystroke that began with Ctrl-o already armed (not the
 * arming key itself).
 */
export const maybeResumeAfterCtrlO = (before: EditorState, state: EditorState): EditorState => {
  if (!before.insertCtrlO) return state;
  if (!state.insertCtrlO) return state;
  if (state.mode !== "normal") return state;
  if (hasArmedInput(state)) return state;
  const line = lineAtRow(state.buffer, state.cursor.row);
  return {
    ...state,
    mode: "insert",
    insertCtrlO: false,
    cursor: {
      row: state.cursor.row,
      col: Math.min(state.cursor.col + 1, line.length),
    },
    message: null,
  };
};

// ---------------------------------------------------------------------------
// Macros (slice E) — separate from `.` `recording`
// ---------------------------------------------------------------------------

export const encodeKey = (key: KeyEvent): string | null => {
  if (key.eventType === "release") return null;
  if (key.ctrl) {
    if (!key.name || key.name.length === 0) return null;
    return `ctrl+${key.name}`;
  }
  if (key.meta || key.option) return null;
  if (key.name === "escape") return "escape";
  if (key.name === "return" || key.name === "enter") return "return";
  if (key.name === "backspace") return "backspace";
  if (key.name === "tab") return "tab";
  if (key.name === "space" && key.sequence === " ") return " ";
  const char =
    key.sequence && [...key.sequence].length === 1
      ? key.sequence
      : key.name && key.name.length === 1
        ? key.name
        : null;
  return char;
};

export const startMacro = (state: EditorState, reg: string): EditorState => {
  if (!/^[a-z]$/.test(reg)) {
    return { ...state, pendingMacro: false, message: null };
  }
  return {
    ...state,
    pendingMacro: false,
    macroReg: reg,
    macroKeys: [],
    message: `recording @${reg}`,
  };
};

export const stopMacro = (state: EditorState): EditorState => {
  if (state.macroReg === null) return { ...state, pendingMacro: false };
  const reg = state.macroReg;
  return {
    ...state,
    macros: { ...state.macros, [reg]: state.macroKeys },
    macroReg: null,
    macroKeys: [],
    pendingMacro: false,
    message: null,
  };
};

export const appendMacroKey = (state: EditorState, key: string): EditorState => {
  if (state.macroReg === null || state.replayingMacro) return state;
  return { ...state, macroKeys: [...state.macroKeys, key] };
};

export type { CaseKind, MotionForce };
