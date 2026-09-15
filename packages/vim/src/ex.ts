/**
 * Ex-command depth — ranges, `:s`, line ops, `:set` / `:noh`, `:r` / `:put` /
 * `:m` / `:t`, and cmdline history. Cite: checklist H (ts-625d83); vim
 * cmdline.c address / ex_cmds shape, not a full ex engine.
 *
 * `:!` line filter is deferred; `:r!{cmd}` (shell → buffer) is supported.
 */
import type { EditorOptions, EditorState, Register } from "./schema.ts";
import { editReplaceLines, linesOf, rowCount } from "./buffer-state.ts";
import { finishChange, startChange } from "./history.ts";
import { press, type Key } from "./key.ts";
import { readRegister, writeRegister } from "./registers.ts";

export const defaultEditorOptions = (): EditorOptions => ({
  tabstop: 2,
  expandtab: true,
  number: true,
  hlsearch: true,
  keyProfile: "vim",
});

export const initialExState = () =>
  ({
    options: defaultEditorOptions(),
    searchHighlight: false,
    commandHistory: [] as readonly string[],
    commandHistoryIdx: -1,
  }) as const;

/** Inclusive 0-based line range. */
export type LineRange = {
  readonly start: number;
  readonly end: number;
};

const clampLine = (row: number, n: number): number =>
  Math.max(0, Math.min(row, Math.max(0, n - 1)));

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isLower = (ch: string): boolean => ch >= "a" && ch <= "z";
const isAlpha = (ch: string): boolean => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");

const parseAddress = (
  src: string,
  from: number,
  state: EditorState,
  base: number,
): { readonly addr: number; readonly next: number } | null => {
  const n = rowCount(state.buffer);
  let i = from;
  while (i < src.length && src[i] === " ") i++;
  if (i >= src.length) return null;

  let addr = base;
  const ch = src[i]!;
  if (ch === ".") {
    addr = state.cursor.row;
    i++;
  } else if (ch === "$") {
    addr = Math.max(0, n - 1);
    i++;
  } else if (ch === "'") {
    const mark = src[i + 1];
    if (mark === undefined || !isLower(mark)) return null;
    const pos = state.marks[mark];
    if (pos === undefined) return null;
    addr = pos.row;
    i += 2;
  } else if (isDigit(ch)) {
    let j = i;
    while (j < src.length && isDigit(src[j]!)) j++;
    const oneBased = Number(src.slice(i, j));
    if (!Number.isFinite(oneBased) || oneBased < 0) return null;
    // Vim address 0 = before the first line (dest for :m0 / :t0).
    addr = oneBased === 0 ? -1 : clampLine(oneBased - 1, n);
    i = j;
  } else if (ch === "+" || ch === "-") {
    // Relative alone: .+N / .-N with implicit `.`
    addr = base;
  } else {
    return null;
  }

  while (i < src.length && (src[i] === "+" || src[i] === "-")) {
    const sign = src[i] === "-" ? -1 : 1;
    i++;
    let mag = 1;
    if (i < src.length && isDigit(src[i]!)) {
      let j = i;
      while (j < src.length && isDigit(src[j]!)) j++;
      mag = Number(src.slice(i, j));
      i = j;
    }
    addr = clampLine(addr + sign * mag, n);
  }

  return { addr, next: i };
};

/**
 * Split an ex line into an optional range and the remainder.
 * `%` → whole file. Empty range → null (caller picks default).
 */
export const splitRange = (
  text: string,
  state: EditorState,
): { readonly range: LineRange | null; readonly rest: string } | null => {
  const src = text.trimStart();
  if (src.startsWith("%")) {
    const n = rowCount(state.buffer);
    return {
      range: { start: 0, end: Math.max(0, n - 1) },
      rest: src.slice(1).trimStart(),
    };
  }

  const first = parseAddress(src, 0, state, state.cursor.row);
  if (first === null) {
    return { range: null, rest: src };
  }

  let i = first.next;
  let start = first.addr;
  let end = first.addr;

  while (i < src.length && src[i] === " ") i++;
  if (i < src.length && (src[i] === "," || src[i] === ";")) {
    const sep = src[i]!;
    i++;
    const base = sep === ";" ? start : state.cursor.row;
    const second = parseAddress(src, i, state, base);
    if (second === null) return null;
    end = second.addr;
    i = second.next;
  }

  while (i < src.length && src[i] === " ") i++;
  // Bare address with no command → goto (rest empty, range single line).
  if (i >= src.length) {
    return { range: { start, end: start }, rest: "" };
  }

  // Address must be followed by a command letter / known head — not another digit.
  if (isDigit(src[i]!)) return null;

  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  return { range: { start, end }, rest: src.slice(i) };
};

