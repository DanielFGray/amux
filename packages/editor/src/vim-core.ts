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
import { pathToFiletype } from "@opentui/core";
import { Option } from "effect";
import { BUILTIN_COMMANDS, resolveCommand, type RegisteredCommand } from "./api.ts";
import {
  adjustCursorPastEol,
  allMotions,
  applyMotion,
  applyMotionForce,
  atEndOfWord,
  exclusiveEnd,
  findIsInclusive,
  findMotion,
  flipFind,
  halfPageDown,
  halfPageUp,
  INCLUSIVE_MOTIONS,
  isBlankChar,
  isWholeKeyword,
  keywordAtCursor,
  LINEWISE_MOTIONS,
  nextCurswant,
  curswantForMotion,
  charAtPos,
  sentenceEndExclusive,
  sentenceStart,
  stepPos,
  type FindKind,
  type Motion,
  type MotionContext,
  type MotionRange,
} from "./motions.ts";
import {
  type BuiltinMapId,
  type MapScope,
  isMapPrefixStroke,
  pushBuiltinMap,
  strokeFromKey,
} from "./maps.ts";
import {
  appendChangeKey,
  cancelChange,
  finishChange,
  initialUndoTree,
  redo,
  startChange,
  undo,
  undoNewer,
  undoOlder,
} from "./history.ts";
import { cascadeAtom, isCascadeable } from "./cmd-atom.ts";
import type {
  Cursor,
  EditorEvent,
  EditorMode,
  EditorState,
  MotionForce,
  OperatorKind,
  SurroundPending,
} from "./schema.ts";
import {
  addSurround,
  addTagSurround,
  changeSurround,
  deleteSurround,
  findPairAround,
} from "./surround.ts";
import { tagTextObjectRange } from "./tags.ts";
import {
  bufferFromLines,
  clearPendingEdits,
  editDelete,
  editInsert,
  editReplaceLines,
  emptyBuffer,
  lineAtRow,
  linesOf,
  rowCount,
} from "./buffer-state.ts";
import {
  activeReg,
  isRegisterName,
  readRegister,
  REGISTER_PICKING,
  writeRegister,
} from "./registers.ts";
import { applyExLine, browseCommandHistory, initialExState, pushCommandHistory } from "./ex.ts";
import {
  appendMacroKey,
  applyCaseRange,
  armInsertCtrlO,
  autoIndentRows,
  encodeKey,
  initialSliceState,
  insertClearLineEnd,
  insertClearLineStart,
  insertDeleteWord,
  insertPasteRegister,
  insertShiftIndent,
  isJumpMotionKey,
  jumpToMark,
  leaveVisual,
  maybeResumeAfterCtrlO,
  pushJump,
  rememberVisual,
  resumeInsert,
  restoreVisual,
  scrollViewport,
  setMark,
  snapViewport,
  startMacro,
  stopMacro,
  swapVisualEnds,
  toggleCaseChars,
  walkChange,
  walkJump,
} from "./vim-slices.ts";

// ---------------------------------------------------------------------------
// Public state factory
// ---------------------------------------------------------------------------

const DEFAULT_VIEWPORT = { top: 0, height: 24 } as const;

