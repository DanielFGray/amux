import { Terminal } from "./ghostty.ts"
import { captureRange } from "./shim.ts"

/** Row range in the terminal's scrollback space: row 0 is the oldest row the
 *  terminal still holds, and rows increase downward through the active screen. */
export interface RowRange {
  start: number
  end: number
}

/** The SCREEN point tag: every coordinate is in the uniform scrollback space. */
const SCREEN = 2

/** The rows currently visible in the pane's viewport. */
export function visibleRows(term: Terminal): RowRange {
  const s = term.scrollbar
  return { start: s.offset, end: Math.min(s.total - 1, s.offset + s.len - 1) }
}

/** Every row the terminal holds: the scrollback plus the active screen. */
export function scrollbackRows(term: Terminal): RowRange {
  const s = term.scrollbar
  return { start: 0, end: Math.max(0, s.total - 1) }
}

/**
 * Capture rows [range.start..range.end] (inclusive) at full width as plain
 * text, exactly as tmux's capture-pane would paste them.
 *
 * Rows inside the range are kept whole — blank lines stay blank lines, and
 * soft-wrapped rows stay wrapped — while trailing whitespace on an otherwise
 * non-blank row and trailing blank rows are dropped. The result has no
 * trailing newline. Wide characters are emitted as their own graphemes.
 *
 * Rows outside what the terminal actually holds are clamped away; a range
 * that touches nothing returns "".
 */
export function captureRows(term: Terminal, range: RowRange): string {
  const s = term.scrollbar
  const start = Math.max(0, Math.floor(range.start))
  const end = Math.min(s.total - 1, Math.floor(range.end))
  if (start > end || s.total <= 0) return ""
  const bytes = captureRange(term.handle, {
    startTag: SCREEN,
    startX: 0,
    startY: start,
    endTag: SCREEN,
    endX: term.cols - 1,
    endY: end,
  })
  return new TextDecoder().decode(bytes)
}

/** The rows around the viewport that tmux's -S/-E flags describe: `above` rows
 *  before the visible top, `below` rows after the visible bottom. */
export function captureRowsAround(term: Terminal, above: number, below: number): string {
  const s = term.scrollbar
  return captureRows(term, {
    start: s.offset - Math.max(0, above),
    end: s.offset + s.len - 1 + Math.max(0, below),
  })
}

/** The visible screen, like tmux's capture-pane with no flags. */
export function captureVisible(term: Terminal): string {
  return captureRows(term, visibleRows(term))
}

/** Everything the terminal still holds: scrollback and screen. */
export function captureScrollback(term: Terminal): string {
  return captureRows(term, scrollbackRows(term))
}

/** The two named capture spans tmux's capture-pane offers: the visible screen
 *  (no flags) and everything the terminal still holds (a range past the top).
 *  The popup toggles between them; arbitrary ranges are `captureRows`'s job. */
export type CaptureSpan = "visible" | "scrollback"

/** A capturable pane. Capture only reads the terminal, so the pane itself is
 *  just that terminal — a detached agent with no viewport is as capturable as
 *  the pane in front of you. */
export interface CaptureTarget {
  term: Terminal
  /** A human name for the target, for the popup's title and the filename. */
  describe: () => string
}

/** The text a capture span selects, so the popup can re-capture on a toggle. */
export function captureSpan(term: Terminal, span: CaptureSpan): string {
  return span === "scrollback" ? captureScrollback(term) : captureVisible(term)
}

/**
 * Pick the pane a capture command targets: the focused pane if there is one,
 * else the sidebar's selected agent, else nothing — an explicit miss the caller
 * must report. Unlike send-keys, the selected agent is not revealed first:
 * reading a terminal changes nothing, so a detached agent is captured exactly
 * as it is, with no viewport opened and no state touched.
 */
export function pickCaptureTarget(
  focused: CaptureTarget | null,
  selected: CaptureTarget | null,
): CaptureTarget | null {
  return focused ?? selected
}