const rememberHistory = (state: EditorState, line: string): EditorState => {
  const trimmed = line.trim();
  if (trimmed === "") {
    return { ...state, commandHistoryIdx: -1 };
  }
  const prev = state.commandHistory;
  if (prev[prev.length - 1] === trimmed) {
    return { ...state, commandHistoryIdx: -1 };
  }
  return {
    ...state,
    commandHistory: [...prev, trimmed],
    commandHistoryIdx: -1,
  };
};

export const browseCommandHistory = (state: EditorState, dir: -1 | 1): EditorState => {
  const hist = state.commandHistory;
  if (hist.length === 0) return state;
  let idx = state.commandHistoryIdx;
  if (idx === -1) {
    if (dir === 1) return state;
    idx = hist.length;
  }
  const next = idx + dir;
  if (next < 0) return state;
  if (next >= hist.length) {
    return { ...state, command: "", commandHistoryIdx: -1 };
  }
  return {
    ...state,
    command: hist[next] ?? "",
    commandHistoryIdx: next,
  };
};

const withUndo = (
  state: EditorState,
  keys: readonly Key[],
  body: (s: EditorState) => EditorState,
): EditorState => finishChange(body(startChange(state, keys)));

const defaultRange = (state: EditorState, range: LineRange | null): LineRange =>
  range ?? { start: state.cursor.row, end: state.cursor.row };

/**
 * Split `rest` into command name, optional bang, and argument.
 * Name is alphabetic only; `!` is a separate flag (force / `:r!`).
 * Cite: vim ex command parsing — not a regex over the whole line.
 */
const parseExHead = (
  rest: string,
): { readonly name: string; readonly bang: boolean; readonly arg: string } | null => {
  if (rest.length === 0) return null;
  if (!isAlpha(rest[0]!)) return null;
  let i = 0;
  while (i < rest.length && isAlpha(rest[i]!)) i++;
  const name = rest.slice(0, i);
  let bang = false;
  if (i < rest.length && rest[i] === "!") {
    bang = true;
    i++;
  }
  while (i < rest.length && rest[i] === " ") i++;
  return { name, bang, arg: rest.slice(i) };
};

const parseSubstitute = (
  body: string,
): { readonly pat: string; readonly repl: string; readonly flags: string } | null => {
  // Expect `/pat/repl/flags` (any non-alnum delimiter). Body is after `s`/`substitute`.
  let i = 0;
  while (i < body.length && body[i] === " ") i++;
  if (i >= body.length) return { pat: "", repl: "", flags: "" };
  const delim = body[i]!;
  if (isAlpha(delim) || isDigit(delim) || delim === "\\") return null;
  i++;
  let pat = "";
  while (i < body.length && body[i] !== delim) {
    if (body[i] === "\\" && i + 1 < body.length) {
      pat += body[i + 1];
      i += 2;
      continue;
    }
    pat += body[i];
    i++;
  }
  if (i >= body.length || body[i] !== delim) return null;
  i++;
  let repl = "";
  while (i < body.length && body[i] !== delim) {
    if (body[i] === "\\" && i + 1 < body.length) {
      const n = body[i + 1]!;
      repl += n === "n" ? "\n" : n === "t" ? "\t" : n;
      i += 2;
      continue;
    }
    repl += body[i];
    i++;
  }
  if (i < body.length && body[i] === delim) i++;
  return { pat, repl, flags: body.slice(i) };
};

const applySubstitute = (
  state: EditorState,
  range: LineRange,
  pat: string,
  repl: string,
  flags: string,
): EditorState => {
  if (pat === "") {
    const last = state.lastSearch?.needle;
    if (last === undefined || last === "") {
      return { ...state, message: "No previous regular expression" };
    }
    pat = last;
  }
  const global = flags.includes("g");
  const ignoreCase = flags.includes("i");
  let re: RegExp;
  try {
    re = new RegExp(pat, `${global ? "g" : ""}${ignoreCase ? "i" : ""}`);
  } catch {
    return { ...state, message: `Invalid regular expression: ${pat}` };
  }

  const lines = [...linesOf(state.buffer)];
  let count = 0;
  let firstRow = -1;
  for (let row = range.start; row <= range.end; row++) {
    const line = lines[row] ?? "";
    if (!re.test(line)) {
      re.lastIndex = 0;
      continue;
    }
    re.lastIndex = 0;
    const next = line.replace(re, repl);
    if (next !== line) {
      lines[row] = next;
      count++;
      if (firstRow < 0) firstRow = row;
    }
    re.lastIndex = 0;
  }
  if (count === 0) return { ...state, message: `Pattern not found: ${pat}` };
  const next = editReplaceLines(state, 0, rowCount(state.buffer), lines);
  return {
    ...next,
    cursor: { row: firstRow < 0 ? state.cursor.row : firstRow, col: 0 },
    lastSearch: {
      needle: pat,
      direction: state.lastSearch?.direction ?? "forward",
      wholeWord: false,
    },
    searchHighlight: state.options.hlsearch,
    message: `${count} substitution${count === 1 ? "" : "s"} on ${count} line${count === 1 ? "" : "s"}`,
  };
};