/** An editor with no file: a scratch buffer rooted at the workspace. */
export function initialEditor(): EditorState {
  const buffer = emptyBuffer();
  const cursor = { row: 0, col: 0 };
  return {
    mode: "normal",
    buffer,
    pendingEdits: [],
    cursor,
    curswant: 0,
    setCurswant: true,
    command: "",
    file: null,
    generation: null,
    dirty: false,
    message: null,
    request: null,
    count: "",
    mapKeys: [],
    pendingFind: null,
    lastFind: null,
    viewport: DEFAULT_VIEWPORT,
    pending: null,
    pendingSurround: null,
    pendingReplace: null,
    pendingIndent: null,
    visual: null,
    searchDirection: "forward",
    lastSearch: null,
    undoTree: initialUndoTree(buffer, cursor),
    changeBase: null,
    recording: null,
    lastChange: null,
    repeating: false,
    cascading: false,
    register: { text: [], linewise: false },
    registers: {},
    selectedRegister: "",
    lastAtom: null,
    extraCursors: [],
    atomGeneration: 0,
    ...initialSliceState(),
    ...initialExState(),
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Feed one event into the state machine and get the next state.
 *
 * `commands` is the live ex-command table (builtins + Editor registrations).
 * Defaults to builtins so unit tests and embed callers stay table-free.
 */
export function reduceEditor(
  state: EditorState,
  event: EditorEvent,
  commands: readonly RegisteredCommand[] = BUILTIN_COMMANDS,
): EditorState {
  switch (event._tag) {
    case "key":
      return settleCascade(state, onKey(state, event.key, commands), commands);
    case "scroll":
      return scrollViewport(state, event.delta);
    case "command-complete":
      return state.mode === "command" ? { ...state, command: event.command, message: null } : state;
    case "loaded": {
      const buffer = bufferFromLines(event.lines.length > 0 ? event.lines : [""]);
      const n = rowCount(buffer);
      const cursor = { row: 0, col: 0 };
      return {
        ...clearPendingEdits(state),
        mode: state.options.keyProfile === "cua" ? "insert" : "normal",
        buffer,
        cursor,
        file: event.file,
        generation: event.generation ?? null,
        dirty: false,
        command: "",
        message: `${n} ${n === 1 ? "line" : "lines"}`,
        request: null,
        count: "",
        mapKeys: [],
        pendingFind: null,
        pending: null,
        pendingSurround: null,
        pendingReplace: null,
        pendingIndent: null,
        visual: null,
        undoTree: initialUndoTree(buffer, cursor),
        changeBase: null,
        recording: null,
        lastChange: null,
        lastAtom: null,
        extraCursors: [],
        cascading: false,
        atomGeneration: 0,
      };
    }
    case "remote": {
      const buffer = bufferFromLines(event.lines.length > 0 ? event.lines : [""]);
      const n = rowCount(buffer);
      const row = Math.min(state.cursor.row, n - 1);
      const col = Math.min(state.cursor.col, lineAtRow(buffer, row).length);
      const cursor = { row, col };
      return {
        ...clearPendingEdits(state),
        buffer,
        cursor,
        generation: event.generation,
        dirty: event.dirty,
        message: null,
        request: null,
        pending: null,
        pendingSurround: null,
        mapKeys: [],
        pendingFind: null,
        count: "",
        undoTree: initialUndoTree(buffer, cursor),
        changeBase: null,
        recording: null,
      };
    }
    case "written":
      return {
        ...state,
        dirty: false,
        message: `"${state.file ?? "buffer"}" written`,
        request: null,
      };
    case "write-error":
      return { ...state, dirty: true, message: event.message, request: null };
    case "goto": {
      const cursor = {
        row: Math.max(0, event.row),
        col: Math.max(0, event.col),
      };
      const jumped = {
        ...state,
        mapKeys: [],
        jumpList: pushJump(state.jumpList, state.cursor),
        count: "",
        message: null,
      };
      if (state.file !== null && state.file === event.path) {
        return { ...jumped, cursor, request: null };
      }
      return {
        ...jumped,
        request: { _tag: "open", path: event.path, row: cursor.row, col: cursor.col },
      };
    }
  }
}

function onKey(
  state: EditorState,
  key: KeyEvent,
  commands: readonly RegisteredCommand[],
): EditorState {
  // A request is a one-shot instruction to the shell. Only `:wq`-style
  // execution produces one; any other key must not carry a stale request
  // forward, or the shell would fulfil it again. executeCommand sets the new
  // one after this spread.
  const base = { ...state, request: null };
  const beforeMacro = base.macroReg;
  let next: EditorState;
  // Surround char/tag wait is profile-neutral (palette beginSurround + ys).
  if (base.pendingSurround !== null) next = continueSurround(base, key);
  // Cmdline / search prompt must win over CUA insert routing — otherwise
  // palette-opened `/` and `:%s/` never receive typed text.
  else if (base.mode === "command") next = commandKey(base, key, commands);
  else if (base.mode === "search") next = searchKey(base, key);
  // CUA / modeless: always the insert+readline path — never synthesize vim
  // normal. Escape stays put (ts-85461b). Cite: ep-b64a91 / ts-e7d63c.
  else if (base.options.keyProfile === "cua") {
    const cuaBase = base.mode === "insert" ? base : { ...base, mode: "insert" as const };
    next = cuaKey(cuaBase, key);
  } else if (base.mode === "insert") next = insertKey(base, key);
  else if (base.mode === "replace") next = replaceKey(base, key);
  else if (base.mode === "visual") next = visualKey(base, key);
  else next = normalKey(base, key);

  // Macro tape: append after the key is handled, never the `q` that stops
  // or the `q{reg}` that starts. Cite: checklist E — distinct from `.` recording.
  if (beforeMacro !== null && next.macroReg === beforeMacro && !base.replayingMacro) {
    const encoded = encodeKey(key);
    if (encoded !== null) next = appendMacroKey(next, encoded);
  }

  return maybeResumeAfterCtrlO(base, next);
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
  // Esc clears anything pending — operator, count, map prefix, find, or surround.
  if (key.name === "escape") return cancelPendingOnEscape(state);

  // Character-find waits for its target before anything else.
  if (state.pendingFind !== null) return completeFind(state, key);

  // `m` waits for the mark name; `'` / `` ` `` wait for the jump target.
  if (state.pendingMark) {
    const name = charFromKey(key) ?? key.name;
    return setMark(state, name.length === 1 ? name : "");
  }
  if (state.pendingJump !== null) {
    const name = charFromKey(key) ?? key.name;
    const linewise = state.pendingJump === "'";
    return jumpToMark(state, name.length === 1 ? name : "", linewise);
  }

  // `"` waits for the register name (`"a`, `"_`, …).
  if (state.pendingRegister !== "") {
    if (key.name === "escape") {
      return { ...state, pendingRegister: "", message: null };
    }
    const name =
      charFromKey(key) ??
      (key.shift && key.name === "'" ? '"' : key.name === "quote" ? '"' : key.name);
    if (!isRegisterName(name)) {
      return { ...state, pendingRegister: "", message: null };
    }
    return {
      ...state,
      pendingRegister: "",
      selectedRegister: name,
      message: null,
    };
  }

  // `q` waiting for the macro register; `@` waiting for the playback register.
  if (state.pendingMacro) {
    const name = charFromKey(key) ?? key.name;
    return startMacro(state, name.length === 1 ? name.toLowerCase() : "");
  }
  if (state.pendingAt) {
    if (key.name === "@" || key.sequence === "@") {
      return playMacro(state, "@", parsedCount(state));
    }
    const name = charFromKey(key) ?? key.name;
    return playMacro(state, name.length === 1 ? name.toLowerCase() : "", parsedCount(state));
  }

  // Incomplete builtin map (`g…` / `z…`) — prefix wait comes from the table.
  if (state.mapKeys.length > 0) return continueMapKeys(state, key);

  // `g~` / `gu` / `gU` / `=` wait for a motion (or a doubled letter).
  if (state.pendingCase !== null) {
    const mapped = tryMapKey(state, key);
    if (mapped !== null) return mapped;
    return continueCase(state, key);
  }
  if (state.pendingEqual !== null) {
    const mapped = tryMapKey(state, key);
    if (mapped !== null) return mapped;
    return continueEqual(state, key);
  }

  // `r` waits for the replacement character.
  if (state.pendingReplace !== null) return completeReplace(state, key);

  // `>` / `<` wait for a doubled key (line indent) for now.
  if (state.pendingIndent !== null) {
    const mapped = tryMapKey(state, key);
    if (mapped !== null) return mapped;
    return completeIndent(state, key);
  }

  // An armed operator consumes the next motion or text object.
  if (state.pending) {
    const mapped = tryMapKey(state, key);
    if (mapped !== null) return mapped;
    return continueOperator(state, key);
  }

  // `ys` / `ds` / `cs` — surround waits for a motion and/or delimiter char.
  if (state.pendingSurround !== null) return continueSurround(state, key);

  if (isCountDigit(state, key)) {
    return { ...state, count: state.count === "0" ? key.name : state.count + key.name };
  }

  const mapped = tryMapKey(state, key);
  if (mapped !== null) return mapped;

  return dispatchNormalKey(state, key);
}

const cancelPendingOnEscape = (state: EditorState): EditorState => {
  if (
    state.pending ||
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
    state.changeBase !== null ||
    state.count !== ""
  )
    return cancelChange({
      ...state,
      pending: null,
      pendingSurround: null,
      pendingReplace: null,
      pendingIndent: null,
      mapKeys: [],
      pendingFind: null,
      pendingMark: false,
      pendingJump: null,
      pendingCase: null,
      pendingEqual: null,
      pendingMacro: false,
      pendingAt: false,
      pendingRegister: "",
      insertCtrlO: false,
      count: "",
      message: null,
    });
  return { ...state, message: null };
};

const continueOperator = (state: EditorState, key: KeyEvent): EditorState => {
  const pending = state.pending!;
  // Motion force: `dv` / `dV` / `dCtrl-v` before the motion (nvim oparg.motion_force).
  if (
    pending.textObject === undefined &&
    pending.motionForce == null &&
    (key.name === "v" || key.name === "V" || (key.ctrl && (key.name === "v" || key.name === "V")))
  ) {
    const force: MotionForce = key.ctrl
      ? "block"
      : key.name === "V" || (key.shift && key.name === "v")
        ? "V"
        : "v";
    return {
      ...appendChangeKey(state, key.ctrl ? "ctrl+v" : key.name),
      pending: { ...pending, motionForce: force },
      message: null,
    };
  }
  // `ys` / `ds` / `cs` — pivot the armed operator into surround (tpope).
  if (pending.textObject === undefined && key.name === "s") {
    return armSurround(appendChangeKey(state, "s"), pending.kind, pending.count);
  }
  // `d i` / `d a` — promote to text-object wait; the following key names
  // the symbol (w, p, (, ", etc.).
  if (pending.textObject === undefined && (key.name === "i" || key.name === "a")) {
    return {
      ...appendChangeKey(state, key.name),
      pending: {
        kind: pending.kind,
        count: pending.count,
        textObject: key.name === "i" ? "inner" : "outer",
        motionForce: pending.motionForce,
      },
    };
  }
  // `df` / `dt` / … — wait for the target character, then apply the operator.
  const findKind = findKindOf(key);
  if (pending.textObject === undefined && findKind !== null) {
    return {
      ...appendChangeKey(state, findKind),
      pendingFind: { kind: findKind },
      message: null,
    };
  }
  const recorded = appendChangeKey(state, motionRecordKey(key));
  const range = resolveMotion(recorded, key);
  if (range === null) return unknownKey(state, key.name);
  const applied = applyOperator(recorded, range.range);
  const motionName = motionKeyName(key);
  const prefer = nextCurswant(
    state.curswant,
    state.setCurswant,
    motionName,
    state.cursor.col,
    applied.cursor.col,
  );
  return {
    ...applied,
    curswant: prefer.curswant,
    setCurswant: prefer.setCurswant,
  };
};

const armSurround = (state: EditorState, kind: OperatorKind, count: number): EditorState => {
  // Surround pivoted off an operator that already called startChange.
  const cleared: EditorState = { ...state, pending: null, count: "", message: null };
  if (kind === "yank") {
    return {
      ...cleared,
      pendingSurround: { mode: "add", phase: "motion", count },
    };
  }
  if (kind === "delete") {
    return { ...cleared, pendingSurround: { mode: "delete" } };
  }
  return { ...cleared, pendingSurround: { mode: "change", phase: "old" } };
};

const filetypeOf = (state: EditorState): Option.Option<string> => {
  if (state.file === null) return Option.none();
  return Option.fromNullishOr(pathToFiletype(state.file));
};

const applySurroundEdit = (
  state: EditorState,
  result: Option.Option<{ readonly lines: readonly string[]; readonly cursor: Cursor }>,
  failMessage: string,
): EditorState =>
  Option.match(result, {
    onNone: () =>
      cancelChange({
        ...state,
        pendingSurround: null,
        message: failMessage,
      }),
    onSome: (edit) => {
      const n = rowCount(state.buffer);
      return finishChange({
        ...editReplaceLines(state, 0, n, edit.lines),
        cursor: edit.cursor,
        pendingSurround: null,
        count: "",
        message: null,
      });
    },
  });

const continueSurround = (state: EditorState, key: KeyEvent): EditorState => {
  const pending = state.pendingSurround!;
  if (pending.mode === "add" && pending.phase === "motion") {
    return continueSurroundMotion(state, pending, key);
  }
  if (pending.mode === "add" && pending.phase === "char") {
    return finishSurroundAdd(state, pending, key);
  }
  if (pending.mode === "add" && pending.phase === "tag") {
    return continueTagPrompt(state, pending, key);
  }
  if (pending.mode === "delete") {
    return finishSurroundDelete(state, key);
  }
  if (pending.mode === "change" && pending.phase === "old") {
    const char = charFromKey(key);
    if (char === null) return unknownKey(state, key.name);
    if (char === "t") {
      return {
        ...state,
        pendingSurround: { mode: "change", phase: "tag", old: "t", name: "" },
        message: null,
      };
    }
    return {
      ...state,
      pendingSurround: { mode: "change", phase: "new", old: char },
      message: null,
    };
  }
  if (pending.mode === "change" && pending.phase === "tag") {
    return continueTagPrompt(state, pending, key);
  }
  return finishSurroundChange(state, pending.old, key);
};

/** Collect tag name chars until `>` or Enter finishes the surround. */
const continueTagPrompt = (
  state: EditorState,
  pending: Extract<SurroundPending, { phase: "tag" }>,
  key: KeyEvent,
): EditorState => {
  if (key.name === "return" || key.name === "enter" || charFromKey(key) === ">") {
    return finishTagPrompt(state, pending);
  }
  if (key.name === "backspace") {
    return {
      ...state,
      pendingSurround: { ...pending, name: pending.name.slice(0, -1) },
      message: null,
    };
  }
  const char = charFromKey(key);
  if (char === null) return unknownKey(state, key.name);
  return {
    ...appendChangeKey(state, char),
    pendingSurround: { ...pending, name: pending.name + char },
    message: null,
  };
};

const finishTagPrompt = (
  state: EditorState,
  pending: Extract<SurroundPending, { phase: "tag" }>,
): EditorState => {
  const recorded = appendChangeKey(state, ">");
  if (pending.mode === "add") {
    return applySurroundEdit(
      recorded,
      addTagSurround(
        linesOf(recorded.buffer),
        {
          from: pending.from,
          to: pending.to,
          linewise: pending.linewise,
          inclusive: pending.inclusive,
        },
        pending.name,
      ),
      "unknown surround tag",
    );
  }
  return applySurroundEdit(
    recorded,
    changeSurround(
      linesOf(recorded.buffer),
      recorded.cursor,
      "t",
      pending.name,
      filetypeOf(recorded),
    ),
    "no surrounding tag",
  );
};

const continueSurroundMotion = (
  state: EditorState,
  pending: Extract<SurroundPending, { mode: "add"; phase: "motion" }>,
  key: KeyEvent,
): EditorState => {
  // `yss` — surround the current line (from first non-blank).
  if (!("textObject" in pending) && key.name === "s") {
    return awaitSurroundChar(
      state,
      {
        from: { row: state.cursor.row, col: 0 },
        to: {
          row: state.cursor.row,
          col: lineAtRow(state.buffer, state.cursor.row).length,
        },
        linewise: true,
        inclusive: false,
      },
      pending.count,
    );
  }
  if (!("textObject" in pending) && (key.name === "i" || key.name === "a")) {
    return {
      ...state,
      pendingSurround: {
        mode: "add",
        phase: "motion",
        count: pending.count,
        textObject: key.name === "i" ? "inner" : "outer",
      },
    };
  }
  const findKind = findKindOf(key);
  if (!("textObject" in pending) && findKind !== null) {
    return { ...state, pendingFind: { kind: findKind }, message: null };
  }
  // Reuse operator motion resolution with a synthetic yank pending.
  const asOperator: EditorState = {
    ...state,
    pending:
      "textObject" in pending
        ? { kind: "yank", count: pending.count, textObject: pending.textObject }
        : { kind: "yank", count: pending.count },
    pendingSurround: null,
  };
  const resolved = resolveMotion(asOperator, key);
  if (resolved === null) return unknownKey(state, key.name);
  if (
    resolved.range.from.row === resolved.range.to.row &&
    resolved.range.from.col === resolved.range.to.col
  ) {
    return {
      ...state,
      pendingSurround: null,
      count: "",
      message: resolved.message ?? "no range",
    };
  }
  return awaitSurroundChar(state, resolved.range, pending.count);
};

const awaitSurroundChar = (state: EditorState, range: MotionRange, count: number): EditorState => ({
  ...state,
  pending: null,
  pendingSurround: {
    mode: "add",
    phase: "char",
    count,
    from: range.from,
    to: range.to,
    linewise: range.linewise,
    inclusive: range.inclusive,
  },
  count: "",
  message: null,
});

const finishSurroundAdd = (
  state: EditorState,
  pending: Extract<SurroundPending, { mode: "add"; phase: "char" }>,
  key: KeyEvent,
): EditorState => {
  const char = charFromKey(key);
  if (char === null) return unknownKey(state, key.name);
  // `t` — collect a tag name until `>` / Enter.
  if (char === "t") {
    return {
      ...appendChangeKey(state, char),
      pendingSurround: {
        mode: "add",
        phase: "tag",
        count: pending.count,
        from: pending.from,
        to: pending.to,
        linewise: pending.linewise,
        inclusive: pending.inclusive,
        name: "",
      },
      message: null,
    };
  }
  const recorded = appendChangeKey(state, char);
  return applySurroundEdit(
    recorded,
    addSurround(
      linesOf(recorded.buffer),
      {
        from: pending.from,
        to: pending.to,
        linewise: pending.linewise,
        inclusive: pending.inclusive,
      },
      char,
    ),
    `unknown surround ${char}`,
  );
};

const finishSurroundDelete = (state: EditorState, key: KeyEvent): EditorState => {
  const char = charFromKey(key);
  if (char === null) return unknownKey(state, key.name);
  const recorded = appendChangeKey(state, char);
  return applySurroundEdit(
    recorded,
    deleteSurround(linesOf(recorded.buffer), recorded.cursor, char, filetypeOf(recorded)),
    char === "t" ? "no surrounding tag" : `no surrounding ${char}`,
  );
};

const finishSurroundChange = (state: EditorState, old: string, key: KeyEvent): EditorState => {
  const char = charFromKey(key);
  if (char === null) return unknownKey(state, key.name);
  const recorded = appendChangeKey(state, char);
  return applySurroundEdit(
    recorded,
    changeSurround(linesOf(recorded.buffer), recorded.cursor, old, char, filetypeOf(recorded)),
    `no surrounding ${old}`,
  );
};

/** Scope for the builtin map trie: operator-armed waits share motion maps. */
const mapScopeOf = (state: EditorState): MapScope =>
  state.pending !== null ||
  state.pendingCase !== null ||
  state.pendingEqual !== null ||
  state.pendingIndent !== null
    ? "operator"
    : "normal";

/**
 * Start or continue a builtin multi-key map. Returns null when this key is
 * not a map prefix in the current scope (caller falls through).
 */
const tryMapKey = (state: EditorState, key: KeyEvent): EditorState | null => {
  const stroke = strokeFromKey(key);
  if (stroke === null) return null;
  const scope = mapScopeOf(state);
  if (state.mapKeys.length === 0 && !isMapPrefixStroke(scope, stroke)) return null;
  return continueMapKeys(state, key);
};

const continueMapKeys = (state: EditorState, key: KeyEvent): EditorState => {
  const stroke = strokeFromKey(key);
  if (stroke === null) return normalKey({ ...state, mapKeys: [] }, key);
  const scope = mapScopeOf(state);
  const result = pushBuiltinMap(scope, state.mapKeys, stroke);
  if (result._tag === "pending") {
    const next: EditorState = { ...state, mapKeys: result.keys, message: null };
    return state.pending !== null ? appendChangeKey(next, stroke) : next;
  }
  if (result._tag === "matched") {
    const cleared = { ...state, mapKeys: [] };
    const recorded =
      state.pending !== null && stroke !== result.keys[0]
        ? appendChangeKey(cleared, stroke)
        : cleared;
    return runBuiltinMap(recorded, result.id);
  }
  // Map-fail: abandon the prefix, retry this key alone (neovim).
  return normalKey({ ...state, mapKeys: [] }, key);
};

/** Apply a completed builtin map. Exported for the plugin chord layer. */
export const runBuiltinMap = (state: EditorState, id: BuiltinMapId): EditorState => {
  const cleared: EditorState = { ...state, mapKeys: [], message: null };
  switch (id) {
    case "gg": {
      const next = { ...cleared, count: "" };
      if (state.pending !== null) {
        return applyOperator(
          next,
          applyMotion(allMotions.firstLine!, motionCtx(state, effectiveCount(state)), {
            linewise: true,
          }),
        );
      }
      return moveTo(state, allMotions.firstLine!, next, "firstLine");
    }
    case "ge": {
      const range = applyMotion(allMotions.ge!, motionCtx(state, effectiveCount(state)), {
        inclusive: true,
      });
      if (state.pending !== null) return applyOperator(cleared, range);
      if (state.pendingCase !== null) {
        return finishChange(
          applyCaseRange(
            startChange({ ...cleared, pendingCase: null }, ["g", "e"]),
            range,
            state.pendingCase.kind,
          ),
        );
      }
      return moveTo(cleared, allMotions.ge!, cleared, "ge");
    }
    case "gE": {
      const range = applyMotion(allMotions.gE!, motionCtx(state, effectiveCount(state)), {
        inclusive: true,
      });
      if (state.pending !== null) return applyOperator(cleared, range);
      return moveTo(cleared, allMotions.gE!, cleared, "gE");
    }
    case "g-":
      return undoOlder({ ...cleared, count: "" });
    case "g+":
      return undoNewer({ ...cleared, count: "" });
    case "g;":
      return walkChange(cleared, "older");
    case "g,":
      return walkChange(cleared, "newer");
    case "gv":
      return restoreVisual(cleared);
    case "gi":
      return resumeInsert(startChange(cleared, ["gi"]));
    case "gu":
      return {
        ...cleared,
        pendingCase: { kind: "lower", count: parsedCount(state) },
        count: "",
      };
    case "gU":
      return {
        ...cleared,
        pendingCase: { kind: "upper", count: parsedCount(state) },
        count: "",
      };
    case "g~":
      return {
        ...cleared,
        pendingCase: { kind: "toggle", count: parsedCount(state) },
        count: "",
      };
    case "g*":
      return searchIdent(cleared, "forward", false);
    case "g#":
      return searchIdent(cleared, "backward", false);
    case "zz":
      return snapViewport(cleared, "middle");
    case "zt":
      return snapViewport(cleared, "top");
    case "zb":
      return snapViewport(cleared, "bottom");
  }
};

const dispatchNormalKey = (state: EditorState, key: KeyEvent): EditorState => {
  if (key.ctrl && key.name === "d") return moveTo(state, halfPageDown, state, "ctrl-d");
  if (key.ctrl && key.name === "u") return moveTo(state, halfPageUp, state, "ctrl-u");
  if (key.ctrl && key.name === "r") return redo(state);
  if (key.ctrl && key.name === "o") return walkJump(state, "older");
  if (key.ctrl && key.name === "i") return walkJump(state, "newer");
  if (key.ctrl && key.name === "e") {
    return scrollViewport(state, parsedCount(state));
  }
  if (key.ctrl && key.name === "y") {
    return scrollViewport(state, -parsedCount(state));
  }

  // `%` / `N%` and `|` before single-key motion table (special count semantics).
  if (key.name === "%" || key.sequence === "%" || (key.shift && key.name === "5")) {
    return movePercent(state);
  }
  if (key.name === "|" || key.sequence === "|") {
    return moveTo(state, allMotions["|"]!, state, "|");
  }

  const motionName = motionKeyName(key);
  const motion = singleKeyMotion(motionName);
  if (motion !== undefined) return moveTo(state, motion, state, motionName);

  const findKind = findKindOf(key);
  if (findKind !== null) {
    return { ...state, pendingFind: { kind: findKind }, message: null };
  }
  if (key.name === ";" || key.name === ",") {
    return repeatFind(state, key.name === ",");
  }

  // `*` / `#` — search word under cursor. Cite: neovim `nv_ident`.
  if (isStarKey(key)) return searchIdent(state, "forward", true);
  if (isHashKey(key)) return searchIdent(state, "backward", true);

  switch (key.name) {
    case "m":
      return { ...state, pendingMark: true, message: null };
    case "'":
      return { ...state, pendingJump: "'", message: null };
    case "`":
      return { ...state, pendingJump: "`", message: null };
    case "~":
      return finishChange(toggleCaseChars(startChange(state, ["~"]), parsedCount(state)));
    case "=":
      return {
        ...state,
        pendingEqual: { count: parsedCount(state) },
        count: "",
        message: null,
      };
    case "i":
      return enterInsert(startChange(state, ["i"]), "here");
    case "a":
      return enterInsert(startChange(state, ["a"]), "after");
    case "A":
      return enterInsert(startChange(state, ["A"]), "end");
    case "I":
      return enterInsert(startChange(state, ["I"]), "start");
    case "o":
      return openLine(startChange(state, ["o"]), "below");
    case "O":
      return openLine(startChange(state, ["O"]), "above");
    case "x":
    case "X": {
      const backward = key.name === "X" || key.shift === true;
      const count = parsedCount(state);
      return finishChange(
        deleteChars(startChange(state, [backward ? "X" : "x"]), backward ? -1 : 1, count),
      );
    }
    case "D":
      return applyOperator(
        { ...startChange(state, ["D"]), pending: { kind: "delete", count: 1 } },
        lineRestRange(state),
      );
    case "C":
      return applyOperator(
        { ...startChange(state, ["C"]), pending: { kind: "change", count: 1 } },
        lineRestRange(state),
      );
    case "Y":
      return applyOperator(
        { ...startChange(state, ["Y"]), pending: { kind: "yank", count: 1 } },
        currentLineRange(state),
      );
    case "d":
    case "c":
    case "y":
      return armOperator(state, key.name);
    case "p":
      return finishChange(putAfter(startChange(state, ["p"])));
    case "P":
      return finishChange(putBefore(startChange(state, ["P"])));
    case "R":
      return enterReplace(startChange(state, ["R"]));
    case "r":
      if (key.shift) return enterReplace(startChange(state, ["R"]));
      return {
        ...startChange(state, ["r"]),
        pendingReplace: { count: parsedCount(state) },
        message: null,
      };
    case '"':
      return { ...state, pendingRegister: REGISTER_PICKING, message: null };
    case "J":
      return finishChange(joinLines(startChange(state, ["J"]), parsedCount(state)));
    case ">":
      return {
        ...state,
        pendingIndent: { dir: 1, count: parsedCount(state) },
        count: "",
        message: null,
      };
    case "<":
      return {
        ...state,
        pendingIndent: { dir: -1, count: parsedCount(state) },
        count: "",
        message: null,
      };
    case "v":
      if (key.ctrl) return { ...state, message: "visual block mode is not supported yet" };
      return enterVisual(state, key.shift ? "line" : "char");
    case "V":
      return enterVisual(state, "line");
    case "/":
      return enterSearch(state, "forward");
    case "?":
      return enterSearch(state, "backward");
    case "n":
      return repeatSearch(state, false);
    case "N":
      return repeatSearch(state, true);
    case ".":
      return repeatLastChange(state);
    case "q":
      // Toggle macro recording. While recording, `q` stops; otherwise arm
      // for the register name. Distinct from `.` `recording`.
      if (state.macroReg !== null) return stopMacro(state);
      return { ...state, pendingMacro: true, message: null };
    case "@":
      return { ...state, pendingAt: true, message: null };
    case ":":
      return {
        ...state,
        mode: "command",
        command: "",
        count: "",
        message: null,
      };
    case "u":
      return undo(state);
    default:
      // OpenTUI may deliver `~` / `=` / `@` only via sequence.
      if (key.sequence === "@") {
        return { ...state, pendingAt: true, message: null };
      }
      if (key.sequence === "~") {
        return finishChange(toggleCaseChars(startChange(state, ["~"]), parsedCount(state)));
      }
      if (key.sequence === "=") {
        return {
          ...state,
          pendingEqual: { count: parsedCount(state) },
          count: "",
          message: null,
        };
      }
      return unknownKey(state, key.name);
  }
};

const movePercent = (state: EditorState): EditorState => {
  // Bare `%` → match paren; `N%` → percent of file (nvim nv_percent).
  if (state.count !== "") {
    return moveTo(state, allMotions.percentOfFile!, state, "percentOfFile");
  }
  return moveTo(state, allMotions["%"]!, state, "%");
};

const continueCase = (state: EditorState, key: KeyEvent): EditorState => {
  const pending = state.pendingCase;
  if (pending === null) return state;
  // Doubled letter: g~~ / guu / gUU → current line × count.
  const letter = pending.kind === "toggle" ? "~" : pending.kind === "lower" ? "u" : "U";
  if (
    key.name === letter ||
    key.sequence === letter ||
    (pending.kind === "upper" && key.shift && key.name === "u") ||
    (pending.kind === "toggle" && key.sequence === "~")
  ) {
    const from = state.cursor.row;
    const to = Math.min(rowCount(state.buffer) - 1, from + pending.count - 1);
    const range: MotionRange = {
      from: { row: from, col: 0 },
      to: { row: to, col: lineAtRow(state.buffer, to).length },
      linewise: true,
      inclusive: false,
    };
    const keys =
      pending.kind === "toggle"
        ? ["g", "~", "~"]
        : pending.kind === "lower"
          ? ["g", "u", "u"]
          : ["g", "U", "U"];
    return finishChange(
      applyCaseRange(startChange({ ...state, pendingCase: null }, keys), range, pending.kind),
    );
  }
  const resolved = resolveMotion(
    { ...state, pending: { kind: "yank", count: pending.count } },
    key,
  );
  if (resolved === null) {
    return { ...state, pendingCase: null, message: null };
  }
  const keys = [
    "g",
    pending.kind === "toggle" ? "~" : pending.kind === "lower" ? "u" : "U",
    motionRecordKey(key),
  ];
  return finishChange(
    applyCaseRange(
      startChange({ ...state, pendingCase: null, count: "" }, keys),
      resolved.range,
      pending.kind,
    ),
  );
};

const continueEqual = (state: EditorState, key: KeyEvent): EditorState => {
  const pending = state.pendingEqual;
  if (pending === null) return state;
  if (key.name === "=" || key.sequence === "=") {
    const from = state.cursor.row;
    const to = Math.min(rowCount(state.buffer) - 1, from + pending.count - 1);
    return finishChange(
      autoIndentRows(startChange({ ...state, pendingEqual: null }, ["=", "="]), from, to),
    );
  }
  const resolved = resolveMotion(
    { ...state, pending: { kind: "yank", count: pending.count } },
    key,
  );
  if (resolved === null) {
    return { ...state, pendingEqual: null, message: null };
  }
  const start = Math.min(resolved.range.from.row, resolved.range.to.row);
  const end = Math.max(resolved.range.from.row, resolved.range.to.row);
  return finishChange(
    autoIndentRows(
      startChange({ ...state, pendingEqual: null, count: "" }, ["=", motionRecordKey(key)]),
      start,
      end,
    ),
  );
};

const motionRecordKey = (key: KeyEvent): string => {
  const char = charFromKey(key);
  if (char !== null) return char;
  return motionKeyName(key);
};

const lineRestRange = (state: EditorState): MotionRange => ({
  from: state.cursor,
  to: { row: state.cursor.row, col: lineAtRow(state.buffer, state.cursor.row).length },
  linewise: false,
  inclusive: false,
});

const currentLineRange = (state: EditorState): MotionRange => ({
  from: { row: state.cursor.row, col: 0 },
  to: {
    row: state.cursor.row,
    col: lineAtRow(state.buffer, state.cursor.row).length,
  },
  linewise: true,
  inclusive: false,
});

const enterVisual = (state: EditorState, kind: "char" | "line"): EditorState => ({
  ...state,
  mode: "visual",
  visual: { kind, anchor: { ...state.cursor } },
  count: "",
  pending: null,
  message: null,
});

/** Mode to resume after leaving `/` or `:` — insert under CUA, else normal. */
const idleMode = (state: EditorState): EditorMode =>
  state.options.keyProfile === "cua" ? "insert" : "normal";

const enterSearch = (state: EditorState, direction: "forward" | "backward"): EditorState => ({
  ...state,
  mode: "search",
  searchDirection: direction,
  command: "",
  count: "",
  message: null,
});

type MotionKey =
  | "h"
  | "j"
  | "k"
  | "l"
  | "w"
  | "W"
  | "b"
  | "B"
  | "e"
  | "E"
  | "0"
  | "$"
  | "^"
  | "G"
  | "H"
  | "M"
  | "L"
  | "{"
  | "}"
  | "("
  | ")"
  | "+"
  | "-"
  | "_"
  | "CR";

const isMotionKey = (name: string): name is MotionKey =>
  name === "h" ||
  name === "j" ||
  name === "k" ||
  name === "l" ||
  name === "w" ||
  name === "W" ||
  name === "b" ||
  name === "B" ||
  name === "e" ||
  name === "E" ||
  name === "0" ||
  name === "$" ||
  name === "^" ||
  name === "G" ||
  name === "H" ||
  name === "M" ||
  name === "L" ||
  name === "{" ||
  name === "}" ||
  name === "(" ||
  name === ")" ||
  name === "+" ||
  name === "-" ||
  name === "_" ||
  name === "CR";

const isFindKind = (name: string): name is FindKind =>
  name === "f" || name === "F" || name === "t" || name === "T";

/** Normalize OpenTUI's shift+letter / sequence into the vim key name. */
const motionKeyName = (key: KeyEvent): string => {
  if (key.name === "return" || key.name === "enter") return "CR";
  if (key.sequence === "+" || key.name === "+") return "+";
  if (key.sequence === "-" || key.name === "-") return "-";
  if (key.shift && key.name === "=") return "+";
  if (key.sequence === "{" || key.sequence === "}") return key.sequence;
  if (key.sequence === "(" || key.sequence === ")") return key.sequence;
  if (key.sequence === "%" || key.name === "%") return "%";
  if (key.sequence === "|" || key.name === "|") return "|";
  if (key.sequence === "_" || key.name === "_") return "_";
  if (key.shift) {
    if (key.name === "9") return "(";
    if (key.name === "0") return ")";
    if (key.name === "g") return "G";
    if (key.name === "h") return "H";
    if (key.name === "m") return "M";
    if (key.name === "l") return "L";
    if (key.name === "f") return "F";
    if (key.name === "t") return "T";
    if (key.name === "w") return "W";
    if (key.name === "b") return "B";
    if (key.name === "e") return "E";
    if (key.name === "5") return "%";
  }
  // Already-capitalized names (tests, some terminals).
  return key.name;
};

const findKindOf = (key: KeyEvent): FindKind | null => {
  if (key.ctrl || key.meta || key.option) return null;
  const name = motionKeyName(key);
  return isFindKind(name) ? name : null;
};

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
  if (state.pendingReplace !== null || state.pendingIndent !== null) return false;
  if (state.pendingSurround !== null) {
    // Digits only compose with `ys` while waiting for a motion.
    const surround = state.pendingSurround;
    if (!(surround.mode === "add" && surround.phase === "motion")) return false;
  }
  if (state.mapKeys.length > 0) return false;
  if (state.pendingCase !== null || state.pendingEqual !== null) return false;
  if (state.pendingMacro || state.pendingAt || state.pendingRegister !== "") return false;
  if (key.ctrl || key.meta || key.option) return false;
  if (key.name.length !== 1) return false;
  // A leading zero is itself a motion, not a count. Subsequent digits
  // appended to a non-empty count are still digits.
  if (key.name === "0" && state.count === "") return false;
  return /[0-9]/.test(key.name);
}

const motionCtx = (
  state: EditorState,
  count: number,
  cursor = state.cursor,
  motionName?: string,
  eol = false,
): MotionContext => ({
  lines: linesOf(state.buffer),
  cursor,
  count,
  curswant: curswantForMotion(state.curswant, state.setCurswant, cursor.col, motionName),
  viewport: state.viewport,
  eol,
});

/** Motions whose result may sit on the EOL NUL and need `adjust_cursor`. */
const EOL_ADJUST_MOTIONS = new Set(["w", "W", "b", "B", "e", "E", "ge", "gE"]);

function moveTo(state: EditorState, motion: Motion, base = state, jumpKey?: string): EditorState {
  const count = parsedCount(state);
  // `|`, `N%`, `nG`, and `n_` consume count as an absolute target — not a repeat.
  const absolute =
    jumpKey === "|" ||
    jumpKey === "percentOfFile" ||
    jumpKey === "G" ||
    jumpKey === "%" ||
    jumpKey === "_";
  const ctx = motionCtx(state, count, state.cursor, jumpKey);
  const next = absolute
    ? {
        from: state.cursor,
        to: motion(ctx),
        linewise: jumpKey === "_",
        inclusive: false,
      }
    : applyMotion(motion, ctx);
  // Word motions may leave the EOL NUL; pull back like neovim `adjust_cursor`
  // (inclusive flag unused without an operator). Do not apply to `$`/`l`/…
  const landed =
    jumpKey !== undefined && EOL_ADJUST_MOTIONS.has(jumpKey)
      ? adjustCursorPastEol(next, linesOf(state.buffer))
      : next;
  const from = base;
  const withJump =
    jumpKey !== undefined && isJumpMotionKey(jumpKey)
      ? { ...from, jumpList: pushJump(from.jumpList, from.cursor) }
      : from;
  const prefer = nextCurswant(
    state.curswant,
    state.setCurswant,
    jumpKey,
    state.cursor.col,
    landed.to.col,
  );
  return {
    ...withJump,
    cursor: landed.to,
    curswant: prefer.curswant,
    setCurswant: prefer.setCurswant,
    count: "",
    mapKeys: [],
    pendingFind: null,
  };
}

function completeFind(state: EditorState, key: KeyEvent): EditorState {
  const pending = state.pendingFind;
  if (pending === null) return state;
  const char = charFromKey(key);
  if (char === null) {
    if (key.name === "escape") {
      return cancelChange({ ...state, pendingFind: null, message: null });
    }
    return cancelChange({ ...state, pendingFind: null, message: null });
  }
  const lastFind = { kind: pending.kind, char };
  const withFind: EditorState = {
    ...appendChangeKey(state, char),
    pendingFind: null,
    lastFind,
  };
  return runFind(withFind, pending.kind, char);
}

function repeatFind(state: EditorState, reverse: boolean): EditorState {
  if (state.lastFind === null) return { ...state, message: null };
  const kind = reverse ? flipFind(state.lastFind.kind) : state.lastFind.kind;
  return runFind(state, kind, state.lastFind.char);
}

function runFind(state: EditorState, kind: FindKind, char: string): EditorState {
  const motion = findMotion(kind, char);
  const count =
    state.pending !== null || isSurroundAddMotion(state.pendingSurround)
      ? effectiveCount(state)
      : parsedCount(state);
  const range = applyMotionForce(
    applyMotion(motion, motionCtx(state, count), {
      inclusive: findIsInclusive(kind),
    }),
    Option.fromNullishOr(state.pending?.motionForce),
  );
  if (state.pending !== null) {
    if (range.from.row === range.to.row && range.from.col === range.to.col) {
      return { ...state, pending: null, count: "", message: null };
    }
    return applyOperator(state, range);
  }
  if (isSurroundAddMotion(state.pendingSurround)) {
    if (range.from.row === range.to.row && range.from.col === range.to.col) {
      return { ...state, pendingSurround: null, count: "", message: null };
    }
    // Surround wrap uses half-open bounds.
    const end = exclusiveEnd(range, linesOf(state.buffer));
    return awaitSurroundChar(
      state,
      { ...range, to: end, inclusive: false },
      state.pendingSurround.count,
    );
  }
  return {
    ...state,
    cursor: range.to,
    count: "",
    pendingFind: null,
  };
}

const isSurroundAddMotion = (
  pending: SurroundPending | null,
): pending is Extract<SurroundPending, { mode: "add"; phase: "motion" }> =>
  pending !== null && pending.mode === "add" && pending.phase === "motion";

function armOperator(state: EditorState, name: string): EditorState {
  // An operator always waits for a motion or text object. `dd`/`cc`/`yy`
  // means "operate on the current line" — we detect that in the motion
  // resolver when the second key matches the operator letter, not here.
  if (state.pending) return unknownKey(state, name);
  return {
    ...startChange(state, [name]),
    pending: { kind: operatorKind(name), count: parsedCount(state) },
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
  const pending = state.pending;
  const force = Option.fromNullishOr(pending?.motionForce);
  const forceRange = (range: MotionRange) => applyMotionForce(range, force);

  if (key.ctrl && (key.name === "d" || key.name === "u")) {
    const motion = key.name === "d" ? halfPageDown : halfPageUp;
    return {
      range: forceRange(applyMotion(motion, motionCtx(state, effectiveCount(state)))),
    };
  }
  if (key.ctrl || key.meta || key.option) return null;
  const motionNameEarly = motionKeyName(key);
  if (
    key.name.length !== 1 &&
    key.name !== "{" &&
    key.name !== "}" &&
    key.name !== "%" &&
    key.name !== "|" &&
    key.name !== "return" &&
    key.name !== "enter" &&
    motionNameEarly !== "+" &&
    motionNameEarly !== "-" &&
    motionNameEarly !== "CR"
  ) {
    return null;
  }

  if (pending === null) return null;

  // `dd`, `cc`, `yy` — the operator doubled acts on the current line.
  if (key.name === operatorLetter(pending.kind)) {
    return {
      range: forceRange({
        from: { row: state.cursor.row, col: 0 },
        to: {
          row: state.cursor.row,
          col: lineAtRow(state.buffer, state.cursor.row).length,
        },
        linewise: true,
        inclusive: false,
      }),
    };
  }

  // After `d i`/`d a` the next key names the text-object symbol.
  if (pending.textObject !== undefined) {
    const read = readTextObject(state, key, pending.textObject === "inner");
    if (read === null) return null;
    return { range: forceRange(read.range), message: read.message };
  }

  if (key.name === ";" || key.name === ",") {
    if (state.lastFind === null) return null;
    const kind = key.name === "," ? flipFind(state.lastFind.kind) : state.lastFind.kind;
    const motion = findMotion(kind, state.lastFind.char);
    return {
      range: forceRange(
        applyMotion(motion, motionCtx(state, effectiveCount(state)), {
          inclusive: findIsInclusive(kind),
        }),
      ),
    };
  }

  if (key.name === "G") {
    const count = effectiveCount(state);
    const to = allMotions.G!(motionCtx(state, count));
    return {
      range: forceRange({
        from: state.cursor,
        to,
        linewise: true,
        inclusive: false,
      }),
    };
  }

  // `_` — count is lines spanned (absolute), not a repeated unit. Cite: nv_lineop.
  if (key.name === "_" || key.sequence === "_") {
    const count = effectiveCount(state);
    const to = allMotions._!(motionCtx(state, count));
    return {
      range: forceRange({
        from: state.cursor,
        to,
        linewise: true,
        inclusive: false,
      }),
    };
  }

  // `%` / `N%` and `|` as operator motions.
  if (key.name === "%" || key.sequence === "%" || (key.shift && key.name === "5")) {
    if (state.count !== "") {
      const to = allMotions.percentOfFile!(motionCtx(state, parsedCount(state)));
      return {
        range: forceRange({
          from: state.cursor,
          to,
          linewise: true,
          inclusive: false,
        }),
      };
    }
    return {
      range: forceRange(applyMotion(allMotions["%"]!, motionCtx(state, 1), { inclusive: true })),
    };
  }
  if (key.name === "|" || key.sequence === "|") {
    const to = allMotions["|"]!(motionCtx(state, parsedCount(state)));
    return {
      range: forceRange({
        from: state.cursor,
        to,
        linewise: false,
        inclusive: false,
      }),
    };
  }

  const motionName = motionKeyName(key);
  // `cw`/`cW` → `ce`/`cE` when not on whitespace (neovim `nv_wordcmd`).
  if (
    (motionName === "w" || motionName === "W") &&
    pending.kind === "change"
  ) {
    const bigword = motionName === "W";
    const line = lineAtRow(state.buffer, state.cursor.row);
    const ch = line[state.cursor.col];
    if (ch !== undefined && !isBlankChar(ch)) {
      if (atEndOfWord(linesOf(state.buffer), state.cursor, bigword)) {
        return {
          range: forceRange({
            from: state.cursor,
            to: state.cursor,
            linewise: false,
            inclusive: true,
          }),
        };
      }
      const endMotion = bigword ? allMotions.E! : allMotions.e!;
      return {
        range: forceRange(
          applyMotion(endMotion, motionCtx(state, effectiveCount(state)), {
            inclusive: true,
          }),
        ),
      };
    }
  }

  const motion = (allMotions as Record<string, Motion>)[motionName];
  if (motion === undefined) return null;
  const eol = (motionName === "w" || motionName === "W") && pending !== null;
  const range = applyMotion(
    motion,
    motionCtx(state, effectiveCount(state), state.cursor, motionName, eol),
    {
      inclusive: INCLUSIVE_MOTIONS.has(motionName),
      linewise: LINEWISE_MOTIONS.has(motionName),
    },
  );
  return {
    range: forceRange(
      EOL_ADJUST_MOTIONS.has(motionName)
        ? adjustCursorPastEol(range, linesOf(state.buffer))
        : range,
    ),
  };
}

/** The motion's count is the user-typed prefix times the operator's count.
 *  `2dw` = motion count 2; `d2w` = motion count 2; `2d3w` = motion count 6. */
const effectiveCount = (state: EditorState): number => {
  const base = parsedCount(state);
  const pending = state.pending;
  if (pending !== null) return base * pending.count;
  const surround = state.pendingSurround;
  if (isSurroundAddMotion(surround)) return base * surround.count;
  return base;
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
      range: { from: state.cursor, to: state.cursor, linewise: false, inclusive: false },
      message: `no ${inner ? "inner" : "outer"} ${symbol}`,
    };
  return { range };
}

const textObjectSymbol = (key: KeyEvent): string | null => {
  // OpenTUI reports shift+punctuation as name == punctuation with shift
  // true; bare punctuation as name == punctuation, shift false. The sequence
  // carries the printable glyph in both cases. Shift+letter for `iW`/`aW`
  // may keep a lowercase sequence — normalize like `motionKeyName`.
  const sequence = key.sequence;
  if (sequence && sequence.length === 1) {
    if (key.shift && (sequence === "w" || key.name === "w")) return "W";
    return sequence;
  }
  if (key.shift && key.name === "w") return "W";
  if (key.shift && key.name.length === 1) return key.name;
  return null;
};

function textObjectRange(state: EditorState, symbol: string, inner: boolean): MotionRange | null {
  if (symbol === "p") return paragraph(state, inner);
  if (symbol === "w") return word(state, inner, false);
  if (symbol === "W") return word(state, inner, true);
  if (symbol === "s") return sentence(state, inner);
  if (symbol === "t") {
    return Option.getOrNull(
      tagTextObjectRange(linesOf(state.buffer), state.cursor, filetypeOf(state), inner),
    );
  }
  // Brackets/quotes: open or close form (`i)` ≡ `i(`). Multi-line brackets via
  // findPairAround. Cite: neovim textobject.c current_block / current_quote.
  if ("(){}[]<>\"'`".includes(symbol)) return quote(state, symbol, inner);
  return null;
}

function word(state: EditorState, inner: boolean, bigword: boolean): MotionRange | null {
  // `iw`/`iW` covers the word under the cursor; `aw`/`aW` covers it plus the
  // trailing whitespace, mirroring vim's "whitespace after the word, but
  // not before it" rule. Cite: neovim textobject.c `current_word`.
  const back = bigword ? allMotions.B! : allMotions.b!;
  const end = bigword ? allMotions.E! : allMotions.e!;
  const forward = bigword ? allMotions.W! : allMotions.w!;
  const start = applyMotion(back, motionCtx(state, 1)).to;
  // `e`/`E` lands on the last char; for an exclusive `[from, to)` range we
  // need one past, which is also where the trailing whitespace begins.
  const endChar = applyMotion(end, motionCtx(state, 1, start)).to;
  if (inner) {
    return {
      from: start,
      to: { row: endChar.row, col: endChar.col + 1 },
      linewise: false,
      inclusive: false,
    };
  }
  // `aw`/`aW` extends the range to the start of the next word, or to the next
  // non-empty line when the current word is the last token of the file.
  const line = lineAtRow(state.buffer, endChar.row);
  if (endChar.col + 1 < line.length) {
    // The trailing whitespace lives on this line: skip blanks to land on
    // the next word's first character.
    const advanced = applyMotion(forward, motionCtx(state, 1, endChar)).to;
    return { from: start, to: advanced, linewise: false, inclusive: false };
  }
  if (
    endChar.row < rowCount(state.buffer) - 1 &&
    lineAtRow(state.buffer, endChar.row + 1).length > 0
  ) {
    return { from: start, to: { row: endChar.row + 1, col: 0 }, linewise: false, inclusive: false };
  }
  return {
    from: start,
    to: { row: endChar.row, col: endChar.col + 1 },
    linewise: false,
    inclusive: false,
  };
}

function paragraph(state: EditorState, _inner: boolean): MotionRange {
  // A paragraph here is the contiguous run of non-empty lines containing
  // the cursor, plus any blank line that separates it from the next
  // paragraph — `dip` on the first paragraph removes the trailing blank
  // so the remaining buffer doesn't grow a stray empty line.
  let start = state.cursor.row;
  while (start > 0 && lineAtRow(state.buffer, start - 1).length > 0) start -= 1;
  let end = state.cursor.row;
  while (end < rowCount(state.buffer) - 1 && lineAtRow(state.buffer, end + 1).length > 0) end += 1;
  // The range stays linewise, but the linewise delete already removes
  // `end` plus every line in between. Extend `end` to swallow the blank
  // that follows the paragraph when there is one and more content after.
  if (end < rowCount(state.buffer) - 1 && lineAtRow(state.buffer, end + 1).length === 0) end += 1;
  return {
    from: { row: start, col: 0 },
    to: { row: end, col: lineAtRow(state.buffer, end).length },
    linewise: true,
    inclusive: false,
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
  // Prefer surround's nested/multi-line finder (open or close form).
  const fromPair = Option.map(findPairAround(linesOf(state.buffer), state.cursor, symbol), (match) => {
    if (inner) {
      return {
        from: { row: match.openPos.row, col: match.openPos.col + 1 },
        to: match.closePos,
        linewise: false,
        inclusive: false,
      } satisfies MotionRange;
    }
    return {
      from: match.openPos,
      to: { row: match.closePos.row, col: match.closePos.col + 1 },
      linewise: false,
      inclusive: false,
    } satisfies MotionRange;
  });
  const paired = Option.getOrNull(fromPair);
  if (paired !== null) return paired;

  // Fallback: line-local open-only scan (legacy path for odd targets).
  if (!isQuotePair(symbol)) return null;
  const close = QUOTE_PAIRS[symbol];
  const line = lineAtRow(state.buffer, state.cursor.row);
  const from = line.lastIndexOf(symbol, state.cursor.col);
  if (from === -1) return null;
  const to = line.indexOf(close, from + 1);
  if (to === -1 || to <= from) return null;
  if (inner) {
    return {
      from: { row: state.cursor.row, col: from + 1 },
      to: { row: state.cursor.row, col: to },
      linewise: false,
      inclusive: false,
    };
  }
  return {
    from: { row: state.cursor.row, col: from },
    to: { row: state.cursor.row, col: to + 1 },
    linewise: false,
    inclusive: false,
  };
}

/**
 * `is` / `as` — sentence under the cursor.
 * Subset of neovim `current_sent` / `findsent`: ends at `.!?` then closers
 * `)]"'`, then whitespace or EOL. `as` includes trailing whitespace.
 */
function sentence(state: EditorState, inner: boolean): MotionRange | null {
  const lines = linesOf(state.buffer);
  const start = sentenceStart(lines, state.cursor);
  const endExclusive = sentenceEndExclusive(lines, start);
  if (endExclusive.row === start.row && endExclusive.col === start.col) return null;

  if (inner) {
    return { from: start, to: endExclusive, linewise: false, inclusive: false };
  }

  // `as`: extend through trailing blanks on the same line / following blank.
  let to = endExclusive;
  while (true) {
    const ch = charAtPos(lines, to);
    if (ch === " " || ch === "\t") {
      to = stepPos(lines, to, 1);
      continue;
    }
    break;
  }
  return { from: start, to, linewise: false, inclusive: false };
}

function applyOperator(state: EditorState, range: MotionRange): EditorState {
  // Exclusive empty region (nvim `oap->empty`). Inclusive same-point is one char.
  const empty =
    range.from.row === range.to.row &&
    range.from.col === range.to.col &&
    (range.linewise || !range.inclusive);
  if (empty) {
    return cancelChange({ ...state, pending: null, message: "no range" });
  }
  const cleared: EditorState = { ...state, pending: null, count: "" };
  switch (state.pending?.kind) {
    case "yank":
      return finishChange(yankRange(cleared, range));
    case "delete":
      return finishChange(deleteRange(cleared, range));
    case "change":
      // change enters insert — keep recording open for typed text; seal on leaveInsert.
      return changeRange(cleared, range);
    default:
      return cancelChange(cleared);
  }
}

function yankRange(state: EditorState, range: MotionRange): EditorState {
  const text = rangeText(state, range);
  const written = writeRegister(
    state,
    activeReg(state),
    { text, linewise: range.linewise },
    "yank",
  );
  return {
    ...written,
    cursor: range.from,
    message: `yanked ${describe(text, range.linewise)}`,
  };
}

function deleteRange(state: EditorState, range: MotionRange): EditorState {
  const text = rangeText(state, range);
  if (range.linewise) {
    const start = range.from.row;
    const end = range.to.row + 1;
    const next = editReplaceLines(state, start, end, []);
    const n = rowCount(next.buffer);
    const cursor = { row: Math.min(range.from.row, n - 1), col: 0 };
    const written = writeRegister(next, activeReg(state), { text, linewise: true }, "delete");
    return {
      ...written,
      cursor,
      message: `${text.length} fewer lines`,
    };
  }
  const lines = linesOf(state.buffer);
  const end = exclusiveEnd(range, lines);
  const next = editDelete(state, range.from, end);
  const written = writeRegister(next, activeReg(state), { text, linewise: false }, "delete");
  return {
    ...written,
    cursor: range.from,
    message: `${text.join("").length} chars deleted`,
  };
}

function changeRange(state: EditorState, range: MotionRange): EditorState {
  const deleted = deleteRange(state, range);
  return { ...deleted, mode: "insert", message: null };
}

function rangeText(state: EditorState, range: MotionRange): string[] {
  const lines = linesOf(state.buffer);
  if (range.linewise) return [...lines.slice(range.from.row, range.to.row + 1)];
  const end = exclusiveEnd(range, lines);
  if (range.from.row === end.row) {
    return [lines[range.from.row]!.slice(range.from.col, end.col)];
  }
  const out: string[] = [];
  out.push(lines[range.from.row]!.slice(range.from.col));
  for (let row = range.from.row + 1; row < end.row; row++) {
    out.push(lines[row]!);
  }
  out.push(lines[end.row]!.slice(0, end.col));
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
  const register = readRegister(state, activeReg(state));
  const cleared = { ...state, selectedRegister: "" };
  if (register.text.length === 0) return cleared;
  if (register.linewise) {
    const insert = register.text;
    const targetRow = side === "after" ? cleared.cursor.row + 1 : cleared.cursor.row;
    const next = editReplaceLines(cleared, targetRow, targetRow, insert);
    return {
      ...next,
      cursor: { row: targetRow, col: 0 },
      message: `put ${insert.length} line${insert.length === 1 ? "" : "s"}`,
    };
  }
  const split = side === "after" ? cleared.cursor.col + 1 : cleared.cursor.col;
  const inserted = register.text.join("\n");
  const next = editInsert(cleared, cleared.cursor.row, split, inserted);
  const firstInserted = register.text[0] ?? "";
  const cursorCol = side === "after" ? split + firstInserted.length - 1 : split;
  return {
    ...next,
    cursor: { row: cleared.cursor.row, col: cursorCol },
    message: `put ${register.text.join("").length} chars`,
  };
}

function unknownKey(state: EditorState, name: string): EditorState {
  return cancelChange({
    ...state,
    pending: null,
    pendingSurround: null,
    pendingReplace: null,
    pendingIndent: null,
    mapKeys: [],
    pendingFind: null,
    count: "",
    message: `not a normal-mode key: ${name}`,
  });
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
  const line = lineAtRow(state.buffer, state.cursor.row);
  const col = insertCol(state, line, where);
  return {
    ...state,
    mode: "insert",
    cursor: { row: state.cursor.row, col: clamp(col, 0, line.length) },
    count: "",
    insertAccum: "",
    message: null,
  };
}

function openLine(state: EditorState, where: "above" | "below"): EditorState {
  const row = state.cursor.row;
  const insertAt = where === "above" ? row : row + 1;
  const next = editReplaceLines(state, insertAt, insertAt, [""]);
  return {
    ...next,
    mode: "insert",
    cursor: { row: insertAt, col: 0 },
    count: "",
    insertAccum: "",
    message: null,
  };
}

function deleteChars(state: EditorState, dir: 1 | -1, count: number): EditorState {
  const times = Math.max(1, count);
  let next = { ...state, count: "" };
  for (let i = 0; i < times; i++) {
    if (dir < 0) {
      const { row, col } = next.cursor;
      if (col === 0) break;
      next = { ...next, cursor: { row, col: col - 1 } };
    }
    const line = lineAtRow(next.buffer, next.cursor.row);
    if (next.cursor.col >= line.length) break;
    next = deleteCharAt(next);
  }
  return next;
}

function deleteCharAt(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  const line = lineAtRow(state.buffer, row);
  if (col >= line.length) return { ...state, message: null };
  const ch = line[col] ?? "";
  const next = editDelete(state, { row, col }, { row, col: col + 1 });
  return {
    ...writeRegister(next, activeReg(state), { text: [ch], linewise: false }, "delete"),
    cursor: { row, col },
    message: null,
  };
}

// ---------------------------------------------------------------------------
// Insert mode
// ---------------------------------------------------------------------------

/**
 * CUA / modeless keys — insert primitives + Shift-select + clipboard.
 * Cite: VS Code CUA; ep-b64a91 / ts-e7d63c. Reuses `visual` as selection
 * anchor while staying in insert (half-open range).
 */
function cuaKey(state: EditorState, key: KeyEvent): EditorState {
  if (key.name === "escape") {
    return {
      ...state,
      mode: "insert",
      visual: null,
      pendingInsertReg: false,
      message: null,
    };
  }

  if (key.ctrl) {
    switch (key.name) {
      case "a":
        return cuaSelectAll(state);
      case "c":
        return cuaCopy(state);
      case "x":
        return cuaCut(state);
      case "v":
        return cuaPaste(state);
      case "z":
        return undo(finishChange({ ...state, visual: null }));
      case "y":
        return redo(finishChange({ ...state, visual: null }));
      case "e":
      case "k":
      case "w":
      case "u":
        return insertKeyBody(clearCuaSelection(state), key, {
          leaveOnEscape: false,
          vimInsertOnly: false,
        });
      default:
        return state;
    }
  }

  const isMotion =
    key.name === "left" ||
    key.name === "right" ||
    key.name === "up" ||
    key.name === "down" ||
    key.name === "home" ||
    key.name === "end" ||
    key.name === "pageup" ||
    key.name === "pagedown";
  if (isMotion) return cuaMotion(state, key, key.shift === true);

  // Typing / Delete / Backspace / Enter replace a live selection.
  const replaces =
    key.name === "backspace" ||
    key.name === "delete" ||
    key.name === "return" ||
    key.name === "enter" ||
    key.name === "tab" ||
    charFromKey(key) !== null;
  if (replaces && cuaSelectionRange(state) !== null) {
    const armed = state.changeBase === null ? startChange(state, []) : state;
    const cleared = deleteCuaSelection(armed);
    if (key.name === "backspace" || key.name === "delete") {
      return finishChange(cleared);
    }
    return insertKeyBody(cleared, key, { leaveOnEscape: false, vimInsertOnly: false });
  }

  return insertKeyBody(clearCuaSelection(state), key, {
    leaveOnEscape: false,
    vimInsertOnly: false,
  });
}

function clearCuaSelection(state: EditorState): EditorState {
  return state.visual === null ? state : { ...state, visual: null };
}

/** Half-open CUA selection, or null when empty / absent. */
function cuaSelectionRange(state: EditorState): MotionRange | null {
  if (state.visual === null) return null;
  const a = state.visual.anchor;
  const b = state.cursor;
  if (a.row === b.row && a.col === b.col) return null;
  const forward = a.row < b.row || (a.row === b.row && a.col <= b.col);
  return {
    from: forward ? a : b,
    to: forward ? b : a,
    linewise: false,
    inclusive: false,
  };
}

function deleteCuaSelection(state: EditorState): EditorState {
  const range = cuaSelectionRange(state);
  if (range === null) return clearCuaSelection(state);
  const end = exclusiveEnd(range, linesOf(state.buffer));
  return {
    ...editDelete(state, range.from, end),
    cursor: range.from,
    visual: null,
    message: null,
  };
}

function cuaSelectAll(state: EditorState): EditorState {
  const lastRow = Math.max(0, rowCount(state.buffer) - 1);
  return {
    ...state,
    mode: "insert",
    visual: { kind: "char", anchor: { row: 0, col: 0 } },
    cursor: { row: lastRow, col: lineAtRow(state.buffer, lastRow).length },
    message: null,
  };
}

function cuaCopy(state: EditorState): EditorState {
  const range = cuaSelectionRange(state);
  if (range === null) return state;
  const text = rangeText(state, range);
  const written = writeRegister(state, "+", { text, linewise: false }, "yank");
  return {
    ...written,
    cursor: state.cursor,
    visual: state.visual,
    selectedRegister: "",
    message: null,
  };
}

function cuaCut(state: EditorState): EditorState {
  const range = cuaSelectionRange(state);
  if (range === null) return state;
  const armed = startChange({ ...state, selectedRegister: "+" }, ["ctrl+x"]);
  const deleted = deleteRange(armed, range);
  return finishChange({
    ...deleted,
    visual: null,
    selectedRegister: "",
    message: null,
  });
}

function cuaPaste(state: EditorState): EditorState {
  const armed = state.changeBase === null ? startChange(state, ["ctrl+v"]) : state;
  const cleared =
    cuaSelectionRange(armed) !== null ? deleteCuaSelection(armed) : clearCuaSelection(armed);
  const plus = readRegister(cleared, "+");
  const reg = plus.text.length > 0 ? "+" : '"';
  return finishChange(insertPasteRegister(cleared, reg));
}

function cuaMotion(state: EditorState, key: KeyEvent, extend: boolean): EditorState {
  const anchor = extend ? (state.visual?.anchor ?? { ...state.cursor }) : null;
  const base = extend ? state : clearCuaSelection(state);
  let next: EditorState;
  switch (key.name) {
    case "left":
      next = insertLeft(base);
      break;
    case "right":
      next = insertRight(base);
      break;
    case "up":
      next = moveTo(base, allMotions.k!, base, "k");
      break;
    case "down":
      next = moveTo(base, allMotions.j!, base, "j");
      break;
    case "home":
      next = insertLineStart(base);
      break;
    case "end":
      next = insertLineEnd(base);
      break;
    case "pageup":
      next = moveTo(base, halfPageUp, base, "ctrl-u");
      break;
    case "pagedown":
      next = moveTo(base, halfPageDown, base, "ctrl-d");
      break;
    default:
      return base;
  }
  if (!extend || anchor === null) return next;
  return {
    ...next,
    visual: { kind: "char", anchor },
  };
}

function insertLeft(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  if (col > 0) return { ...state, cursor: { row, col: col - 1 }, count: "", message: null };
  if (row === 0) return state;
  const prevLen = lineAtRow(state.buffer, row - 1).length;
  return { ...state, cursor: { row: row - 1, col: prevLen }, count: "", message: null };
}

function insertRight(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  const line = lineAtRow(state.buffer, row);
  if (col < line.length) {
    return { ...state, cursor: { row, col: col + 1 }, count: "", message: null };
  }
  if (row + 1 >= rowCount(state.buffer)) return state;
  return { ...state, cursor: { row: row + 1, col: 0 }, count: "", message: null };
}

function insertKey(state: EditorState, key: KeyEvent): EditorState {
  if (key.ctrl && key.name === "c") return leaveInsert(state);
  return insertKeyBody(state, key, { leaveOnEscape: true, vimInsertOnly: true });
}

function insertKeyBody(
  state: EditorState,
  key: KeyEvent,
  opts: { leaveOnEscape: boolean; vimInsertOnly: boolean },
): EditorState {
  // Ctrl-r {reg}: wait for the register name, then paste (vim insert only).
  if (state.pendingInsertReg) {
    if (key.name === "escape") {
      return { ...state, pendingInsertReg: false, message: null };
    }
    const name = charFromKey(key) ?? (key.shift && key.name === "'" ? '"' : key.name);
    const reg = name.length === 1 ? name : "";
    if (!isRegisterName(reg)) {
      return { ...state, pendingInsertReg: false, message: null };
    }
    return insertPasteRegister(state, reg);
  }

  if (key.ctrl) {
    switch (key.name) {
      case "a":
        return insertLineStart(state);
      case "e":
        return insertLineEnd(state);
      case "k":
        return insertClearLineEnd(state);
      case "r":
        return opts.vimInsertOnly
          ? { ...state, pendingInsertReg: true, message: null }
          : state;
      case "w":
        return insertDeleteWord(state);
      case "u":
        return insertClearLineStart(state);
      case "t":
        return opts.vimInsertOnly ? insertShiftIndent(state, 1) : state;
      case "d":
        return opts.vimInsertOnly ? insertShiftIndent(state, -1) : state;
      case "o":
        return opts.vimInsertOnly ? armInsertCtrlO(state) : state;
      default:
        return state;
    }
  }

  switch (key.name) {
    case "escape":
      return opts.leaveOnEscape ? leaveInsert(state) : state;
    case "left":
      return insertLeft(state);
    case "right":
      return insertRight(state);
    case "up":
      return moveTo(state, allMotions.k!, state, "k");
    case "down":
      return moveTo(state, allMotions.j!, state, "j");
    case "home":
      return insertLineStart(state);
    case "end":
      return insertLineEnd(state);
    case "pageup":
      return moveTo(state, halfPageUp, state, "ctrl-u");
    case "pagedown":
      return moveTo(state, halfPageDown, state, "ctrl-d");
    case "backspace":
      return insertBackspace(state);
    case "delete":
      return insertDeleteForward(state);
    case "tab":
      return insertChar(state, "\t");
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

/** Insert/CUA home — column 0 (readline Ctrl-a). */
function insertLineStart(state: EditorState): EditorState {
  return {
    ...state,
    cursor: { row: state.cursor.row, col: 0 },
    count: "",
    message: null,
  };
}

/** Insert/CUA end — past the last character (readline Ctrl-e). */
function insertLineEnd(state: EditorState): EditorState {
  const row = state.cursor.row;
  return {
    ...state,
    cursor: { row, col: lineAtRow(state.buffer, row).length },
    count: "",
    message: null,
  };
}

/** Delete the character under the cursor (CUA / Insert Delete). */
function insertDeleteForward(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  const line = lineAtRow(state.buffer, row);
  const armed = state.changeBase === null ? startChange(state, ["delete"]) : state;
  if (col < line.length) {
    return finishChange({
      ...editDelete(armed, { row, col }, { row, col: col + 1 }),
      cursor: { row, col },
      message: null,
    });
  }
  if (row + 1 < rowCount(state.buffer)) {
    return finishChange({
      ...editDelete(armed, { row, col }, { row: row + 1, col: 0 }),
      cursor: { row, col },
      message: null,
    });
  }
  return state;
}

function leaveInsert(state: EditorState): EditorState {
  const lastInsert = { ...state.cursor };
  const withDot =
    state.insertAccum.length > 0
      ? writeRegister(state, ".", { text: state.insertAccum.split("\n"), linewise: false }, "set")
      : state;
  const left = {
    ...appendChangeKey(withDot, "escape"),
    mode: "normal" as const,
    // vim steps the cursor back one column when insert closes; it never walks
    // off the front of a line.
    cursor: { ...withDot.cursor, col: Math.max(0, withDot.cursor.col - 1) },
    lastInsert,
    count: "",
    mapKeys: [],
    pendingFind: null,
    pending: null,
    pendingSurround: null,
    pendingInsertReg: false,
    insertCtrlO: false,
    insertAccum: "",
    message: null,
  };
  return finishChange(left);
}

function insertChar(state: EditorState, char: string): EditorState {
  const { row, col } = state.cursor;
  return {
    ...appendChangeKey(editInsert(state, row, col, char), char),
    cursor: { row, col: col + char.length },
    insertAccum: state.insertAccum + char,
    message: null,
  };
}

function insertNewline(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  return {
    ...editInsert(state, row, col, "\n"),
    cursor: { row: row + 1, col: 0 },
    insertAccum: state.insertAccum + "\n",
    message: null,
  };
}

function insertBackspace(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  if (col > 0) {
    return {
      ...editDelete(state, { row, col: col - 1 }, { row, col }),
      cursor: { row, col: col - 1 },
      insertAccum: state.insertAccum.slice(0, -1),
    };
  }
  if (row > 0) {
    const prevLen = lineAtRow(state.buffer, row - 1).length;
    return {
      ...editDelete(state, { row: row - 1, col: prevLen }, { row, col: 0 }),
      cursor: { row: row - 1, col: prevLen },
      insertAccum: state.insertAccum.slice(0, -1),
    };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Replace mode (slice F) — `R`
// ---------------------------------------------------------------------------

function enterReplace(state: EditorState): EditorState {
  return {
    ...state,
    mode: "replace",
    count: "",
    insertAccum: "",
    message: null,
  };
}

function replaceKey(state: EditorState, key: KeyEvent): EditorState {
  if (key.ctrl && key.name === "c") return leaveInsert(state);
  switch (key.name) {
    case "escape":
      return leaveInsert(state);
    case "backspace":
      // Minimal: step left without restoring (full vim restore is later).
      return {
        ...state,
        cursor: {
          row: state.cursor.row,
          col: Math.max(0, state.cursor.col - 1),
        },
      };
    case "return":
    case "enter":
      return insertNewline(state);
    default: {
      const char = charFromKey(key);
      if (char === null) return state;
      return replaceChar(state, char);
    }
  }
}

function replaceChar(state: EditorState, char: string): EditorState {
  const { row, col } = state.cursor;
  const line = lineAtRow(state.buffer, row);
  if (col < line.length) {
    const next = editInsert(editDelete(state, { row, col }, { row, col: 1 + col }), row, col, char);
    return {
      ...appendChangeKey(next, char),
      cursor: { row, col: col + 1 },
      insertAccum: state.insertAccum + char,
      message: null,
    };
  }
  return insertChar(state, char);
}

// ---------------------------------------------------------------------------
// Replace / indent / join / search / visual / dot-repeat
// ---------------------------------------------------------------------------

function completeReplace(state: EditorState, key: KeyEvent): EditorState {
  const pending = state.pendingReplace;
  if (pending === null) return state;
  if (key.name === "escape") {
    return cancelChange({ ...state, pendingReplace: null, message: null });
  }
  const char = charFromKey(key);
  if (char === null) {
    return cancelChange({ ...state, pendingReplace: null, message: null });
  }
  const { row, col } = state.cursor;
  const line = lineAtRow(state.buffer, row);
  const count = Math.min(pending.count, Math.max(0, line.length - col));
  if (count === 0) {
    return finishChange({ ...appendChangeKey(state, char), pendingReplace: null });
  }
  const next = editDelete(
    { ...appendChangeKey(state, char), pendingReplace: null },
    { row, col },
    { row, col: col + count },
  );
  const inserted = editInsert(next, row, col, char.repeat(count));
  return finishChange({
    ...inserted,
    cursor: { row, col: col + count - 1 },
    message: null,
  });
}

function completeIndent(state: EditorState, key: KeyEvent): EditorState {
  const pending = state.pendingIndent;
  if (pending === null) return state;
  if (key.name === "escape") {
    return { ...state, pendingIndent: null, message: null };
  }
  const isGt = key.name === ">" || key.sequence === ">" || (key.shift && key.name === ".");
  const isLt = key.name === "<" || key.sequence === "<" || (key.shift && key.name === ",");
  if ((pending.dir === 1 && isGt) || (pending.dir === -1 && isLt)) {
    const started = startChange({ ...state, pendingIndent: null }, [
      pending.dir === 1 ? ">" : "<",
      pending.dir === 1 ? ">" : "<",
    ]);
    return finishChange(indentLines(started, pending.dir, pending.count));
  }
  return { ...state, pendingIndent: null, message: null };
}

function indentLines(state: EditorState, dir: 1 | -1, count: number): EditorState {
  const start = state.cursor.row;
  const end = Math.min(rowCount(state.buffer), start + count);
  const lines = linesOf(state.buffer);
  const tab = "  ";
  const next = lines.slice(start, end).map((line) => {
    if (dir === 1) return tab + line;
    if (line.startsWith(tab)) return line.slice(tab.length);
    if (line.startsWith("\t")) return line.slice(1);
    return line.replace(/^ {1,2}/, "");
  });
  return {
    ...editReplaceLines(state, start, end, next),
    cursor: { row: start, col: 0 },
    message: null,
  };
}

/** Join `count` lines (default 2) with a single space, like vim `J`. */
function joinLines(state: EditorState, count: number): EditorState {
  const n = Math.max(2, count);
  const start = state.cursor.row;
  const end = Math.min(rowCount(state.buffer), start + n);
  if (end - start < 2) return state;
  const parts = linesOf(state.buffer).slice(start, end);
  let joined = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    const right = parts[i]!.replace(/^\s+/, "");
    joined = joined.replace(/\s+$/, "") + (right.length === 0 ? "" : ` ${right}`);
  }
  const col = Math.max(0, parts[0]!.replace(/\s+$/, "").length);
  return {
    ...editReplaceLines(state, start, end, [joined]),
    cursor: { row: start, col },
    message: null,
  };
}

function searchKey(state: EditorState, key: KeyEvent): EditorState {
  switch (key.name) {
    case "escape":
      return { ...state, mode: idleMode(state), command: "", message: null };
    case "backspace":
      return { ...state, command: state.command.slice(0, -1) };
    case "return":
    case "enter": {
      const needle = state.command;
      if (needle === "") {
        return { ...state, mode: idleMode(state), command: "", message: null };
      }
      const lastSearch = { needle, direction: state.searchDirection, wholeWord: false };
      const withSlash = writeRegister(state, "/", { text: [needle], linewise: false }, "set");
      return runSearch(
        { ...withSlash, mode: idleMode(state), command: "", lastSearch, message: null },
        lastSearch.direction,
        false,
      );
    }
    default: {
      const char = charFromKey(key);
      if (char === null) return state;
      return { ...state, command: state.command + char };
    }
  }
}

function repeatSearch(state: EditorState, reverse: boolean): EditorState {
  if (state.lastSearch === null) return { ...state, message: "no previous search" };
  return runSearch(state, state.lastSearch.direction, reverse);
}

const isStarKey = (key: KeyEvent): boolean =>
  key.name === "*" || key.sequence === "*" || (key.shift && key.name === "8");

const isHashKey = (key: KeyEvent): boolean =>
  key.name === "#" || key.sequence === "#" || (key.shift && key.name === "3");

/**
 * `*`/`#`/`g*`/`g#` — search the keyword under the cursor.
 * Cite: neovim `nv_ident`. Whole-word for bare `*`/`#` only.
 */
function searchIdent(
  state: EditorState,
  direction: "forward" | "backward",
  wholeWord: boolean,
): EditorState {
  const lines = linesOf(state.buffer);
  return Option.match(keywordAtCursor(lines, state.cursor), {
    onNone: () => ({ ...state, message: "no identifier under cursor" }),
    onSome: ({ word, start }) => {
      const lastSearch = { needle: word, direction, wholeWord };
      const withSlash = writeRegister(state, "/", { text: [word], linewise: false }, "set");
      // nvim moves to the word start so the current match is skipped.
      return runSearch(
        {
          ...withSlash,
          cursor: start,
          lastSearch,
          count: "",
          mapKeys: [],
          message: null,
        },
        direction,
        false,
      );
    },
  });
}

function runSearch(
  state: EditorState,
  direction: "forward" | "backward",
  reverse: boolean,
): EditorState {
  const needle = state.lastSearch?.needle;
  if (needle === undefined || needle === "") return state;
  const wholeWord = state.lastSearch?.wholeWord === true;
  const dir = reverse ? (direction === "forward" ? "backward" : "forward") : direction;
  const lines = linesOf(state.buffer);
  const { row, col } = state.cursor;
  const found =
    dir === "forward"
      ? findForward(lines, needle, row, col + 1, wholeWord)
      : findBackward(lines, needle, row, col, wholeWord);
  if (found === null) {
    return { ...state, message: `pattern not found: ${needle}` };
  }
  const same = found.row === state.cursor.row && found.col === state.cursor.col;
  return {
    ...state,
    jumpList: same ? state.jumpList : pushJump(state.jumpList, state.cursor),
    cursor: found,
    searchHighlight: state.options.hlsearch,
    message: null,
  };
}

function findForward(
  lines: readonly string[],
  needle: string,
  startRow: number,
  startCol: number,
  wholeWord = false,
): { row: number; col: number } | null {
  const tryAt = (row: number, from: number, to?: number): number => {
    let col = from;
    const line = lines[row]!;
    while (col < line.length) {
      const hit = line.indexOf(needle, col);
      if (hit === -1 || (to !== undefined && hit >= to)) return -1;
      if (!wholeWord || isWholeKeyword(line, hit, needle.length)) return hit;
      col = hit + 1;
    }
    return -1;
  };
  for (let row = startRow; row < lines.length; row++) {
    const from = row === startRow ? startCol : 0;
    const col = tryAt(row, from);
    if (col !== -1) return { row, col };
  }
  for (let row = 0; row <= startRow; row++) {
    const to = row === startRow ? startCol : undefined;
    const col = tryAt(row, 0, to);
    if (col !== -1) return { row, col };
  }
  return null;
}

function findBackward(
  lines: readonly string[],
  needle: string,
  startRow: number,
  startCol: number,
  wholeWord = false,
): { row: number; col: number } | null {
  const tryAt = (row: number, to: number, from = 0): number => {
    const line = lines[row]!;
    let col = Math.min(to, line.length);
    while (col > from) {
      const hit = line.lastIndexOf(needle, Math.max(0, col - 1));
      if (hit === -1 || hit < from) return -1;
      if (hit < to && (!wholeWord || isWholeKeyword(line, hit, needle.length))) return hit;
      col = hit;
    }
    return -1;
  };
  for (let row = startRow; row >= 0; row--) {
    const to = row === startRow ? startCol : lines[row]!.length;
    const col = tryAt(row, to);
    if (col !== -1) return { row, col };
  }
  for (let row = lines.length - 1; row >= startRow; row--) {
    const from = row === startRow ? startCol : 0;
    const col = tryAt(row, lines[row]!.length, from);
    if (col !== -1) return { row, col };
  }
  return null;
}

function visualKey(state: EditorState, key: KeyEvent): EditorState {
  if (key.name === "escape") {
    return leaveVisual(state);
  }
  if (key.name === "v" && !key.shift && !key.ctrl) {
    if (state.visual?.kind === "char") {
      return leaveVisual(state);
    }
    return enterVisual(state, "char");
  }
  if (key.name === "V" || (key.shift && key.name === "v")) {
    if (state.visual?.kind === "line") {
      return leaveVisual(state);
    }
    return enterVisual(state, "line");
  }
  if (key.name === "o" || key.name === "O") {
    return swapVisualEnds(state);
  }

  const motionName = motionKeyName(key);
  const motion = singleKeyMotion(motionName);
  if (motion !== undefined) return moveTo(state, motion, state, motionName);

  if (key.name === "%" || key.sequence === "%" || (key.shift && key.name === "5")) {
    return movePercent(state);
  }
  if (key.name === "|" || key.sequence === "|") {
    return moveTo(state, allMotions["|"]!, state, "|");
  }

  const findKind = findKindOf(key);
  if (findKind !== null) {
    return { ...state, pendingFind: { kind: findKind }, message: null };
  }
  if (state.pendingFind !== null) return completeFind(state, key);

  if (isCountDigit(state, key)) {
    return { ...state, count: state.count === "0" ? key.name : state.count + key.name };
  }

  const range = visualRange(state);
  const cleared = { ...rememberVisual(state), mode: "normal" as const, visual: null };
  switch (key.name) {
    case "d":
    case "x":
      return finishChange({
        ...deleteRange(startChange(cleared, [key.name]), range),
        mode: "normal",
        visual: null,
      });
    case "c":
      return changeRange(startChange(cleared, ["c"]), range);
    case "y":
      return finishChange({
        ...yankRange(startChange(cleared, ["y"]), range),
        mode: "normal",
        visual: null,
      });
    case "~":
      return finishChange(applyCaseRange(startChange(cleared, ["~"]), range, "toggle"));
    case "=":
      return finishChange(
        autoIndentRows(startChange(cleared, ["="]), range.from.row, range.to.row),
      );
    case ">":
      return finishChange(
        indentLines(startChange(cleared, [">", ">"]), 1, range.to.row - range.from.row + 1),
      );
    case "<":
      return finishChange(
        indentLines(startChange(cleared, ["<", "<"]), -1, range.to.row - range.from.row + 1),
      );
    default:
      if (key.sequence === "~") {
        return finishChange(applyCaseRange(startChange(cleared, ["~"]), range, "toggle"));
      }
      if (key.sequence === "=") {
        return finishChange(
          autoIndentRows(startChange(cleared, ["="]), range.from.row, range.to.row),
        );
      }
      return { ...state, message: `not a visual-mode key: ${key.name}` };
  }
}

function visualRange(state: EditorState): MotionRange {
  const visual = state.visual!;
  const a = visual.anchor;
  const b = state.cursor;
  const from = a.row < b.row || (a.row === b.row && a.col <= b.col) ? a : b;
  const to = a.row < b.row || (a.row === b.row && a.col <= b.col) ? b : a;
  if (visual.kind === "line") {
    return {
      from: { row: from.row, col: 0 },
      to: { row: to.row, col: lineAtRow(state.buffer, to.row).length },
      linewise: true,
      inclusive: false,
    };
  }
  return {
    from,
    to,
    linewise: false,
    inclusive: true,
  };
}

/** Replay `lastAtom.keys` (falling back to `lastChange`) through the reducer. */
function repeatLastChange(state: EditorState): EditorState {
  const keys = state.lastAtom?.keys ?? state.lastChange?.keys;
  if (keys === undefined || keys.length === 0) {
    return { ...state, message: null };
  }
  let current: EditorState = {
    ...state,
    repeating: true,
    count: "",
    pending: null,
    pendingSurround: null,
    pendingReplace: null,
    pendingIndent: null,
    mapKeys: [],
    pendingFind: null,
  };
  for (const name of keys) {
    current = reduceEditor(current, { _tag: "key", key: keyFromName(name) });
  }
  const done: EditorState = { ...current, repeating: false };
  // `.` does not bump atomGeneration (repeating); still cascade to extras.
  if (done.extraCursors.length > 0 && done.lastAtom !== null && isCascadeable(done.lastAtom)) {
    return cascadeAtom(done, done.lastAtom, (s, name) =>
      reduceEditor(s, { _tag: "key", key: keyFromName(name) }),
    );
  }
  return done;
}

/**
 * After a content atom settles on the primary cursor, replay it at each
 * extra cursor (nvim g_atoms / clock-edge). No-op when cascading/repeating
 * or when atomGeneration did not advance.
 */
function settleCascade(
  before: EditorState,
  after: EditorState,
  commands: readonly RegisteredCommand[],
): EditorState {
  if (after.cascading || after.repeating) return after;
  if (after.atomGeneration === before.atomGeneration) return after;
  if (after.lastAtom === null || after.extraCursors.length === 0) return after;
  if (!isCascadeable(after.lastAtom)) return after;
  return cascadeAtom(after, after.lastAtom, (s, name) =>
    reduceEditor(s, { _tag: "key", key: keyFromName(name) }, commands),
  );
}

function keyFromName(name: string): KeyEvent {
  if (name.startsWith("ctrl+")) {
    return {
      name: name.slice("ctrl+".length),
      eventType: "press",
      ctrl: true,
      meta: false,
      shift: false,
      sequence: "",
    } as KeyEvent;
  }
  if (name === "escape") {
    return {
      name: "escape",
      eventType: "press",
      ctrl: false,
      meta: false,
      shift: false,
      sequence: "\x1b",
    } as KeyEvent;
  }
  if (name === "return" || name === "enter") {
    return {
      name: "return",
      eventType: "press",
      ctrl: false,
      meta: false,
      shift: false,
      sequence: "\r",
    } as KeyEvent;
  }
  if (name === "backspace") {
    return {
      name: "backspace",
      eventType: "press",
      ctrl: false,
      meta: false,
      shift: false,
      sequence: "\b",
    } as KeyEvent;
  }
  if (name === " ") {
    return {
      name: "space",
      eventType: "press",
      ctrl: false,
      meta: false,
      shift: false,
      sequence: " ",
    } as KeyEvent;
  }
  const shift = name.length === 1 && name !== name.toLowerCase();
  return {
    name: shift ? name.toLowerCase() : name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift,
    sequence: name,
  } as KeyEvent;
}

/** Replay a stored macro `count` times. `@@` uses `lastMacro`. */
function playMacro(state: EditorState, reg: string, count: number): EditorState {
  const target = reg === "@" ? state.lastMacro : reg;
  const cleared = {
    ...state,
    pendingAt: false,
    count: "",
    message: null,
  };
  if (target === null || !/^[a-z]$/.test(target)) return cleared;
  const keys = cleared.macros[target];
  if (keys === undefined || keys.length === 0) {
    return { ...cleared, message: `E354: Invalid register name: '${target}'` };
  }
  if (cleared.replayingMacro) return cleared;
  let current: EditorState = {
    ...cleared,
    lastMacro: target,
    replayingMacro: true,
  };
  const times = Math.max(1, count);
  for (let i = 0; i < times; i++) {
    for (const name of keys) {
      current = reduceEditor(current, { _tag: "key", key: keyFromName(name) });
    }
  }
  return { ...current, replayingMacro: false, pendingAt: false };
}

// ---------------------------------------------------------------------------
// Command mode
// ---------------------------------------------------------------------------

function commandKey(
  state: EditorState,
  key: KeyEvent,
  commands: readonly RegisteredCommand[],
): EditorState {
  switch (key.name) {
    case "escape":
      return {
        ...state,
        mode: idleMode(state),
        command: "",
        commandHistoryIdx: -1,
        message: null,
      };
    case "backspace":
      return {
        ...state,
        command: state.command.slice(0, -1),
        commandHistoryIdx: -1,
      };
    case "up":
      return browseCommandHistory(state, -1);
    case "down":
      return browseCommandHistory(state, 1);
    case "tab":
      return completeCommand(state, commands);
    case "return":
    case "enter":
      return executeCommand(state, commands);
    default: {
      const char = charFromKey(key);
      if (char === null) return state;
      return {
        ...state,
        command: state.command + char,
        commandHistoryIdx: -1,
      };
    }
  }
}

function executeCommand(state: EditorState, commands: readonly RegisteredCommand[]): EditorState {
  const text = state.command.trim();
  const withHistory = pushCommandHistory(state, text);
  const withColon = writeRegister(
    withHistory,
    ":",
    { text: [state.command], linewise: false },
    "set",
  );
  const next = {
    ...withColon,
    mode: idleMode(state) as EditorMode,
    command: "",
    commandHistoryIdx: -1,
  };

  const ex = applyExLine(next, text);
  if (ex.handled) return ex.state;

  const spaceAt = text.search(/\s/);
  const head = spaceAt === -1 ? text : text.slice(0, spaceAt);
  const arg = spaceAt === -1 ? "" : text.slice(spaceAt + 1).trim();
  // A trailing bang forces; only forceable commands honor it. `head.length > 1`
  // keeps a lone `!` from resolving to an empty command.
  const force = head.endsWith("!") && head.length > 1;
  const bare = force ? head.slice(0, -1) : head;
  const resolved = resolveCommand(bare, commands);
  if (resolved === null) return { ...next, message: `not an editor command: ${text}` };
  if ("ambiguous" in resolved)
    return {
      ...next,
      message: `ambiguous command: ${bare} (${resolved.ambiguous.map((command) => command.name).join(" ")})`,
    };
  const command = resolved.found;
  if (force && !command.forceable) return { ...next, message: `not an editor command: ${text}` };
  if (arg !== "" && command.nargs === "0")
    return { ...next, message: `not an editor command: ${text}` };
  if (arg === "" && command.nargs === "1" && command.builtin === "edit")
    return { ...next, message: "usage: :edit path" };

  if (command.run !== undefined) {
    return {
      ...next,
      request: { _tag: "invoke", name: command.name, arg, bang: force },
    };
  }

  if (command.builtin === "edit") {
    return { ...next, request: { _tag: "open", path: arg } };
  }
  if (command.builtin === "write") {
    if (state.file === null) return { ...next, message: "no file name (open one with :edit path)" };
    return { ...next, request: { _tag: "write" } };
  }
  if (command.builtin === "quit") {
    if (!force && state.dirty)
      return { ...next, message: "no write since last change (:wq to save and quit)" };
    return { ...next, request: { _tag: "close" } };
  }
  if (command.builtin === "wq" || command.builtin === "x") {
    if (state.file === null) return { ...next, message: "no file name (open one with :edit path)" };
    return { ...next, request: { _tag: "write-close" } };
  }
  return { ...next, message: `not an editor command: ${text}` };
}

/**
 * The menu the editor opens the instant normal-mode `:` enters command mode.
 * Pass the live table (editor.command.list()) so user commands appear too.
 */
export const editorCommandItems = (commands: readonly RegisteredCommand[] = BUILTIN_COMMANDS) =>
  commands.flatMap((command) => [
    {
      id: command.name,
      label: `:${command.name}`,
      detail:
        command.builtin === "edit"
          ? "open a file"
          : command.builtin === "write"
            ? "save the file"
            : command.builtin === "quit"
              ? "close the editor"
              : command.builtin === "wq" || command.builtin === "x"
                ? "save and close"
                : "user command",
      replacement: `${command.name}${command.nargs === "1" ? " " : ""}`,
    },
    ...(command.forceable
      ? [
          {
            id: `${command.name}!`,
            label: `:${command.name}!`,
            detail: command.builtin === "quit" ? "close without saving" : "force",
            replacement: `${command.name}!`,
          },
        ]
      : []),
  ]);

/** Every form Tab can complete: canonical names plus the force form. */
const completionCandidates = (commands: readonly RegisteredCommand[]): readonly string[] =>
  commands.flatMap((command) =>
    command.forceable ? [command.name, `${command.name}!`] : [command.name],
  );

/**
 * Tab in command mode expands toward the canonical name — a unique match
 * fills outright (`:edit` gains the space its path argument needs) — and an
 * ambiguous prefix lists its matches on the status line. File arguments are
 * a later picker over the search service, not a string prefix, so a line
 * already past its first space is left for the picker.
 */
function completeCommand(state: EditorState, commands: readonly RegisteredCommand[]): EditorState {
  if (state.command.includes(" ")) return state;
  const head = state.command;
  if (head === "") return { ...state, message: completionCandidates(commands).join(" ") };
  const force = head.endsWith("!") && head.length > 1;
  const bare = force ? head.slice(0, -1) : head;
  const suffix = force ? "!" : "";
  const resolved = resolveCommand(bare, commands);
  if (resolved === null) return { ...state, message: `no command matches: ${head}` };
  if ("ambiguous" in resolved) {
    const names = resolved.ambiguous.map((command) => command.name);
    const common = longestCommonPrefix(names);
    if (common.length > bare.length)
      return { ...state, command: `${common}${suffix}`, message: null };
    return { ...state, message: names.join(" ") };
  }
  const command = resolved.found;
  if (force && !command.forceable) return { ...state, message: `no command matches: ${head}` };
  return {
    ...state,
    command: `${command.name}${suffix}${command.nargs === "1" ? " " : ""}`,
    message: null,
  };
}

function longestCommonPrefix(commands: readonly string[]): string {
  const [first, ...rest] = commands;
  if (first === undefined) return "";
  let end = first.length;
  for (const command of rest) {
    while (end > 0 && !command.startsWith(first.slice(0, end))) end--;
  }
  return first.slice(0, end);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Range for palette / `:Surround` — CUA selection, vim visual (as half-open),
 * word under cursor, else current line. Cite: ep-f9d55b / ts-db433b.
 */
export function surroundRange(state: EditorState): MotionRange {
  if (state.visual !== null) {
    const a = state.visual.anchor;
    const b = state.cursor;
    if (!(a.row === b.row && a.col === b.col)) {
      const forward = a.row < b.row || (a.row === b.row && a.col <= b.col);
      const from = forward ? a : b;
      const to = forward ? b : a;
      if (state.mode === "visual") {
        // Vim visual endpoints are inclusive; wrapWith wants half-open.
        const inclusive: MotionRange = {
          from,
          to,
          linewise: state.visual.kind === "line",
          inclusive: true,
        };
        if (inclusive.linewise) {
          return {
            from: { row: from.row, col: 0 },
            to: { row: to.row, col: lineAtRow(state.buffer, to.row).length },
            linewise: true,
            inclusive: false,
          };
        }
        return {
          from,
          to: exclusiveEnd(inclusive, linesOf(state.buffer)),
          linewise: false,
          inclusive: false,
        };
      }
      // CUA selection is already half-open.
      return { from, to, linewise: false, inclusive: false };
    }
  }
  const under = word(state, true, false);
  if (under !== null) return under;
  return currentLineRange(state);
}

/** Wrap the surround range with `target` (`b` / `)` / `"` / …). */
export function applySurround(state: EditorState, target: string): EditorState {
  const trimmed = target.trim();
  const char = trimmed.length === 0 ? "" : trimmed[0]!;
  if (char.length === 0) {
    return { ...state, message: "Surround: need a delimiter (e.g. ) \" b)" };
  }
  const range = surroundRange(state);
  const mode = state.options.keyProfile === "cua" ? ("insert" as const) : ("normal" as const);
  const armed = startChange(
    { ...state, mode, visual: null, pendingSurround: null },
    ["surround", char],
  );
  return applySurroundEdit(
    armed,
    addSurround(linesOf(armed.buffer), range, char),
    `unknown surround ${char}`,
  );
}

/**
 * Arm the existing surround char-wait so the next keystroke finishes the
 * wrap (palette: pick Surround, then type `)`).
 */
export function beginSurround(state: EditorState): EditorState {
  const range = surroundRange(state);
  const mode =
    state.mode === "visual"
      ? ("normal" as const)
      : state.options.keyProfile === "cua"
        ? ("insert" as const)
        : state.mode;
  return {
    ...awaitSurroundChar({ ...state, mode, visual: null }, range, 1),
    message: "surround: type a delimiter",
  };
}

/** Palette / CUA: open `/` search (reuse vim search mode + status chrome). */
export function beginSearch(
  state: EditorState,
  direction: "forward" | "backward" = "forward",
): EditorState {
  return enterSearch({ ...state, visual: null }, direction);
}

/** Palette / CUA: open cmdline prefilled for buffer-wide substitute. */
export function beginSubstitute(state: EditorState): EditorState {
  return {
    ...state,
    mode: "command",
    command: "%s/",
    visual: null,
    count: "",
    commandHistoryIdx: -1,
    message: null,
  };
}
