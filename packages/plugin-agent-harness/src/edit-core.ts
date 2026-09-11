/**
 * Exact text edits for the harness — borrowed from Pi's edit semantics
 * (unique match, no overlap, BOM/newline preserved) without fuzzy matching.
 * Cite: ../pi/packages/coding-agent/src/core/tools/edit-diff.ts
 */
import { Result, Schema as S } from "effect";

export class EditError extends S.TaggedError<EditError>()("EditError", {
  message: S.String,
}) {}

export interface TextReplace {
  readonly oldText: string;
  readonly newText: string;
}

export interface AppliedEdits {
  readonly text: string;
  readonly diff: string;
}

const UTF8_BOM = "\uFEFF";

export const splitBom = (raw: string): { readonly bom: string; readonly text: string } =>
  raw.startsWith(UTF8_BOM)
    ? { bom: UTF8_BOM, text: raw.slice(UTF8_BOM.length) }
    : { bom: "", text: raw };

export const detectLineEnding = (content: string): "\r\n" | "\n" => {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  if (lf === -1) return "\n";
  if (crlf === -1) return "\n";
  return crlf < lf ? "\r\n" : "\n";
};

export const normalizeToLF = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

export const restoreLineEndings = (text: string, ending: "\r\n" | "\n"): string =>
  ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;

const countOccurrences = (content: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const at = content.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
};

/** 1-based line numbers of each exact occurrence of `needle` in `content`. */
export const occurrenceLineNumbers = (content: string, needle: string): readonly number[] => {
  if (needle.length === 0) return [];
  const lines: number[] = [];
  let from = 0;
  while (true) {
    const at = content.indexOf(needle, from);
    if (at === -1) return lines;
    lines.push(content.slice(0, at).split("\n").length);
    from = at + needle.length;
  }
};

const previewSnippet = (text: string, max = 48): string => {
  const oneLine = text.replace(/\n/g, "\\n");
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
};

/** Nearby numbered lines when an exact match misses — first-line anchor or file head. */
export const nearbyContext = (content: string, needle: string, radius = 2): string => {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const firstLine = needle.split("\n")[0] ?? "";
  let anchor = firstLine.length > 0 ? lines.findIndex((line) => line.includes(firstLine)) : -1;
  if (anchor === -1) {
    const shown = lines.slice(0, Math.min(5, lines.length));
    return `Nearby context (file head):\n${shown.map((line, i) => `${i + 1}: ${line}`).join("\n")}`;
  }
  const from = Math.max(0, anchor - radius);
  const to = Math.min(lines.length, anchor + radius + 1);
  return `Nearby context:\n${lines
    .slice(from, to)
    .map((line, i) => `${from + i + 1}: ${line}`)
    .join("\n")}`;
};

const rangesOverlap = (aStart: number, aLen: number, bStart: number, bLen: number): boolean => {
  const aEnd = aStart + aLen;
  const bEnd = bStart + bLen;
  return aStart < bEnd && bStart < aEnd;
};

/** Concise unified-style diff for tool output (no external `diff` package). */
export const conciseDiff = (path: string, before: string, after: string): string => {
  const a = normalizeToLF(before).split("\n");
  const b = normalizeToLF(after).split("\n");
  if (a.at(-1) === "") a.pop();
  if (b.at(-1) === "") b.pop();
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  if (removed.length === 0 && added.length === 0) return `(no textual diff for ${path})`;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
};

/**
 * Apply exact replacements against one original buffer. Stale/ambiguous/overlapping
 * edits fail without mutating.
 */
export const applyExactEdits = (
  raw: string,
  path: string,
  edits: readonly TextReplace[],
): Result.Result<AppliedEdits, EditError> => {
  if (edits.length === 0) {
    return Result.fail(new EditError({ message: `edit ${path}: edits must not be empty` }));
  }
  const { bom, text } = splitBom(raw);
  const ending = detectLineEnding(text);
  const base = normalizeToLF(text);
  const normalized = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  const matches: {
    index: number;
    length: number;
    newText: string;
    editIndex: number;
    snippet: string;
  }[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const edit = normalized[i]!;
    if (edit.oldText.length === 0) {
      return Result.fail(
        new EditError({ message: `edit ${path}: edits[${i}].oldText must not be empty` }),
      );
    }
    if (edit.oldText === edit.newText) {
      return Result.fail(
        new EditError({ message: `edit ${path}: edits[${i}] oldText and newText are identical` }),
      );
    }
    const occurrences = countOccurrences(base, edit.oldText);
    if (occurrences === 0) {
      return Result.fail(
        new EditError({
          message: [
            `edit ${path}: could not find edits[${i}] (${JSON.stringify(previewSnippet(edit.oldText))}). Exact match required.`,
            nearbyContext(base, edit.oldText),
            "Re-read the span (read with offset/limit) and retry with exact text.",
          ].join("\n"),
        }),
      );
    }
    if (occurrences > 1) {
      const at = occurrenceLineNumbers(base, edit.oldText);
      return Result.fail(
        new EditError({
          message: `edit ${path}: edits[${i}] matched ${occurrences} times at lines ${at.join(", ")} (must be unique). Widen oldText with surrounding context.`,
        }),
      );
    }
    const index = base.indexOf(edit.oldText);
    matches.push({
      index,
      length: edit.oldText.length,
      newText: edit.newText,
      editIndex: i,
      snippet: previewSnippet(edit.oldText),
    });
  }

  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      const a = matches[i]!;
      const b = matches[j]!;
      if (rangesOverlap(a.index, a.length, b.index, b.length)) {
        return Result.fail(
          new EditError({
            message: `edit ${path}: edits[${a.editIndex}] (${JSON.stringify(a.snippet)}) and edits[${b.editIndex}] (${JSON.stringify(b.snippet)}) overlap. Merge them or target disjoint regions.`,
          }),
        );
      }
    }
  }

  const ordered = [...matches].sort((a, b) => b.index - a.index);
  let next = base;
  for (const match of ordered) {
    next = next.slice(0, match.index) + match.newText + next.slice(match.index + match.length);
  }
  if (next === base) {
    return Result.fail(new EditError({ message: `edit ${path}: no changes produced` }));
  }
  const finalText = bom + restoreLineEndings(next, ending);
  return Result.succeed({
    text: finalText,
    diff: conciseDiff(path, base, next),
  });
};
