/**
 * Motion-to-range: the pure algebra a normal-mode keypress asks for.
 *
 * Shape mirrors Neovim's `oparg_T`: endpoints plus `linewise` and
 * `inclusive` (cite: ../neovim/src/nvim/normal_defs.h). Charwise operators
 * convert via {@link exclusiveEnd} to a half-open `[from, end)` for edits.
 *
 * - exclusive (`inclusive: false`): character at `to` is not covered (`dw`).
 * - inclusive (`inclusive: true`): character at `to` is covered (`de`, `dfx`, `%`).
 */
import { Match, Option } from "effect";
import { Schema as S } from "effect";
import type { Cursor } from "./schema.ts";

export const MotionRange = S.Struct({
  from: S.Struct({ row: S.Int, col: S.Int }),
  to: S.Struct({ row: S.Int, col: S.Int }),
  linewise: S.Boolean,
  /** Charwise only — ignored when `linewise`. Mirrors `oparg_T.inclusive`. */
  inclusive: S.Boolean,
});
export type MotionRange = S.Schema.Type<typeof MotionRange>;

export type MotionOpts = {
  readonly linewise?: boolean;
  readonly inclusive?: boolean;
};

export interface MotionContext {
  readonly lines: readonly string[];
  readonly cursor: Cursor;
  readonly count: number;
  /** Preferred column for vertical motions — neovim `w_curswant`. */
  readonly curswant: number;
  /** Visible window — H/M/L and half-page motions read this. */
  readonly viewport: { readonly top: number; readonly height: number };
  /**
   * Operator-pending `fwd_word` stop-at-EOL. Set for the last unit of a
   * counted `w`/`W` under an operator. Cite: neovim `fwd_word(..., eol)`.
   */
  readonly eol?: boolean;
}

export type Motion = (ctx: MotionContext) => Cursor;

/** Half-open end for charwise ops. Linewise returns `to` unchanged. */
export function exclusiveEnd(range: MotionRange, lines: readonly string[]): Cursor {
  if (range.linewise || !range.inclusive) return { ...range.to };
  const line = lines[range.to.row] ?? "";
  if (range.to.col < line.length) {
    return { row: range.to.row, col: range.to.col + 1 };
  }
  if (range.to.row + 1 < lines.length) {
    return { row: range.to.row + 1, col: 0 };
  }
  return { row: range.to.row, col: line.length };
}

/** Apply Neovim-style `motion_force` after a motion resolves. */
export function applyMotionForce(
  range: MotionRange,
  force: Option.Option<"v" | "V" | "block">,
): MotionRange {
  return Option.match(force, {
    onNone: () => range,
    onSome: (kind) =>
      Match.value(kind).pipe(
        Match.when("V", () => ({ ...range, linewise: true, inclusive: false })),
        Match.when("block", () => ({ ...range, linewise: false, inclusive: true })),
        Match.orElse(() => {
          // 'v': force charwise; toggle inclusive when the motion was already charwise
          // (nvim do_pending_operator). Linewise → exclusive charwise.
          if (range.linewise) return { ...range, linewise: false, inclusive: false };
          return { ...range, linewise: false, inclusive: !range.inclusive };
        }),
      ),
  });
}

/** Motions whose landing character is included under an operator (nvim). */
export const INCLUSIVE_MOTIONS = new Set(["e", "E", "$", "%", "ge", "gE"]);

/** Motions that are linewise under an operator. Cite: neovim `nv_down`/`nv_up`/`nv_goto`/`nv_lineop`. */
export const LINEWISE_MOTIONS = new Set(["j", "k", "G", "firstLine", "+", "-", "CR", "_"]);

/** Compose a count with a motion that moves one unit. The range's `from`
 *  stays at the starting cursor so operators can reconstruct what was
 *  covered. */
export function applyMotion(
  motion: Motion,
  ctx: MotionContext,
  opts: boolean | MotionOpts = {},
): MotionRange {
  const normalized: MotionOpts = typeof opts === "boolean" ? { linewise: opts } : opts;
  let to = ctx.cursor;
  for (let index = 0; index < ctx.count; index++) {
    const prev = to;
    // `eol` only on the last counted unit — neovim `fwd_word` `count == 0`.
    to = motion({
      ...ctx,
      cursor: to,
      count: 1,
      eol: ctx.eol === true && index === ctx.count - 1,
    });
    if (to.row === prev.row && to.col === prev.col) break;
    if (to.row >= ctx.lines.length - 1 && to.col >= ctx.lines[to.row]!.length) break;
  }
  return {
    from: ctx.cursor,
    to,
    linewise: normalized.linewise ?? false,
    inclusive: normalized.inclusive ?? false,
  };
}

