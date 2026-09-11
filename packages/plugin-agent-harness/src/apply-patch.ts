/**
 * Codex-style apply_patch parser + validate-then-apply.
 * Format cite: ../opencode/packages/opencode/src/patch/index.ts (Begin/End Patch).
 * Content is supplied by the caller so the daemon OpenDocumentStore can be authority.
 */
import { Result, Schema as S } from "effect";
import { conciseDiff } from "./edit-core.ts";

const patchNearby = (lines: readonly string[], fromLine: number, radius = 3): string => {
  const start = Math.max(0, fromLine - radius);
  const end = Math.min(lines.length, fromLine + radius + 1);
  if (lines.length === 0) return "(empty file)";
  return lines
    .slice(start, end)
    .map((line, i) => `${start + i + 1}: ${line}`)
    .join("\n");
};

export class PatchError extends S.TaggedError<PatchError>()("PatchError", {
  message: S.String,
}) {}

export type PatchHunk =
  | { readonly type: "add"; readonly path: string; readonly contents: string }
  | { readonly type: "delete"; readonly path: string }
  | {
      readonly type: "update";
      readonly path: string;
      readonly movePath?: string;
      readonly chunks: readonly UpdateChunk[];
    };

export interface UpdateChunk {
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly changeContext?: string;
  readonly isEndOfFile?: boolean;
}

export type PlannedChange =
  | { readonly type: "add"; readonly path: string; readonly content: string; readonly diff: string }
  | { readonly type: "delete"; readonly path: string; readonly diff: string }
  | {
      readonly type: "update";
      readonly path: string;
      readonly movePath?: string;
      readonly content: string;
      readonly diff: string;
    };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

type ParseCursor = { readonly lines: readonly string[]; readonly endIdx: number; i: number };

const readAddContents = (cursor: ParseCursor): string => {
  const contentLines: string[] = [];
  while (cursor.i < cursor.endIdx && !cursor.lines[cursor.i]!.startsWith("***")) {
    const raw = cursor.lines[cursor.i]!;
    contentLines.push(raw.startsWith("+") ? raw.slice(1) : raw);
    cursor.i += 1;
  }
  let contents = contentLines.join("\n");
  if (contents.length > 0 && !contents.endsWith("\n")) contents += "\n";
  return contents;
};

const readUpdateChunks = (cursor: ParseCursor): UpdateChunk[] => {
  const chunks: UpdateChunk[] = [];
  while (cursor.i < cursor.endIdx && !cursor.lines[cursor.i]!.startsWith("***")) {
    if (!cursor.lines[cursor.i]!.startsWith("@@")) {
      cursor.i += 1;
      continue;
    }
    const changeContext = cursor.lines[cursor.i]!.slice(2).trim() || undefined;
    cursor.i += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let isEndOfFile = false;
    while (
      cursor.i < cursor.endIdx &&
      !cursor.lines[cursor.i]!.startsWith("@@") &&
      !cursor.lines[cursor.i]!.startsWith("***")
    ) {
      const change = cursor.lines[cursor.i]!;
      if (change === "*** End of File") {
        isEndOfFile = true;
        cursor.i += 1;
        break;
      }
      if (change.startsWith(" ")) {
        oldLines.push(change.slice(1));
        newLines.push(change.slice(1));
      } else if (change.startsWith("-")) {
        oldLines.push(change.slice(1));
      } else if (change.startsWith("+")) {
        newLines.push(change.slice(1));
      }
      cursor.i += 1;
    }
    chunks.push({ oldLines, newLines, changeContext, isEndOfFile });
  }
  return chunks;
};

export const parsePatch = (patchText: string): Result.Result<readonly PatchHunk[], PatchError> => {
  const lines = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const beginIdx = lines.findIndex((line) => line.trim() === BEGIN);
  const endIdx = lines.findIndex((line) => line.trim() === END);
  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    return Result.fail(new PatchError({ message: "invalid patch: missing Begin/End markers" }));
  }
  const hunks: PatchHunk[] = [];
  const cursor: ParseCursor = { lines, endIdx, i: beginIdx + 1 };
  while (cursor.i < endIdx) {
    const line = lines[cursor.i]!;
    if (line.startsWith("*** Add File:")) {
      const path = line.slice("*** Add File:".length).trim();
      if (!path)
        return Result.fail(new PatchError({ message: "invalid patch: empty Add File path" }));
      cursor.i += 1;
      hunks.push({ type: "add", path, contents: readAddContents(cursor) });
      continue;
    }
    if (line.startsWith("*** Delete File:")) {
      const path = line.slice("*** Delete File:".length).trim();
      if (!path)
        return Result.fail(new PatchError({ message: "invalid patch: empty Delete File path" }));
      hunks.push({ type: "delete", path });
      cursor.i += 1;
      continue;
    }
    if (line.startsWith("*** Update File:")) {
      const path = line.slice("*** Update File:".length).trim();
      if (!path)
        return Result.fail(new PatchError({ message: "invalid patch: empty Update File path" }));
      cursor.i += 1;
      let movePath: string | undefined;
      if (cursor.i < endIdx && lines[cursor.i]!.startsWith("*** Move to:")) {
        movePath = lines[cursor.i]!.slice("*** Move to:".length).trim();
        cursor.i += 1;
      }
      hunks.push({ type: "update", path, movePath, chunks: readUpdateChunks(cursor) });
      continue;
    }
    cursor.i += 1;
  }
  if (hunks.length === 0) {
    return Result.fail(new PatchError({ message: "patch rejected: empty patch" }));
  }
  return Result.succeed(hunks);
};

