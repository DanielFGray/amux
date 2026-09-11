/**
 * Bounded read output for large files. Offset/limit slices stay verbatim;
 * unconstrained large reads return a head/tail outline plus how to page.
 */

export const SUMMARIZE_LINE_THRESHOLD = 100;
export const SUMMARIZE_CHAR_THRESHOLD = 8_000;
const OUTLINE_HEAD_LINES = 40;
const OUTLINE_TAIL_LINES = 20;
const STRUCTURE_HINT_CAP = 24;
const OUTLINE_LINE_CHAR_CAP = 240;

/** Lines that look like structure landmarks — cheap regex, not a parser. */
const STRUCTURE_LINE =
  /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|namespace|module)\b|^#{1,6}\s|\b(?:def|class|fn|func|pub\s+(?:fn|struct|enum|mod))\b/;

export const numberLines = (lines: readonly string[], startLine: number): string =>
  lines.map((line, index) => `${startLine + index}: ${line}`).join("\n");

const clipLine = (line: string): string =>
  line.length <= OUTLINE_LINE_CHAR_CAP ? line : `${line.slice(0, OUTLINE_LINE_CHAR_CAP - 1)}…`;

const numberClipped = (lines: readonly string[], startLine: number): string =>
  lines.map((line, index) => `${startLine + index}: ${clipLine(line)}`).join("\n");

const structureHints = (lines: readonly string[]): readonly string[] => {
  const hints: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!STRUCTURE_LINE.test(line.trimStart())) continue;
    hints.push(`${i + 1}: ${clipLine(line.trimEnd())}`);
    if (hints.length >= STRUCTURE_HINT_CAP) break;
  }
  return hints;
};

/**
 * Format a file's lines for the read tool.
 * Passing offset and/or limit always returns that slice verbatim.
 */
export const formatFileRead = (
  lines: readonly string[],
  input: { readonly offset?: number; readonly limit?: number },
): string => {
  const ranged = input.offset !== undefined || input.limit !== undefined;
  if (ranged) {
    const start = Math.max(0, (input.offset ?? 1) - 1);
    const end = start + (input.limit ?? lines.length - start);
    return numberLines(lines.slice(start, end), start + 1);
  }

  const charCount = lines.reduce((n, line) => n + line.length + 1, 0);
  const small = lines.length <= SUMMARIZE_LINE_THRESHOLD && charCount <= SUMMARIZE_CHAR_THRESHOLD;
  if (small) return numberLines(lines, 1);

  const head = lines.slice(0, Math.min(OUTLINE_HEAD_LINES, lines.length));
  const tailStart = Math.max(head.length, lines.length - OUTLINE_TAIL_LINES);
  const tail = lines.slice(tailStart);
  const omitted = Math.max(0, tailStart - head.length);
  const hints = structureHints(lines);
  const parts = [
    `File has ${lines.length} lines (~${charCount} chars). Showing outline; request a range with offset/limit for verbatim slices (e.g. offset=1 limit=50).`,
    "",
    "--- head ---",
    numberClipped(head, 1),
  ];
  if (hints.length > 0) {
    parts.push("", "--- structure ---", ...hints);
  }
  if (omitted > 0) {
    parts.push(
      "",
      `--- omitted ${omitted} lines (use offset=${head.length + 1} limit=N) ---`,
      "",
      "--- tail ---",
      numberClipped(tail, tailStart + 1),
    );
  }
  return parts.join("\n");
};