const deleteLines = (state: EditorState, range: LineRange): EditorState => {
  const lines = linesOf(state.buffer);
  const cut = lines.slice(range.start, range.end + 1);
  const reg: Register = { text: cut, linewise: true };
  const written = writeRegister(state, "", reg, "delete");
  const next = editReplaceLines(written, range.start, range.end + 1, []);
  const n = rowCount(next.buffer);
  const row = clampLine(range.start, n);
  return {
    ...next,
    cursor: { row, col: 0 },
    message: `${cut.length} fewer line${cut.length === 1 ? "" : "s"}`,
  };
};

const copyOrMove = (
  state: EditorState,
  range: LineRange,
  destRest: string,
  move: boolean,
): EditorState => {
  const destParse = parseAddress(
    destRest.trim() === "" ? "." : destRest.trim(),
    0,
    state,
    state.cursor.row,
  );
  if (destParse === null) return { ...state, message: "Invalid address" };
  const dest = destParse.addr;
  const lines = linesOf(state.buffer);
  const block = lines.slice(range.start, range.end + 1);
  if (move) {
    // Delete first, then insert after dest (adjust if dest is below the range).
    let insertAt = dest + 1;
    const without = editReplaceLines(state, range.start, range.end + 1, []);
    if (dest >= range.start) {
      insertAt = dest + 1 - block.length;
    }
    insertAt = Math.max(0, Math.min(insertAt, rowCount(without.buffer)));
    const next = editReplaceLines(without, insertAt, insertAt, block);
    return {
      ...next,
      cursor: { row: insertAt, col: 0 },
      message: `${block.length} line${block.length === 1 ? "" : "s"} moved`,
    };
  }
  const insertAt = Math.max(0, Math.min(dest + 1, lines.length));
  const next = editReplaceLines(state, insertAt, insertAt, block);
  return {
    ...next,
    cursor: { row: insertAt, col: 0 },
    message: `${block.length} line${block.length === 1 ? "" : "s"} copied`,
  };
};

const putEx = (state: EditorState, range: LineRange, arg: string): EditorState => {
  const name = arg.trim() === "" ? "" : arg.trim().replace(/^"/, "");
  const reg = readRegister(state, name === "" ? state.selectedRegister || '"' : name);
  if (reg.text.length === 0) return { ...state, message: "Nothing in register" };
  const insertAt = range.end + 1;
  const text = reg.linewise ? reg.text : [reg.text.join("\n")];
  const next = editReplaceLines({ ...state, selectedRegister: "" }, insertAt, insertAt, text);
  return {
    ...next,
    cursor: { row: insertAt, col: 0 },
    message: `${text.length} more line${text.length === 1 ? "" : "s"}`,
  };
};

const applySet = (state: EditorState, arg: string): EditorState => {
  const raw = arg.trim();
  if (raw === "") {
    const o = state.options;
    return {
      ...state,
      message: `tabstop=${o.tabstop} expandtab number hlsearch — :set ${o.expandtab ? "" : "no"}expandtab …`,
    };
  }
  const parts = raw.split(/\s+/);
  let options = { ...state.options };
  let nomodifiable = state.nomodifiable;
  let searchHighlight = state.searchHighlight;
  const messages: string[] = [];

  for (const part of parts) {
    if (part.endsWith("?")) {
      const name = part.slice(0, -1);
      if (name === "tabstop" || name === "ts") messages.push(`tabstop=${options.tabstop}`);
      else if (name === "expandtab" || name === "et")
        messages.push(options.expandtab ? "expandtab" : "noexpandtab");
      else if (name === "number" || name === "nu")
        messages.push(options.number ? "number" : "nonumber");
      else if (name === "hlsearch" || name === "hls")
        messages.push(options.hlsearch ? "hlsearch" : "nohlsearch");
      else if (name === "modifiable" || name === "ma")
        messages.push(state.nomodifiable ? "nomodifiable" : "modifiable");
      else return { ...state, message: `Unknown option: ${name}` };
      continue;
    }
    const off = part.startsWith("no");
    const name = off ? part.slice(2) : part;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      const key = name.slice(0, eq);
      const val = name.slice(eq + 1);
      if (key === "tabstop" || key === "ts") {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 1 || n > 64) {
          return { ...state, message: `Invalid tabstop: ${val}` };
        }
        options = { ...options, tabstop: Math.floor(n) };
        continue;
      }
      return { ...state, message: `Unknown option: ${key}` };
    }
    if (name === "expandtab" || name === "et") options = { ...options, expandtab: !off };
    else if (name === "number" || name === "nu") options = { ...options, number: !off };
    else if (name === "hlsearch" || name === "hls") {
      options = { ...options, hlsearch: !off };
      if (off) searchHighlight = false;
    } else if (name === "modifiable" || name === "ma") {
      // `:set nomodifiable` → off; `:set modifiable` → on. Stored inverted on state.
      nomodifiable = off;
    } else return { ...state, message: `Unknown option: ${part}` };
  }

  return {
    ...state,
    options,
    nomodifiable,
    searchHighlight,
    message: messages.length > 0 ? messages.join("  ") : null,
  };
};