type CharClass = "blank" | "word" | "other";

/**
 * Default `'iskeyword'` = `@,48-57,_,192-255` (neovim options.lua).
 * Latin1 only — no `:set iskeyword` yet. Cite: charset.c `vim_iswordc_tab`,
 * `parse_isopt` (`@` → letters via isalpha range).
 */
const isWord = (char: string): boolean => {
  const c = char.codePointAt(0);
  if (c === undefined || c === 0) return false;
  // Multibyte: nvim uses utf_class_tab ≥ 2; keep Latin1-first for this slice.
  if (c >= 0x100) return false;
  if (c >= 48 && c <= 57) return true; // 0-9
  if (c === 95) return true; // _
  if (c >= 192 && c <= 255) return true; // 192-255
  // `@` → alphabetic in 1–255 (ASCII letters; locale letters deferred)
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
};
const isBlank = (char: string): boolean => char === " " || char === "\t";

/**
 * Character class for word motions.
 * Cite: neovim `textobject.c` `cls` + `mbyte.c` `utf_class_tab` (Latin1):
 * blank / punctuation (`other`) / keyword (`word`). With `bigword` (W/B/E),
 * every non-blank collapses to one class — only whitespace boundaries matter.
 */
function classAt(line: string, col: number, bigword = false): CharClass {
  // Off-end / NUL reads as blank, matching neovim's `gchar_cursor` on EOL.
  if (col < 0 || col >= line.length) return "blank";
  const char = line[col]!;
  if (isBlank(char)) return "blank";
  if (bigword) return "word";
  if (isWord(char)) return "word";
  return "other";
}

/** Advance one char; cross the line boundary like neovim `inc_cursor`.
 *  A line's `length` column is the EOL NUL (blank class) — matching vim's
 *  cursor-on-NUL before `adjust_cursor` pulls it back onto the last char. */
const stepForward = (
  lines: readonly string[],
  pos: { row: number; col: number },
): boolean => {
  const line = lines[pos.row]!;
  // Still on a real character (including the last): step onto the next
  // char or onto the EOL NUL at `line.length`.
  if (pos.col < line.length) {
    pos.col += 1;
    return true;
  }
  // Already on NUL — cross to the next line.
  if (pos.row >= lines.length - 1) return false;
  pos.row += 1;
  pos.col = 0;
  return true;
};

/** Retreat one char; cross the line boundary like neovim `dec_cursor`. */
const stepBack = (
  lines: readonly string[],
  pos: { row: number; col: number },
): boolean => {
  if (pos.col > 0) {
    pos.col -= 1;
    return true;
  }
  if (pos.row === 0) return false;
  pos.row -= 1;
  const line = lines[pos.row]!;
  // Land on the previous line's last char (not its NUL).
  pos.col = line.length === 0 ? 0 : line.length - 1;
  return true;
};

/**
 * Neovim `adjust_cursor`: if a motion landed on the EOL NUL, step back onto
 * the last character and mark the motion inclusive (so `yw` covers the word).
 * Cite: neovim normal.c `adjust_cursor`.
 */
export function adjustCursorPastEol(
  range: MotionRange,
  lines: readonly string[],
): MotionRange {
  const line = lines[range.to.row] ?? "";
  if (range.to.col > 0 && range.to.col >= line.length && line.length > 0) {
    return {
      ...range,
      to: { row: range.to.row, col: line.length - 1 },
      inclusive: true,
    };
  }
  return range;
}

/**
 * `w` / `W` — forward to the start of the next word/WORD.
 * Cite: neovim textobject.c `fwd_word`. With `eol`, stop on the line's NUL
 * instead of crossing (operator-pending).
 */
export const wordForward =
  (bigword: boolean): Motion =>
  ({ lines, cursor, eol }) => {
    const pos = { row: cursor.row, col: cursor.col };
    const klassOf = (r: number, c: number): CharClass =>
      classAt(lines[r] ?? "", c, bigword);

    const step = (): "ok" | "stop" | "fail" => {
      const before = { row: pos.row, col: pos.col };
      if (!stepForward(lines, pos)) return "fail";
      if (eol === true && pos.row !== before.row) {
        pos.row = before.row;
        pos.col = lines[before.row]!.length;
        return "stop";
      }
      return "ok";
    };

    const sclass = klassOf(pos.row, pos.col);
    const first = step();
    if (first !== "ok") return { row: pos.row, col: pos.col };

    if (sclass !== "blank") {
      while (klassOf(pos.row, pos.col) === sclass) {
        const r = step();
        if (r !== "ok") return { row: pos.row, col: pos.col };
      }
    }
    while (klassOf(pos.row, pos.col) === "blank") {
      if (pos.col === 0 && lines[pos.row]!.length === 0) break;
      const r = step();
      if (r !== "ok") return { row: pos.row, col: pos.col };
    }
    return { row: pos.row, col: pos.col };
  };

