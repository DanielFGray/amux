/**
 * tpope/vim-surround algebra: find a surrounding pair, wrap a range, or
 * replace/remove the delimiters. The key state machine lives in vim-core;
 * this module is pure buffer surgery.
 *
 * Pair aliases match vim-surround: `b`→`)`, `B`→`}`, `r`→`]`. Spaced wraps
 * use the open form (`(`, `{`, `[`); the close form omits spaces.
 */
import { Match, Option } from "effect";
import type { Cursor } from "./schema.ts";
import type { MotionRange } from "./motions.ts";
import type { StructureGrammar } from "./structure.ts";
import { findTagAt, tagDelimiters } from "./tags.ts";

export type SurroundDelimiters = {
  readonly open: string;
  readonly close: string;
};

export type SurroundMatch = {
  readonly openPos: Cursor;
  readonly closePos: Cursor;
  readonly open: string;
  readonly close: string;
};

type SurroundEdit = {
  readonly lines: string[];
  readonly cursor: Cursor;
};

const resolveAlias = (target: string): string =>
  Match.value(target).pipe(
    Match.when("b", () => ")"),
    Match.when("B", () => "}"),
    Match.when("r", () => "]"),
    Match.orElse(() => target),
  );

const closeForOpen = (open: string): Option.Option<string> =>
  Match.value(open).pipe(
    Match.when("(", () => Option.some(")")),
    Match.when("{", () => Option.some("}")),
    Match.when("[", () => Option.some("]")),
    Match.when("<", () => Option.some(">")),
    Match.when('"', () => Option.some('"')),
    Match.when("'", () => Option.some("'")),
    Match.when("`", () => Option.some("`")),
    Match.orElse(() => Option.none()),
  );

const openForClose = (close: string): Option.Option<string> =>
  Match.value(close).pipe(
    Match.when(")", () => Option.some("(")),
    Match.when("}", () => Option.some("{")),
    Match.when("]", () => Option.some("[")),
    Match.when(">", () => Option.some("<")),
    Match.orElse(() => Option.none()),
  );

/** Normalize a typed surround target to the open delimiter character. */
export function openOfTarget(target: string): Option.Option<string> {
  const char = resolveAlias(target);
  return Option.orElse(Option.as(closeForOpen(char), char), () => openForClose(char));
}

/** Whether deleting/changing with this target also strips padding spaces. */
export function stripsInnerSpaces(target: string): boolean {
  const char = resolveAlias(target);
  return char === "(" || char === "{" || char === "[";
}

/** Delimiters inserted by `ys` / `yss` for the typed character. */
export function delimitersFor(target: string): Option.Option<SurroundDelimiters> {
  const char = resolveAlias(target);
  if (char === "(") return Option.some({ open: "( ", close: " )" });
  if (char === "{") return Option.some({ open: "{ ", close: " }" });
  if (char === "[") return Option.some({ open: "[ ", close: " ]" });
  if (char === ")" || char === "b") return Option.some({ open: "(", close: ")" });
  if (char === "}" || char === "B") return Option.some({ open: "{", close: "}" });
  if (char === "]" || char === "r") return Option.some({ open: "[", close: "]" });
  if (char === "<") return Option.some({ open: "< ", close: " >" });
  if (char === ">") return Option.some({ open: "<", close: ">" });
  if (char === '"' || char === "'" || char === "`") return Option.some({ open: char, close: char });
  // Any other single character surrounds with itself on both sides.
  if ([...char].length === 1) return Option.some({ open: char, close: char });
  return Option.none();
}

/**
 * Find the open/close pair around the cursor — no surround space-strip.
 * Accepts open or close forms (`i)` / `a]`). Cite: textobject `current_block`.
 */
export function findPairAround(
  lines: readonly string[],
  cursor: Cursor,
  target: string,
): Option.Option<SurroundMatch> {
  return Option.flatMap(openOfTarget(target), (openChar) =>
    Option.flatMap(closeForOpen(openChar), (closeChar) =>
      openChar === closeChar
        ? findQuotePair(lines, cursor, openChar)
        : findBracketPair(lines, cursor, openChar, closeChar),
    ),
  );
}

/**
 * Find the pair surrounding the cursor for `ds` / `cs`.
 * Quotes stay line-local (matching `di"`); brackets may nest across lines.
 */