/**
 * Try to run an ex-depth command. Returns null when the line should fall
 * through to the shallow builtins (`:e` / `:w` / `:q` / user commands).
 */
export const tryExCommand = (state: EditorState, text: string): EditorState | null => {
  const trimmed = text.trim();
  if (trimmed === "") return { ...state, message: null };

  if (trimmed.startsWith("!")) {
    return { ...state, message: "shell filter :! not implemented yet" };
  }

  const split = splitRange(trimmed, state);
  if (split === null) return { ...state, message: `Invalid range: ${trimmed}` };
  const { range, rest } = split;

  // Bare `:42` — jump to line.
  if (rest === "" && range !== null) {
    return {
      ...state,
      cursor: { row: Math.max(0, range.start), col: 0 },
      message: null,
    };
  }

  const parsed = parseExHead(rest);
  if (parsed === null) return null;
  const { name, bang, arg } = parsed;

  // Builtin ex heads are lowercase; uppercase / CamelCase fall through so
  // user commands (`:R!`, `:Reload`) still resolve. Cite: api.test Reload.
  if ([...name].some((ch) => !isLower(ch))) {
    if (range !== null) return { ...state, message: `not an editor command: ${trimmed}` };
    return null;
  }

  // File builtins — leave to executeCommand's resolve path.
  if (
    name === "e" ||
    name === "edit" ||
    name === "w" ||
    name === "write" ||
    name === "q" ||
    name === "quit" ||
    name === "wq" ||
    name === "x" ||
    name === "xit"
  ) {
    return null;
  }

  if (name === "set" || name === "se") {
    return applySet(state, arg);
  }

  if (name === "noh" || name === "nohl" || name === "nohlsearch") {
    return { ...state, searchHighlight: false, message: null };
  }

  if (name === "s" || name === "substitute") {
    const sub = parseSubstitute(arg);
    if (sub === null) return { ...state, message: "Invalid :s command" };
    if (sub.pat === "" && sub.repl === "" && sub.flags === "" && arg === "") {
      return { ...state, message: "Usage: :[range]s/pat/repl/[flags]" };
    }
    const r = defaultRange(state, range);
    return withUndo(state, [press(":"), press(trimmed)], (s) =>
      applySubstitute(s, r, sub.pat, sub.repl, sub.flags),
    );
  }

  if (name === "d" || name === "delete") {
    const r = defaultRange(state, range);
    return withUndo(state, [press(":"), press(trimmed)], (s) => deleteLines(s, r));
  }

  if (name === "m" || name === "move") {
    const r = defaultRange(state, range);
    return withUndo(state, [press(":"), press(trimmed)], (s) => copyOrMove(s, r, arg, true));
  }

  if (name === "t" || name === "co" || name === "copy") {
    const r = defaultRange(state, range);
    return withUndo(state, [press(":"), press(trimmed)], (s) => copyOrMove(s, r, arg, false));
  }

  if (name === "pu" || name === "put") {
    const r = defaultRange(state, range);
    return withUndo(state, [press(":"), press(trimmed)], (s) => putEx(s, r, arg));
  }

  if (name === "r" || name === "read") {
    const afterRow = range !== null ? range.end : state.cursor.row;
    if (bang) {
      const cmd = arg.trim();
      if (cmd === "") return { ...state, message: "usage: :[addr]r!{cmd}" };
      return {
        ...state,
        request: { _tag: "shell-read", cmd, afterRow },
        message: null,
      };
    }
    const path = arg.trim();
    if (path === "") return { ...state, message: "usage: :r path" };
    return {
      ...state,
      request: { _tag: "read", path, afterRow },
      message: null,
    };
  }

  // Unknown head with a range prefix is still an error; without range, fall through
  // so user-registered commands resolve.
  if (range !== null) {
    return { ...state, message: `not an editor command: ${trimmed}` };
  }
  return null;
};

export type ExLineResult = {
  readonly handled: boolean;
  readonly state: EditorState;
};

export const applyExLine = (state: EditorState, text: string): ExLineResult => {
  const result = tryExCommand(state, text);
  if (result === null) return { handled: false, state };
  return { handled: true, state: result };
};

export const pushCommandHistory = rememberHistory;
