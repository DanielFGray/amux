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
 */
import type { KeyEvent } from "@opentui/core";

export type EditorMode = "normal" | "insert" | "command";

export interface Cursor {
  row: number;
  col: number;
}

/** What the shell should do next. Consumed by the plugin, cleared by the
 *  event that reports the outcome. */
export type EditorRequest =
  | { readonly type: "open"; readonly path: string }
  | { readonly type: "write" }
  | { readonly type: "close" }
  | { readonly type: "write-close" };

export interface EditorState {
  mode: EditorMode;
  /** Buffer contents, one string per line, no trailing newline. */
  lines: string[];
  cursor: Cursor;
  /** The ex-command line being typed, without its leading colon. */
  command: string;
  /** Open path, for the status bar and as the write target. */
  file: string | null;
  dirty: boolean;
  /** Transient status line: an error, or "N lines" after a load. */
  message: string | null;
  request: EditorRequest | null;
}

export type EditorEvent =
  | { readonly type: "key"; readonly key: KeyEvent }
  | { readonly type: "loaded"; readonly file: string; readonly lines: string[] }
  | { readonly type: "written" }
  | { readonly type: "write-error"; readonly message: string };

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
  };
}

/** Feed one event into the state machine and get the next state. */
export function reduceEditor(state: EditorState, event: EditorEvent): EditorState {
  switch (event.type) {
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
 * Named keys (enter, space, backspace…) come back null so their callers switch
 * on `key.name` instead; the parser reports capitals as lowercase names plus a
 * shift flag, so the *character* has to come from `sequence`, which carries the
 * actual glyph. Releases and ctrl/meta combos are never text.
 */
export function charFromKey(key: KeyEvent): string | null {
  if (key.eventType === "release") return null;
  if (key.ctrl || key.meta || key.option) return null;
  const name = key.name;
  if (!name || name.length > 1) return null;
  const sequence = key.sequence;
  return sequence && [...sequence].length === 1 ? sequence : name;
}

// ---------------------------------------------------------------------------
// Normal mode
// ---------------------------------------------------------------------------

function normalKey(state: EditorState, key: KeyEvent): EditorState {
  const name = key.name;

  const motion = (delta: { row?: number; col?: number }): EditorState => {
    const row = clamp(state.cursor.row + (delta.row ?? 0), 0, state.lines.length - 1);
    // A horizontal move adjusts the column; a vertical one keeps it and clamps
    // to the line it lands on, so a shorter line pulls the cursor in rather
    // than stranding it past the text.
    const col =
      delta.col === undefined
        ? clamp(state.cursor.col, 0, state.lines[row]!.length)
        : clamp(state.cursor.col + delta.col, 0, state.lines[row]!.length);
    return { ...state, cursor: { row, col } };
  };

  switch (name) {
    case "h":
      return motion({ col: -1 });
    case "l":
      return motion({ col: +1 });
    case "j":
      return motion({ row: +1 });
    case "k":
      return motion({ row: -1 });
    case "0":
      return { ...state, cursor: { row: state.cursor.row, col: 0 } };
    case "$":
      return { ...state, cursor: { row: state.cursor.row, col: state.lines[state.cursor.row]!.length } };
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
    case ":":
      return { ...state, mode: "command", command: "", message: null };
    case "escape":
      return { ...state, message: null };
    case "space":
    case "backspace":
      return { ...state, message: `not a normal-mode key: ${name}` };
    default:
      // Letters that are not bound read as "unrecognised" rather than silently
      // doing nothing — a mis-typed motion is exactly what a mode machine
      // should surface on its status line.
      if (name && name.length === 1) {
        return { ...state, message: `not a normal-mode key: ${name}` };
      }
      return state;
  }
}

function enterInsert(
  state: EditorState,
  where: "here" | "after" | "start" | "end",
): EditorState {
  const line = state.lines[state.cursor.row]!;
  const col =
    where === "start" ? 0 : where === "end" ? line.length : where === "after" ? state.cursor.col + 1 : state.cursor.col;
  return {
    ...state,
    mode: "insert",
    cursor: { row: state.cursor.row, col: clamp(col, 0, line.length) },
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
  switch (key.name) {
    case "escape":
    case "ctrl+c":
      return {
        ...state,
        mode: "normal",
        // vim steps the cursor back one column when insert closes; it never
        // walks off the front of a line.
        cursor: { ...state.cursor, col: Math.max(0, state.cursor.col - 1) },
        message: null,
      };
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
    if (state.file === null)
      return { ...next, message: "no file name (open one with :e path)" };
    return { ...next, request: { type: "write" } };
  }
  if (command === "q") {
    if (state.dirty) return { ...next, message: "no write since last change (:wq to save and quit)" };
    return { ...next, request: { type: "close" } };
  }
  if (command === "q!") {
    return { ...next, request: { type: "close" } };
  }
  if (command === "wq" || command === "x") {
    if (state.file === null)
      return { ...next, message: "no file name (open one with :e path)" };
    return { ...next, request: { type: "write-close" } };
  }
  const open = command.match(/^e(?:\s+(.+))?$/);
  if (open) {
    const path = open[1]?.trim();
    if (!path) return { ...next, message: "usage: :e path" };
    return { ...next, request: { type: "open", path } };
  }
  return { ...next, message: `not an editor command: ${command}` };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
