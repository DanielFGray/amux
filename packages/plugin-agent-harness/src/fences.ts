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
export type FenceSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly language: string; readonly code: string };

const opener = /^ {0,3}```(\S*)\s*$/;
const closer = /^ {0,3}```\s*$/;

export const splitFences = (text: string): readonly FenceSegment[] => {
  const segments: FenceSegment[] = [];
  const prose: string[] = [];
  let code: string[] | null = null;
  let language = "";

  const flushProse = (): void => {
    if (prose.length > 0) {
      segments.push({ kind: "text", text: prose.join("\n") });
      prose.length = 0;
    }
  };

  for (const line of text.split("\n")) {
    if (code === null) {
      const open = opener.exec(line);
      if (open !== null) {
        flushProse();
        code = [];
        language = open[1] ?? "";
      } else {
        prose.push(line);
      }
    } else if (closer.exec(line) !== null) {
      segments.push({ kind: "code", language, code: code.join("\n") });
      code = null;
      language = "";
    } else {
      code.push(line);
    }
  }
  if (code !== null) segments.push({ kind: "code", language, code: code.join("\n") });
  else flushProse();
  return segments;
};