export const wordForwardSmall = wordForward(false);
export const wordForwardBig = wordForward(true);

/**
 * `b` / `B` — back to the start of the previous/current word/WORD.
 * Cite: neovim textobject.c `bck_word` (stop=false).
 */
export const wordBackward =
  (bigword: boolean): Motion =>
  ({ lines, cursor }) => {
    const pos = { row: cursor.row, col: cursor.col };
    const klassOf = (r: number, c: number): CharClass =>
      classAt(lines[r] ?? "", c, bigword);

    if (!stepBack(lines, pos)) return cursor;

    while (klassOf(pos.row, pos.col) === "blank") {
      if (pos.col === 0 && lines[pos.row]!.length === 0) break;
      if (!stepBack(lines, pos)) return { row: pos.row, col: pos.col };
    }

    // `skip_chars(cls(), BACKWARD)` then `inc_cursor` — land on the first
    // char of the run. Hitting SOF mid-run leaves the cursor on char 0.
    const cclass = klassOf(pos.row, pos.col);
    if (cclass !== "blank") {
      while (klassOf(pos.row, pos.col) === cclass) {
        if (!stepBack(lines, pos)) return { row: pos.row, col: pos.col };
      }
      stepForward(lines, pos);
    }
    return { row: pos.row, col: pos.col };
  };

export const wordBackwardSmall = wordBackward(false);
export const wordBackwardBig = wordBackward(true);

/**
 * `e` / `E` — forward to the end of the word/WORD.
 * Cite: neovim textobject.c `end_word` (stop=false, empty=false).
 */
export const wordEnd =
  (bigword: boolean): Motion =>
  ({ lines, cursor }) => {
    const pos = { row: cursor.row, col: cursor.col };
    const klassOf = (r: number, c: number): CharClass =>
      classAt(lines[r] ?? "", c, bigword);

    const sclass = klassOf(pos.row, pos.col);
    if (!stepForward(lines, pos)) return cursor;

    if (klassOf(pos.row, pos.col) === sclass && sclass !== "blank") {
      // Mid-word: skip to one past the end of this class, then back up.
      while (klassOf(pos.row, pos.col) === sclass) {
        if (!stepForward(lines, pos)) return { row: pos.row, col: pos.col };
      }
      stepBack(lines, pos);
    } else {
      // Already at a word end (or on blank): skip to the end of the next run.
      while (klassOf(pos.row, pos.col) === "blank") {
        if (!stepForward(lines, pos)) return { row: pos.row, col: pos.col };
      }
      const cclass = klassOf(pos.row, pos.col);
      while (klassOf(pos.row, pos.col) === cclass) {
        if (!stepForward(lines, pos)) return { row: pos.row, col: pos.col };
      }
      stepBack(lines, pos);
    }
    return { row: pos.row, col: pos.col };
  };

export const wordEndSmall = wordEnd(false);
export const wordEndBig = wordEnd(true);

/**
 * `ge` / `gE` — back to the end of the previous word/WORD.
 * Cite: neovim textobject.c `bckend_word`.
 */
export const wordEndBack =
  (bigword: boolean): Motion =>
  ({ lines, cursor }) => {
    const pos = { row: cursor.row, col: cursor.col };
    const klassOf = (r: number, c: number): CharClass =>
      classAt(lines[r] ?? "", c, bigword);

    const sclass = klassOf(pos.row, pos.col);
    if (!stepBack(lines, pos)) return cursor;

    // Leave the starting word/WORD when we began on a non-blank class.
    if (sclass !== "blank") {
      while (klassOf(pos.row, pos.col) === sclass) {
        if (!stepBack(lines, pos)) return { row: pos.row, col: pos.col };
      }
    }
    // Skip blanks to land on the end of the previous word.
    while (klassOf(pos.row, pos.col) === "blank") {
      if (pos.col === 0 && lines[pos.row]!.length === 0) break;
      if (!stepBack(lines, pos)) return { row: pos.row, col: pos.col };
    }
    return { row: pos.row, col: pos.col };
  };

export const wordEndBackSmall = wordEndBack(false);
export const wordEndBackBig = wordEndBack(true);

/** `|` — go to count-th column (1-based; bare `|` → column 1). */
export const gotoColumn: Motion = ({ lines, cursor, count }) => {
  const line = lines[cursor.row]!;
  const col = Math.max(0, Math.min(line.length, Math.max(1, count) - 1));
  return { row: cursor.row, col };
};

