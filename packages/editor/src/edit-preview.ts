/**
 * WorkspaceEdit → unified-diff-ish text for the picker preview pane.
 * ASCII only; no third-party diff lib.
 *
 * Cite: lsp-bridge `editsByUri` + text-buffer `applyEdits` (same path as rename).
 */
import { Option, Result } from "effect";
import {
  applyEdits,
  fromLines,
  lineCount,
  sliceLines,
  type TextEdit,
} from "@danielfgray/amux-text-buffer";
import type { LspWorkspaceEdit } from "@danielfgray/amux-plugin-lsp";
import { editsByUri } from "./lsp-bridge.ts";

const LOOKAHEAD = 32;

/** Line-oriented unified diff between two full buffers. */
export const unifiedDiff = (
  before: readonly string[],
  after: readonly string[],
  pathLabel = "buffer",
): string => {
  if (before.length === after.length && before.every((line, i) => line === after[i])) {
    return `(no text change in ${pathLabel})`;
  }

  const out: string[] = [`--- a/${pathLabel}`, `+++ b/${pathLabel}`];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      i += 1;
      j += 1;
      continue;
    }

    const startI = i;
    const startJ = j;
    // Grow a change block until both sides resync (lookahead) or hit EOF.
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && before[i] === after[j]) {
        let sync = 0;
        while (
          sync < 2 &&
          i + sync < before.length &&
          j + sync < after.length &&
          before[i + sync] === after[j + sync]
        ) {
          sync += 1;
        }
        if (sync >= 2 || (i + 1 >= before.length && j + 1 >= after.length)) break;
      }
      const skipA = findResync(before, after, i, j, "a");
      const skipB = findResync(before, after, i, j, "b");
      if (skipA <= skipB && i < before.length) i += 1;
      else if (j < after.length) j += 1;
      else if (i < before.length) i += 1;
      else break;
    }

    const oldCount = i - startI;
    const newCount = j - startJ;
    out.push(`@@ -${startI + 1},${oldCount} +${startJ + 1},${newCount} @@`);
    for (let k = startI; k < i; k++) out.push(`-${before[k] ?? ""}`);
    for (let k = startJ; k < j; k++) out.push(`+${after[k] ?? ""}`);
  }
  return out.join("\n");
};

const findResync = (
  before: readonly string[],
  after: readonly string[],
  i: number,
  j: number,
  side: "a" | "b",
): number => {
  for (let n = 1; n <= LOOKAHEAD; n++) {
    if (side === "a") {
      if (i + n < before.length && j < after.length && before[i + n] === after[j]) return n;
    } else if (j + n < after.length && i < before.length && before[i] === after[j + n]) {
      return n;
    }
  }
  return LOOKAHEAD + 1;
};

/**
 * Preview a workspace edit against the current buffer URI.
 * Other URIs get a one-line note (DocumentService cross-file read is deferred).
 */
export const workspaceEditPreview = (
  currentUri: string,
  lines: readonly string[],
  edit: LspWorkspaceEdit,
  pathLabel = "buffer",
): string => {
  const byUri = editsByUri(edit);
  const mine = byUri.get(currentUri) ?? [];
  const others = [...byUri.keys()].filter((uri) => uri !== currentUri);
  const chunks: string[] = [];

  if (mine.length === 0) {
    chunks.push("(no edits for this buffer)");
  } else {
    const mapped: readonly TextEdit[] = mine.map((e) => ({
      range: e.range,
      newText: e.newText,
    }));
    const applied = Result.match(applyEdits(fromLines(lines), mapped), {
      onFailure: () => Option.none<readonly string[]>(),
      onSuccess: (buffer) => Option.some(sliceLines(buffer, 0, lineCount(buffer))),
    });
    Option.match(applied, {
      onNone: () => {
        chunks.push("(could not apply edits for preview)");
      },
      onSome: (after) => {
        chunks.push(unifiedDiff(lines, after, pathLabel));
      },
    });
  }

  if (others.length > 0) {
    chunks.push(
      `(${others.length} other file${others.length === 1 ? "" : "s"} not shown)`,
    );
  }
  return chunks.join("\n");
};