export function findSurrounding(
  lines: readonly string[],
  cursor: Cursor,
  target: string,
): Option.Option<SurroundMatch> {
  return Option.flatMap(findPairAround(lines, cursor, target), (match) => {
    if (!stripsInnerSpaces(target)) return Option.some(match);

    return Option.map(openOfTarget(target), (openChar) =>
      Option.match(closeForOpen(openChar), {
        onNone: () => match,
        onSome: (closeChar) => {
          let open = match.open;
          let close = match.close;
          let closePos = match.closePos;
          const openLine = lines[match.openPos.row]!;
          const afterOpen = match.openPos.col + 1;
          if (openLine[afterOpen] === " ") open = openChar + " ";
          if (closePos.col > 0 && lines[closePos.row]![closePos.col - 1] === " ") {
            close = " " + closeChar;
            closePos = { row: closePos.row, col: closePos.col - 1 };
          }
          return { openPos: match.openPos, closePos, open, close };
        },
      }),
    );
  });
}

function findQuotePair(
  lines: readonly string[],
  cursor: Cursor,
  quote: string,
): Option.Option<SurroundMatch> {
  const line = lines[cursor.row]!;
  const from = line.lastIndexOf(quote, cursor.col);
  if (from === -1) return Option.none();
  const to = line.indexOf(quote, from + 1);
  if (to === -1 || to <= from) return Option.none();
  return Option.some({
    openPos: { row: cursor.row, col: from },
    closePos: { row: cursor.row, col: to },
    open: quote,
    close: quote,
  });
}

function findBracketPair(
  lines: readonly string[],
  cursor: Cursor,
  openChar: string,
  closeChar: string,
): Option.Option<SurroundMatch> {
  let depth = 0;
  let openPos = Option.none<Cursor>();
  for (let row = cursor.row; row >= 0; row--) {
    const line = lines[row]!;
    const startCol = row === cursor.row ? cursor.col : line.length - 1;
    for (let col = startCol; col >= 0; col--) {
      const ch = line[col]!;
      if (ch === closeChar) depth += 1;
      else if (ch === openChar) {
        if (depth === 0) {
          openPos = Option.some({ row, col });
          break;
        }
        depth -= 1;
      }
    }
    if (Option.isSome(openPos)) break;
  }

  return Option.flatMap(openPos, (open) => {
    depth = 0;
    let closePos = Option.none<Cursor>();
    for (let row = open.row; row < lines.length; row++) {
      const line = lines[row]!;
      const startCol = row === open.row ? open.col + 1 : 0;
      for (let col = startCol; col < line.length; col++) {
        const ch = line[col]!;
        if (ch === openChar) depth += 1;
        else if (ch === closeChar) {
          if (depth === 0) {
            closePos = Option.some({ row, col });
            break;
          }
          depth -= 1;
        }
      }
      if (Option.isSome(closePos)) break;
    }
    return Option.map(closePos, (close) => ({
      openPos: open,
      closePos: close,
      open: openChar,
      close: closeChar,
    }));
  });
}

/** Wrap `[from, to)` (or a linewise row span) with the delimiters for `target`. */
export function addSurround(
  lines: readonly string[],
  range: MotionRange,
  target: string,
): Option.Option<SurroundEdit> {
  return Option.map(delimitersFor(target), (delim) =>
    wrapWith(lines, range, delim.open, delim.close),
  );
}

function wrapWith(
  lines: readonly string[],
  range: MotionRange,
  open: string,
  close: string,
): SurroundEdit {
  if (range.linewise) {
    const row = range.from.row;
    const line = lines[row]!;
    let start = 0;
    while (start < line.length && (line[start] === " " || line[start] === "\t")) start += 1;
    const next = [...lines];
    next[row] = line.slice(0, start) + open + line.slice(start) + close;
    return { lines: next, cursor: { row, col: start } };
  }

  const next = [...lines];
  if (range.from.row === range.to.row) {
    const line = next[range.from.row]!;
    next[range.from.row] =
      line.slice(0, range.from.col) +
      open +
      line.slice(range.from.col, range.to.col) +
      close +
      line.slice(range.to.col);
    return { lines: next, cursor: { row: range.from.row, col: range.from.col } };
  }

  const startLine = next[range.from.row]!;
  const endLine = next[range.to.row]!;
  next[range.from.row] =
    startLine.slice(0, range.from.col) + open + startLine.slice(range.from.col);
  next[range.to.row] = endLine.slice(0, range.to.col) + close + endLine.slice(range.to.col);
  return { lines: next, cursor: { row: range.from.row, col: range.from.col } };
}