/**
 * `N%` — line at N percent of the file (nvim `nv_percent` with count).
 * Round up so `100%` is the last line. Lands on first non-blank.
 */
export const percentOfFile: Motion = ({ lines, count }) => {
  const n = Math.max(1, Math.min(100, count));
  const row = Math.min(
    lines.length - 1,
    Math.max(0, Math.floor((lines.length * n + 99) / 100) - 1),
  );
  const line = lines[row]!;
  let col = 0;
  while (col < line.length && isBlank(line[col]!)) col += 1;
  return { row, col };
};

const pairOf = (ch: string): Option.Option<string> =>
  Match.value(ch).pipe(
    Match.when("(", () => Option.some(")")),
    Match.when(")", () => Option.some("(")),
    Match.when("[", () => Option.some("]")),
    Match.when("]", () => Option.some("[")),
    Match.when("{", () => Option.some("}")),
    Match.when("}", () => Option.some("{")),
    Match.when("<", () => Option.some(">")),
    Match.when(">", () => Option.some("<")),
    Match.orElse(() => Option.none()),
  );

const OPEN_SET = new Set(["(", "[", "{", "<"]);

/** Bare `%` — jump to matching bracket; scan forward on the line if not on one. */
export const matchParen: Motion = ({ lines, cursor }) => {
  let row = cursor.row;
  let col = cursor.col;
  const line0 = lines[row]!;
  const startCol = Option.match(pairOf(line0[col] ?? ""), {
    onSome: () => Option.some(col),
    onNone: () => {
      for (let c = col; c < line0.length; c++) {
        if (Option.isSome(pairOf(line0[c]!))) return Option.some(c);
      }
      return Option.none();
    },
  });
  return Option.match(startCol, {
    onNone: () => cursor,
    onSome: (foundCol) => {
      col = foundCol;
      const start = lines[row]![col]!;
      return Option.match(pairOf(start), {
        onNone: () => cursor,
        onSome: (match) => {
          const forward = OPEN_SET.has(start);
          let depth = 0;
          if (forward) {
            for (let r = row; r < lines.length; r++) {
              const line = lines[r]!;
              const from = r === row ? col : 0;
              for (let c = from; c < line.length; c++) {
                const ch = line[c]!;
                if (ch === start) depth += 1;
                else if (ch === match) {
                  depth -= 1;
                  if (depth === 0) return { row: r, col: c };
                }
              }
            }
          } else {
            for (let r = row; r >= 0; r--) {
              const line = lines[r]!;
              const from = r === row ? col : line.length - 1;
              for (let c = from; c >= 0; c--) {
                const ch = line[c]!;
                if (ch === start) depth += 1;
                else if (ch === match) {
                  depth -= 1;
                  if (depth === 0) return { row: r, col: c };
                }
              }
            }
          }
          return cursor;
        },
      });
    },
  });
};

export const firstNonBlank: Motion = ({ lines, cursor }) => {
  const line = lines[cursor.row]!;
  let col = 0;
  while (col < line.length && isBlank(line[col] ?? "")) col += 1;
  return { row: cursor.row, col };
};

/**
 * `$` — last character of the line (not past it). Empty → col 0.
 * Cite: neovim `nv_dollar` + `coladvance(MAXCOL)` with `one_more == 0`.
 */
export const lineEnd: Motion = ({ lines, cursor }) => {
  const line = lines[cursor.row]!;
  return { row: cursor.row, col: line.length === 0 ? 0 : line.length - 1 };
};

export const firstColumn: Motion = ({ cursor }) => ({ row: cursor.row, col: 0 });

/**
 * Preferred-column ceiling meaning "stay on EOL" across `j`/`k`.
 * Cite: neovim `MAXCOL` / `w_curswant` after `$`.
 */
export const MAXCOL = 0x7fffffff;

/**
 * Land on `curswant` within a line. `MAXCOL` sticks to the last character
 * (neovim `coladvance` MAXCOL branch in normal mode); a finite want clamps
 * the same way. Empty lines stay at col 0.
 */
export const colAdvance = (line: string, curswant: number): number => {
  if (line.length === 0) return 0;
  if (curswant >= MAXCOL) return line.length - 1;
  return Math.min(curswant, line.length - 1);
};

/** Motions that must not refresh `curswant` from the landed column. */
export const CURSWANT_PRESERVE = new Set(["j", "k", "ctrl-d", "ctrl-u"]);

/**
 * Next preferred-column state after a named motion.
 * Cite: neovim `update_curswant` / `nv_dollar` / vertical motions.
 */
