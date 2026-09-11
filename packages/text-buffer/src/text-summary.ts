/**
 * Text metrics for SumTree nodes — cite Zed `TextSummary` (utf-8 len, utf-16
 * len, newline count, last-line extent). `add` merges like Zed: a right sibling
 * with no newlines extends the left's last line.
 */
export interface TextSummary {
  /** UTF-8 byte length. */
  readonly bytes: number;
  /** UTF-16 code units (JS string length). */
  readonly chars: number;
  /** Count of `\n` characters. */
  readonly newlines: number;
  /** UTF-16 units after the last `\n` (whole text if no newline). */
  readonly lastLineChars: number;
}

export const TextSummary = {
  zero: {
    bytes: 0,
    chars: 0,
    newlines: 0,
    lastLineChars: 0,
  } as const satisfies TextSummary,

  of: (text: string): TextSummary => {
    if (text.length === 0) return TextSummary.zero;
    let newlines = 0;
    let lastLineChars = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        newlines += 1;
        lastLineChars = 0;
      } else {
        lastLineChars += 1;
      }
    }
    return {
      bytes: Buffer.byteLength(text, "utf8"),
      chars: text.length,
      newlines,
      lastLineChars,
    };
  },

  add: (left: TextSummary, right: TextSummary): TextSummary => {
    if (right.bytes === 0) return left;
    if (left.bytes === 0) return right;
    return {
      bytes: left.bytes + right.bytes,
      chars: left.chars + right.chars,
      newlines: left.newlines + right.newlines,
      lastLineChars:
        right.newlines === 0 ? left.lastLineChars + right.lastLineChars : right.lastLineChars,
    };
  },

  addAll: (summaries: readonly TextSummary[]): TextSummary => {
    let acc: TextSummary = TextSummary.zero;
    for (const summary of summaries) acc = TextSummary.add(acc, summary);
    return acc;
  },
};

/** Line count for a stored document body (empty rope counts as one blank line). */
export const lineCountOf = (summary: TextSummary): number =>
  summary.bytes === 0 ? 1 : summary.newlines;