/** Wrap a range in a tag from the typed prompt (`ysiwtdiv>`). */
export function addTagSurround(
  lines: readonly string[],
  range: MotionRange,
  name: string,
): Option.Option<SurroundEdit> {
  return Option.map(tagDelimiters(name), (delim) =>
    wrapWith(lines, range, delim.open, delim.close),
  );
}

/** Remove the surrounding pair for `target`. `t` uses tree-sitter when a grammar is loaded. */
export function deleteSurround(
  lines: readonly string[],
  cursor: Cursor,
  target: string,
  grammar: Option.Option<StructureGrammar> = Option.none(),
): Option.Option<SurroundEdit> {
  if (target === "t") {
    return Option.flatMap(findTagAt(lines, cursor, grammar), (tag) =>
      tag.selfClosing
        ? Option.none()
        : Option.some(
            removeDelimiters(lines, {
              openPos: tag.openPos,
              closePos: tag.closePos,
              open: tag.open,
              close: tag.close,
            }),
          ),
    );
  }
  return Option.map(findSurrounding(lines, cursor, target), (match) =>
    removeDelimiters(lines, match),
  );
}

/** Replace the surrounding pair for `oldTarget` with delimiters for `newTarget`. */
export function changeSurround(
  lines: readonly string[],
  cursor: Cursor,
  oldTarget: string,
  newTarget: string,
  grammar: Option.Option<StructureGrammar> = Option.none(),
): Option.Option<SurroundEdit> {
  if (oldTarget === "t") {
    return Option.flatMap(findTagAt(lines, cursor, grammar), (tag) => {
      if (tag.selfClosing) return Option.none();
      const fromTag =
        newTarget.length > 1 || newTarget === "t" ? tagDelimiters(newTarget) : Option.none();
      const fromPair =
        newTarget === "t" ? Option.none<SurroundDelimiters>() : delimitersFor(newTarget);
      const delim = Option.orElse(fromTag, () => fromPair);
      return Option.map(delim, ({ open, close }) => {
        const removed = removeDelimiters(lines, {
          openPos: tag.openPos,
          closePos: tag.closePos,
          open: tag.open,
          close: tag.close,
        });
        const openLen = tag.open.length;
        const closeShift =
          tag.openPos.row === tag.closePos.row ? tag.closePos.col - openLen : tag.closePos.col;
        return wrapWith(
          removed.lines,
          {
            from: tag.openPos,
            to: { row: tag.closePos.row, col: closeShift },
            linewise: false,
            inclusive: false,
          },
          open,
          close,
        );
      });
    });
  }
  return Option.flatMap(findSurrounding(lines, cursor, oldTarget), (match) => {
    const removed = removeDelimiters(lines, match);
    const openLen = match.open.length;
    const closeShift =
      match.openPos.row === match.closePos.row ? match.closePos.col - openLen : match.closePos.col;
    const range: MotionRange = {
      from: match.openPos,
      to: { row: match.closePos.row, col: closeShift },
      linewise: false,
      inclusive: false,
    };
    return addSurround(removed.lines, range, newTarget);
  });
}

function removeDelimiters(lines: readonly string[], match: SurroundMatch): SurroundEdit {
  const next = [...lines];
  const openLen = match.open.length;
  const closeLen = match.close.length;
  if (match.openPos.row === match.closePos.row) {
    const line = next[match.openPos.row]!;
    next[match.openPos.row] =
      line.slice(0, match.openPos.col) +
      line.slice(match.openPos.col + openLen, match.closePos.col) +
      line.slice(match.closePos.col + closeLen);
  } else {
    const start = next[match.openPos.row]!;
    const end = next[match.closePos.row]!;
    next[match.openPos.row] =
      start.slice(0, match.openPos.col) + start.slice(match.openPos.col + openLen);
    next[match.closePos.row] =
      end.slice(0, match.closePos.col) + end.slice(match.closePos.col + closeLen);
  }
  return { lines: next, cursor: match.openPos };
}