export type CurswantUpdate = {
  readonly curswant: number;
  readonly setCurswant: boolean;
};

export const nextCurswant = (
  prev: number,
  setCurswant: boolean,
  motionName: string | undefined,
  cursorCol: number,
  landedCol: number,
): CurswantUpdate => {
  // Vertical: optionally sync from the cursor first (deferred update), then keep.
  if (motionName !== undefined && CURSWANT_PRESERVE.has(motionName)) {
    const synced = setCurswant ? cursorCol : prev;
    return { curswant: synced, setCurswant: false };
  }
  if (motionName === "$") return { curswant: MAXCOL, setCurswant: false };
  return { curswant: landedCol, setCurswant: true };
};

/** Curswant to feed a vertical motion right now. */
export const curswantForMotion = (
  curswant: number,
  setCurswant: boolean,
  cursorCol: number,
  motionName: string | undefined,
): number => {
  if (motionName !== undefined && CURSWANT_PRESERVE.has(motionName) && setCurswant) {
    return cursorCol;
  }
  return curswant;
};

/** `j` — down one line, keeping preferred column. Cite: neovim `cursor_down`. */
export const lineDown: Motion = ({ lines, cursor, curswant }) => {
  if (cursor.row >= lines.length - 1) return cursor;
  const row = cursor.row + 1;
  return { row, col: colAdvance(lines[row]!, curswant) };
};

/** `k` — up one line, keeping preferred column. Cite: neovim `cursor_up`. */
export const lineUp: Motion = ({ lines, cursor, curswant }) => {
  if (cursor.row === 0) return cursor;
  const row = cursor.row - 1;
  return { row, col: colAdvance(lines[row]!, curswant) };
};

/**
 * `+` / `<CR>` — down `count` lines, then first non-blank.
 * Cite: neovim `nv_down` with `cap->arg` → `beginline(BL_WHITE|BL_FIX)`.
 */
export const lineDownNonBlank: Motion = ({ lines, cursor, count }) => {
  const row = clampRow(cursor.row + Math.max(1, count), lines);
  return firstNonBlankOn(lines, row);
};

/**
 * `-` — up `count` lines, then first non-blank.
 * Cite: neovim `nv_up` with `cap->arg` → `beginline(BL_WHITE|BL_FIX)`.
 */
export const lineUpNonBlank: Motion = ({ lines, cursor, count }) => {
  const row = clampRow(cursor.row - Math.max(1, count), lines);
  return firstNonBlankOn(lines, row);
};

/**
 * `_` — first non-blank of the count'th line (count 1 = current).
 * Linewise under operators (`d3_` deletes 3 lines). Cite: neovim `nv_lineop`.
 */
export const lineUnderscore: Motion = ({ lines, cursor, count }) => {
  const row = clampRow(cursor.row + Math.max(1, count) - 1, lines);
  return firstNonBlankOn(lines, row);
};

/**
 * True when the cursor sits on the last character of its word/WORD (or on
 * a blank/EOL). Used for the `cw`-at-word-end one-char quirk.
 * Cite: neovim `nv_wordcmd` `flag` + `end_word(..., stop=true)`.
 */
export const atEndOfWord = (
  lines: readonly string[],
  cursor: Cursor,
  bigword: boolean,
): boolean => {
  const line = lines[cursor.row] ?? "";
  if (cursor.col < 0 || cursor.col >= line.length) return true;
  const klass = classAt(line, cursor.col, bigword);
  if (klass === "blank") return true;
  if (cursor.col + 1 >= line.length) return true;
  return classAt(line, cursor.col + 1, bigword) !== klass;
};

export const isBlankChar = isBlank;

/**
 * `gg` — first line, first non-blank (default `startofline`).
 * Cite: neovim `nv_goto` → `beginline(BL_SOL | BL_FIX)`.
 */
export const firstLine: Motion = ({ lines }) => firstNonBlankOn(lines, 0);

/**
 * `G` / `nG` — last line or line n, first non-blank.
 * Bare `G` and the operator arm's count of 1 both mean "last line".
 * Cite: neovim `nv_goto` → `beginline(BL_SOL | BL_FIX)`.
 */
export const lastLine: Motion = ({ lines, count }) => {
  const row =
    count <= 1 ? lines.length - 1 : Math.min(count - 1, lines.length - 1);
  return firstNonBlankOn(lines, row);
};

/**
 * `h` — left one character; wraps to the previous line's last char.
 * Cite: neovim `nv_left` with `whichwrap` containing `h` (hardcoded on).
 */
