/**
 * Place an LSP hover popup near the cursor without covering the symbol when
 * there is room. Prefer below; flip above when the bottom edge is tight.
 * Cite: LineRow's absolute cursor glyph (EditorPane) — same gutter width.
 */

export const HOVER_GUTTER_WIDTH = 4;

export interface HoverPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
}

export interface PlaceHoverInput {
  readonly cursorRow: number;
  readonly cursorCol: number;
  readonly viewportTop: number;
  readonly paneWidth: number;
  readonly paneHeight: number;
  /** Columns reserved for the line-number gutter (0 when numbers are off). */
  readonly gutter: number;
  readonly contentLines: number;
  readonly preferredWidth?: number;
}

/** Compute absolute coords inside the editor pane for a hover popup. */
export const placeHoverPopup = (input: PlaceHoverInput): HoverPlacement => {
  const preferredWidth = input.preferredWidth ?? 72;
  const width = Math.min(preferredWidth, Math.max(20, input.paneWidth - 2));
  // Border accounts for 2 visual rows beyond content lines.
  // Cite: InlinePicker — OpenTUI maxHeight does not clip; use an explicit height later.
  const wanted = Math.min(16, Math.max(3, input.contentLines + 2));
  const contentHeight = Math.max(1, input.paneHeight - 1);
  const screenRow = Math.max(0, input.cursorRow - input.viewportTop);
  const below = screenRow + 1;
  const spaceBelow = Math.max(0, contentHeight - below);
  const spaceAbove = screenRow;
  const maxHeight = Math.min(wanted, contentHeight);
  const top =
    spaceBelow >= maxHeight || spaceBelow >= spaceAbove
      ? Math.min(below, Math.max(0, contentHeight - maxHeight))
      : Math.max(0, screenRow - maxHeight);
  const rawLeft = input.gutter + input.cursorCol;
  const left = Math.max(0, Math.min(rawLeft, Math.max(0, input.paneWidth - width)));
  return { left, top, width, maxHeight };
};

/** Split hover markdown/plaintext into display rows (trim trailing empties). */
export const hoverLines = (text: string): readonly string[] => {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  return lines.length > 0 ? lines : ["(empty)"];
};

/**
 * Soft-wrap one hard line to `width` cells.
 * Cite: plugin-agent-harness wrapLine — word boundary when possible, else hard cut.
 */
export const wrapHoverLine = (line: string, width: number): readonly string[] => {
  if (width <= 0) return [""];
  if (line.length === 0) return [""];
  const lines: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
};

/** Wrap every hard line, then keep at most `maxRows` (OpenTUI does not clip maxHeight). */
export const fitHoverText = (
  text: string,
  width: number,
  maxRows: number,
): { readonly text: string; readonly rows: number; readonly truncated: boolean } => {
  const wrapped = hoverLines(text).flatMap((line) => wrapHoverLine(line, Math.max(1, width)));
  const rows = Math.max(1, maxRows);
  if (wrapped.length <= rows) {
    return { text: wrapped.join("\n"), rows: wrapped.length, truncated: false };
  }
  return { text: wrapped.slice(0, rows).join("\n"), rows, truncated: true };
};

/** Inner content columns: box width minus L/R border and L/R padding.
 *  Cite: Hints.tsx — "2 for the border, 2 for the padding". */
export const hoverContentWidth = (boxWidth: number): number => Math.max(8, boxWidth - 4);

/** Inner content rows: box height minus top/bottom border (title rides the border). */
export const hoverContentRows = (boxMaxHeight: number): number => Math.max(1, boxMaxHeight - 2);

/**
 * Split fences first, then wrap each segment so fence markers never steal
 * rows and language info survives wrapping.
 */
export const fitHoverSegments = (
  text: string,
  width: number,
  maxRows: number,
): { readonly segments: readonly HoverSegment[]; readonly rows: number } => {
  const out: HoverSegment[] = [];
  let rows = 0;
  const budget = Math.max(1, maxRows);
  for (const segment of splitHoverSegments(text)) {
    if (rows >= budget) break;
    const body = segment.kind === "code" ? segment.code : segment.text;
    if (body.trim() === "" && segment.kind === "text") continue;
    const fitted = fitHoverText(body, width, budget - rows);
    if (fitted.rows === 0) continue;
    if (segment.kind === "code") {
      out.push({ kind: "code", language: segment.language, code: fitted.text });
    } else {
      out.push({ kind: "text", text: fitted.text });
    }
    rows += fitted.rows;
  }
  if (out.length === 0) {
    return { segments: [{ kind: "text", text: "(empty)" }], rows: 1 };
  }
  return { segments: out, rows };
};

/**
 * Markdown fence segments in hover text.
 * Cite: packages/plugin-agent-harness/src/fences.ts — same backtick-only
 * scanner; kept here so the editor does not depend on the harness package.
 */
export type HoverSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly language: string; readonly code: string };

type FenceScan =
  | { readonly _tag: "prose"; readonly lines: readonly string[] }
  | { readonly _tag: "code"; readonly language: string; readonly lines: readonly string[] };

const opener = /^ {0,3}```(\S*)\s*$/;
const closer = /^ {0,3}```\s*$/;

const flushProse = (segments: HoverSegment[], lines: readonly string[]): void => {
  if (lines.length > 0) segments.push({ kind: "text", text: lines.join("\n") });
};

/** Split hover markdown into prose vs fenced code for per-segment highlight. */
export const splitHoverSegments = (text: string): readonly HoverSegment[] => {
  const segments: HoverSegment[] = [];
  let scan: FenceScan = { _tag: "prose", lines: [] };
  for (const line of text.split("\n")) {
    if (scan._tag === "prose") {
      const open = opener.exec(line);
      if (open !== null) {
        flushProse(segments, scan.lines);
        scan = { _tag: "code", language: open[1] ?? "", lines: [] };
      } else {
        scan = { _tag: "prose", lines: [...scan.lines, line] };
      }
    } else if (closer.exec(line) !== null) {
      segments.push({ kind: "code", language: scan.language, code: scan.lines.join("\n") });
      scan = { _tag: "prose", lines: [] };
    } else {
      scan = { _tag: "code", language: scan.language, lines: [...scan.lines, line] };
    }
  }
  if (scan._tag === "prose") flushProse(segments, scan.lines);
  else segments.push({ kind: "code", language: scan.language, code: scan.lines.join("\n") });
  return segments;
};
