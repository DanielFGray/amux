/**
 * Markdown code fences in chat text.
 *
 * Assistant messages arrive as plain text with ``` fences in them; the
 * transcript renders everything else wrapped and plain. Splitting is pure
 * string work so it is trivially testable — highlighting happens later, in
 * the `CodeBlock` view, which maps the info string to a tree-sitter
 * filetype through the shared highlight package.
 *
 * Backtick fences only (`~~~` stays prose): agents emit backticks, and one
 * fence style keeps the closer unambiguous. An unclosed fence runs to the
 * end of the text — a streaming answer's fence has no closer yet.
 */
import { Match } from "effect";

export type FenceSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly language: string; readonly code: string };

/** Line-scan mode: collecting prose, or collecting fence body. */
type Scan =
  | { readonly _tag: "prose"; readonly lines: readonly string[] }
  | { readonly _tag: "code"; readonly language: string; readonly lines: readonly string[] };

const opener = /^ {0,3}```(\S*)\s*$/;
const closer = /^ {0,3}```\s*$/;

const flushProse = (segments: FenceSegment[], lines: readonly string[]): void => {
  if (lines.length > 0) {
    segments.push({ kind: "text", text: lines.join("\n") });
  }
};

const advance = (scan: Scan, line: string, segments: FenceSegment[]): Scan =>
  Match.valueTags(scan, {
    prose: ({ lines }) => {
      const open = opener.exec(line);
      if (open !== null) {
        flushProse(segments, lines);
        return { _tag: "code" as const, language: open[1] ?? "", lines: [] as readonly string[] };
      }
      return { _tag: "prose" as const, lines: [...lines, line] };
    },
    code: ({ language, lines }) => {
      if (closer.exec(line) !== null) {
        segments.push({ kind: "code", language, code: lines.join("\n") });
        return { _tag: "prose" as const, lines: [] as readonly string[] };
      }
      return { _tag: "code" as const, language, lines: [...lines, line] };
    },
  });

const finish = (scan: Scan, segments: FenceSegment[]): void => {
  Match.valueTags(scan, {
    prose: ({ lines }) => {
      flushProse(segments, lines);
    },
    code: ({ language, lines }) => {
      segments.push({ kind: "code", language, code: lines.join("\n") });
    },
  });
};

export const splitFences = (text: string): readonly FenceSegment[] => {
  const segments: FenceSegment[] = [];
  let scan: Scan = { _tag: "prose", lines: [] };
  for (const line of text.split("\n")) {
    scan = advance(scan, line, segments);
  }
  finish(scan, segments);
  return segments;
};