export const leftChar: Motion = ({ lines, cursor }) => {
  if (cursor.col > 0) return { row: cursor.row, col: cursor.col - 1 };
  if (cursor.row === 0) return cursor;
  const prev = lines[cursor.row - 1]!;
  return { row: cursor.row - 1, col: prev.length === 0 ? 0 : prev.length - 1 };
};

/**
 * `l` — right one character; stops on the last char, then wraps to the
 * next line. Cite: neovim `nv_right` / `oneright` with `whichwrap` `l`.
 */
export const rightChar: Motion = ({ lines, cursor }) => {
  const line = lines[cursor.row]!;
  if (line.length === 0) {
    if (cursor.row >= lines.length - 1) return cursor;
    return { row: cursor.row + 1, col: 0 };
  }
  if (cursor.col < line.length - 1) {
    return { row: cursor.row, col: cursor.col + 1 };
  }
  if (cursor.row >= lines.length - 1) {
    return { row: cursor.row, col: line.length - 1 };
  }
  return { row: cursor.row + 1, col: 0 };
};

/** `}` — next paragraph boundary (blank line after this block, or EOF). */
export const paragraphForward: Motion = ({ lines, cursor }) => {
  let row = cursor.row;
  if (row >= lines.length - 1) return { row, col: 0 };
  // Skip the current paragraph's non-blank lines.
  if (lines[row]!.length > 0) {
    while (row < lines.length - 1 && lines[row]!.length > 0) row += 1;
    return { row, col: 0 };
  }
  // On a blank: skip blanks, then skip the following paragraph, land on the
  // blank that ends it (or EOF).
  while (row < lines.length - 1 && lines[row]!.length === 0) row += 1;
  while (row < lines.length - 1 && lines[row]!.length > 0) row += 1;
  return { row, col: 0 };
};

/** `{` — previous paragraph boundary. */
export const paragraphBackward: Motion = ({ lines, cursor }) => {
  let row = cursor.row;
  if (row === 0) return { row: 0, col: 0 };
  // Step off the current line first so a second `{` keeps moving.
  row -= 1;
  // If we landed in a paragraph, walk to its start; then skip the blank
  // above and walk to the previous paragraph's start.
  if (lines[row]!.length > 0) {
    while (row > 0 && lines[row - 1]!.length > 0) row -= 1;
    return { row, col: 0 };
  }
  while (row > 0 && lines[row]!.length === 0) row -= 1;
  while (row > 0 && lines[row - 1]!.length > 0) row -= 1;
  return { row, col: 0 };
};

/**
 * `f` / `t` — find or till `char` forward across the whole buffer.
 *
 * Departure from vim (line-local): each press of `;` continues past newlines,
 * so `f{;;;;;;` walks every `{` in the file.
 */
export const findCharForward =
  (char: string, till: boolean): Motion =>
  ({ lines, cursor }) => {
    let row = cursor.row;
    let col = cursor.col + 1;
    while (row < lines.length) {
      const line = lines[row]!;
      while (col < line.length) {
        if (line[col] === char) {
          if (!till) return { row, col };
          // Land just before the match; before col 0 is the end of the prior line.
          if (col > 0) return { row, col: col - 1 };
          if (row === 0) return cursor;
          return { row: row - 1, col: lines[row - 1]!.length };
        }
        col += 1;
      }
      row += 1;
      col = 0;
    }
    return cursor;
  };

/**
 * `F` / `T` — find or till `char` backward across the whole buffer.
 * Same multiline departure from vim as `findCharForward`.
 */
export const findCharBackward =
  (char: string, till: boolean): Motion =>
  ({ lines, cursor }) => {
    let row = cursor.row;
    let col = cursor.col - 1;
    while (row >= 0) {
      const line = lines[row]!;
      if (col >= line.length) col = line.length - 1;
      while (col >= 0) {
        if (line[col] === char) {
          if (!till) return { row, col };
          // Land just after the match (toward the original cursor).
          return { row, col: col + 1 };
        }
        col -= 1;
      }
      row -= 1;
      if (row >= 0) col = lines[row]!.length - 1;
    }
    return cursor;
  };

const clampRow = (row: number, lines: readonly string[]) =>
  Math.max(0, Math.min(row, lines.length - 1));

const firstNonBlankOn = (lines: readonly string[], row: number): Cursor =>
  firstNonBlank({
    lines,
    cursor: { row, col: 0 },
    count: 1,
    curswant: 0,
    viewport: { top: 0, height: 1 },
  });

/** `H` — first non-blank of the top screen line. */
export const screenHigh: Motion = ({ lines, viewport }) =>
  firstNonBlankOn(lines, clampRow(viewport.top, lines));