const linesMatch = (
  haystack: readonly string[],
  pattern: readonly string[],
  at: number,
): boolean => {
  for (let j = 0; j < pattern.length; j++) {
    if (haystack[at + j] !== pattern[j]) return false;
  }
  return true;
};

const seekSequence = (
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
  eof = false,
): number => {
  if (pattern.length === 0) return startIndex;
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex && linesMatch(lines, pattern, fromEnd)) return fromEnd;
  }
  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    if (linesMatch(lines, pattern, i)) return i;
  }
  return -1;
};

export const applyUpdateChunks = (
  path: string,
  originalContent: string,
  chunks: readonly UpdateChunk[],
): Result.Result<string, PatchError> => {
  let originalLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  if (originalLines.length > 0 && originalLines.at(-1) === "")
    originalLines = originalLines.slice(0, -1);

  const replacements: Array<[number, number, readonly string[]]> = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIdx = seekSequence(originalLines, [chunk.changeContext], lineIndex);
      if (contextIdx === -1) {
        return Result.fail(
          new PatchError({
            message: [
              `apply_patch: failed to find context '${chunk.changeContext}' in ${path} (search from line ${lineIndex + 1}).`,
              `Nearby:\n${patchNearby(originalLines, lineIndex)}`,
              "Re-read the file and refresh the @@ context.",
            ].join("\n"),
          }),
        );
      }
      lineIndex = contextIdx + 1;
    }
    if (chunk.oldLines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 && originalLines.at(-1) === ""
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIdx, 0, chunk.newLines]);
      continue;
    }
    let pattern = [...chunk.oldLines];
    let newSlice = [...chunk.newLines];
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile === true);
    if (found === -1 && pattern.length > 0 && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice.at(-1) === "") newSlice = newSlice.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile === true);
    }
    if (found === -1) {
      return Result.fail(
        new PatchError({
          message: [
            `apply_patch: failed to find expected lines in ${path} (search from line ${lineIndex + 1}):`,
            chunk.oldLines.join("\n"),
            `Nearby:\n${patchNearby(originalLines, lineIndex)}`,
            "Re-read that span and retry with exact lines.",
          ].join("\n"),
        }),
      );
    }
    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }
  replacements.sort((a, b) => a[0] - b[0]);
  const result = [...originalLines];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i]!;
    result.splice(startIdx, oldLen, ...newSegment);
  }
  if (result.length === 0 || result.at(-1) !== "") result.push("");
  return Result.succeed(result.join("\n"));
};

/**
 * Validate every hunk against supplied file contents. Missing map entries mean
 * "file does not exist". Returns planned mutations; caller persists atomically.
 */
export const planPatch = (
  hunks: readonly PatchHunk[],
  files: ReadonlyMap<string, string | undefined>,
): Result.Result<readonly PlannedChange[], PatchError> => {
  const planned: PlannedChange[] = [];
  for (const hunk of hunks) {
    if (hunk.type === "add") {
      if (files.get(hunk.path) !== undefined) {
        return Result.fail(
          new PatchError({ message: `apply_patch: file already exists: ${hunk.path}` }),
        );
      }
      planned.push({
        type: "add",
        path: hunk.path,
        content: hunk.contents,
        diff: conciseDiff(hunk.path, "", hunk.contents),
      });
      continue;
    }
    if (hunk.type === "delete") {
      const content = files.get(hunk.path);
      if (content === undefined) {
        return Result.fail(
          new PatchError({ message: `apply_patch: file to delete not found: ${hunk.path}` }),
        );
      }
      planned.push({
        type: "delete",
        path: hunk.path,
        diff: conciseDiff(hunk.path, content, ""),
      });
      continue;
    }
    const content = files.get(hunk.path);
    if (content === undefined) {
      return Result.fail(
        new PatchError({ message: `apply_patch: file to update not found: ${hunk.path}` }),
      );
    }
    const next = applyUpdateChunks(hunk.path, content, hunk.chunks);
    if (Result.isFailure(next)) {
      return Result.fail(next.failure);
    }
    planned.push({
      type: "update",
      path: hunk.path,
      movePath: hunk.movePath,
      content: next.success,
      diff: conciseDiff(hunk.path, content, next.success),
    });
  }
  return Result.succeed(planned);
};
