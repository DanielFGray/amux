/**
 * Helpers for rendering unified diffs produced by `conciseDiff`.
 *
 * OpenTUI's DiffRenderable takes one patch at a time (`parsePatch` → first
 * hunk set), so multi-file tool output is split here before each chunk is
 * handed to `<diff>`.
 */

/** Split a tool summary that embeds one or more unified diffs into patches. */
export const splitUnifiedDiffs = (text: string): readonly string[] => {
  const starts: number[] = [];
  const re = /^--- .+$/gm;
  for (const match of text.matchAll(re)) {
    if (match.index !== undefined) starts.push(match.index);
  }
  if (starts.length === 0) return [];
  const parts: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : text.length;
    const chunk = text.slice(start, end).trimEnd();
    if (chunk.includes("\n+++ ")) parts.push(chunk);
  }
  return parts;
};

/** Drop embedded unified diffs, leaving the prose summary for the tool card. */
export const stripUnifiedDiffs = (text: string): string => {
  const diffs = splitUnifiedDiffs(text);
  if (diffs.length === 0) return text;
  let rest = text;
  for (const diff of diffs) {
    rest = rest.replace(diff, "");
  }
  return rest.replace(/\n{3,}/g, "\n\n").trim();
};

/** Path from a unified diff's `+++` header, for filetype → syntax highlight. */
export const pathFromUnifiedDiff = (diff: string): string | undefined => {
  const match = /^\+\+\+ (?:[ab]\/)?(.+)$/m.exec(diff);
  if (match === null) return undefined;
  const path = match[1]!.trim();
  return path === "/dev/null" ? undefined : path;
};

/** Width above which OpenCode switches `<diff view>` to side-by-side. */
export const DIFF_SPLIT_MIN_WIDTH = 120;