/** `M` — first non-blank of the middle screen line. */
export const screenMiddle: Motion = ({ lines, viewport }) => {
  const mid = viewport.top + Math.floor(Math.max(viewport.height - 1, 0) / 2);
  return firstNonBlankOn(lines, clampRow(mid, lines));
};

/** `L` — first non-blank of the bottom screen line. */
export const screenLow: Motion = ({ lines, viewport }) => {
  const bottom = viewport.top + Math.max(viewport.height, 1) - 1;
  return firstNonBlankOn(lines, clampRow(bottom, lines));
};

/** `Ctrl-D` — half a viewport down. */
export const halfPageDown: Motion = ({ lines, cursor, count, viewport, curswant }) => {
  const step = Math.max(1, Math.floor(viewport.height / 2));
  const row = clampRow(cursor.row + step * count, lines);
  return { row, col: colAdvance(lines[row]!, curswant) };
};

/** `Ctrl-U` — half a viewport up. */
export const halfPageUp: Motion = ({ lines, cursor, count, viewport, curswant }) => {
  const step = Math.max(1, Math.floor(viewport.height / 2));
  const row = clampRow(cursor.row - step * count, lines);
  return { row, col: colAdvance(lines[row]!, curswant) };
};

const SENTENCE_END = new Set([".", "!", "?"]);
const SENTENCE_CLOSE = new Set([")", "]", '"', "'"]);

export const charAtPos = (lines: readonly string[], pos: Cursor): string | null => {
  const line = lines[pos.row];
  if (line === undefined) return null;
  if (pos.col < 0 || pos.col >= line.length) return null;
  return line[pos.col]!;
};

export const stepPos = (lines: readonly string[], pos: Cursor, dir: 1 | -1): Cursor => {
  if (dir === 1) {
    const line = lines[pos.row]!;
    if (pos.col + 1 < line.length) return { row: pos.row, col: pos.col + 1 };
    if (pos.row + 1 < lines.length) return { row: pos.row + 1, col: 0 };
    return pos;
  }
  if (pos.col > 0) return { row: pos.row, col: pos.col - 1 };
  if (pos.row > 0) return { row: pos.row - 1, col: lines[pos.row - 1]!.length };
  return pos;
};

const samePos = (a: Cursor, b: Cursor): boolean => a.row === b.row && a.col === b.col;

/** Exclusive end past the sentence terminator (and closers). Cite: findsent. */
export function sentenceEndExclusive(lines: readonly string[], from: Cursor): Cursor {
  let pos = from;
  for (;;) {
    const ch = charAtPos(lines, pos);
    if (ch === null) {
      const line = lines[pos.row]!;
      if (pos.col >= line.length) return pos;
      const next = stepPos(lines, pos, 1);
      if (samePos(next, pos)) return { row: pos.row, col: line.length };
      pos = next;
      continue;
    }
    if (SENTENCE_END.has(ch)) {
      let end = stepPos(lines, pos, 1);
      while (true) {
        const c = charAtPos(lines, end);
        if (c !== null && SENTENCE_CLOSE.has(c)) {
          end = stepPos(lines, end, 1);
          continue;
        }
        break;
      }
      return end;
    }
    const next = stepPos(lines, pos, 1);
    if (samePos(next, pos)) return { row: pos.row, col: (lines[pos.row] ?? "").length };
    pos = next;
  }
}

/** Start of the sentence containing `cursor`. Cite: findsent BACKWARD subset. */
export function sentenceStart(lines: readonly string[], cursor: Cursor): Cursor {
  let pos = cursor;
  while (true) {
    const ch = charAtPos(lines, pos);
    if (ch === " " || ch === "\t") {
      const next = stepPos(lines, pos, 1);
      if (samePos(next, pos)) break;
      pos = next;
      continue;
    }
    break;
  }

  let scan = pos;
  for (;;) {
    const prev = stepPos(lines, scan, -1);
    if (samePos(prev, scan)) return { row: scan.row, col: 0 };
    const ch = charAtPos(lines, prev);
    if (ch === null) {
      if (prev.row < scan.row && (lines[prev.row] ?? "").length === 0) {
        return { row: scan.row, col: 0 };
      }
      scan = prev;
      continue;
    }
    if (SENTENCE_END.has(ch)) {
      let after = stepPos(lines, prev, 1);
      while (true) {
        const c = charAtPos(lines, after);
        if (c !== null && SENTENCE_CLOSE.has(c)) {
          after = stepPos(lines, after, 1);
          continue;
        }
        break;
      }
      while (true) {
        const c = charAtPos(lines, after);
        if (c === " " || c === "\t") {
          after = stepPos(lines, after, 1);
          continue;
        }
        break;
      }
      return after;
    }
    scan = prev;
  }
}

/**
 * `)` — start of the next sentence. Cite: neovim `nv_brace` / `findsent` FORWARD.
 * Count is applied by {@link applyMotion}.
 */
export const sentenceForward: Motion = ({ lines, cursor }) => {
  const end = sentenceEndExclusive(lines, cursor);
  let next = end;
  while (true) {
    const ch = charAtPos(lines, next);
    if (ch === " " || ch === "\t") {
      const stepped = stepPos(lines, next, 1);
      if (samePos(stepped, next)) break;
      next = stepped;
      continue;
    }
    break;
  }
  return next;
};

/**
 * `(` — start of the current/previous sentence. Cite: `findsent` BACKWARD.
 * Count is applied by {@link applyMotion}.
 */
export const sentenceBackward: Motion = ({ lines, cursor }) => {
  const start = sentenceStart(lines, cursor);
  if (start.row !== cursor.row || start.col !== cursor.col) return start;

  // Already at sentence start — retreat past whitespace/terminator into the
  // previous sentence, then snap to its start. sentenceStart alone would
  // skip blanks forward and land back here.
  let scan = stepPos(lines, cursor, -1);
  if (samePos(scan, cursor)) return cursor;
  while (true) {
    const ch = charAtPos(lines, scan);
    if (
      ch === " " ||
      ch === "\t" ||
      (ch !== null && (SENTENCE_CLOSE.has(ch) || SENTENCE_END.has(ch)))
    ) {
      const prev = stepPos(lines, scan, -1);
      if (samePos(prev, scan)) break;
      scan = prev;
      continue;
    }
    break;
  }
  return sentenceStart(lines, scan);
};

/** Keyword under cursor using `'iskeyword'` Latin1. For `*`/`#`/`g*`/`g#`. */
export function keywordAtCursor(
  lines: readonly string[],
  cursor: Cursor,
): Option.Option<{ readonly word: string; readonly start: Cursor; readonly end: Cursor }> {
  const line = lines[cursor.row] ?? "";
  if (line.length === 0) return Option.none();
  let col = Math.min(cursor.col, Math.max(0, line.length - 1));
  if (!isWord(line[col]!)) {
    if (col > 0 && isWord(line[col - 1]!)) col -= 1;
    else return Option.none();
  }
  let start = col;
  let end = col + 1;
  while (start > 0 && isWord(line[start - 1]!)) start -= 1;
  while (end < line.length && isWord(line[end]!)) end += 1;
  return Option.some({
    word: line.slice(start, end),
    start: { row: cursor.row, col: start },
    end: { row: cursor.row, col: end },
  });
}

/** True when `[col, col+len)` is a whole keyword on `line` (for `*`/`#`). */
export const isWholeKeyword = (line: string, col: number, len: number): boolean => {
  if (col > 0 && isWord(line[col - 1]!)) return false;
  if (col + len < line.length && isWord(line[col + len]!)) return false;
  return true;
};

export const allMotions = {
  h: leftChar,
  l: rightChar,
  j: lineDown,
  k: lineUp,
  "+": lineDownNonBlank,
  "-": lineUpNonBlank,
  _: lineUnderscore,
  CR: lineDownNonBlank,
  w: wordForwardSmall,
  W: wordForwardBig,
  b: wordBackwardSmall,
  B: wordBackwardBig,
  e: wordEndSmall,
  E: wordEndBig,
  ge: wordEndBackSmall,
  gE: wordEndBackBig,
  "|": gotoColumn,
  "%": matchParen,
  percentOfFile,
  "0": firstColumn,
  $: lineEnd,
  "^": firstNonBlank,
  G: lastLine,
  firstLine: firstLine,
  "{": paragraphBackward,
  "}": paragraphForward,
  "(": sentenceBackward,
  ")": sentenceForward,
  H: screenHigh,
  M: screenMiddle,
  L: screenLow,
} satisfies Record<string, Motion>;

export type FindKind = "f" | "F" | "t" | "T";

export const findMotion = (kind: FindKind, char: string): Motion => {
  switch (kind) {
    case "f":
      return findCharForward(char, false);
    case "t":
      return findCharForward(char, true);
    case "F":
      return findCharBackward(char, false);
    case "T":
      return findCharBackward(char, true);
  }
};

/** `;` keeps direction; `,` flips f↔F and t↔T. */
export const flipFind = (kind: FindKind): FindKind =>
  kind === "f" ? "F" : kind === "F" ? "f" : kind === "t" ? "T" : "t";

/** Character-find motions are inclusive for operators (`dfx` deletes the x). */
export const findIsInclusive = (kind: FindKind): boolean => kind === "f" || kind === "F";
