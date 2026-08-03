import { dlopen, FFIType as T, ptr } from "bun:ffi"
import type { KeyEvent } from "@opentui/core"
import type { TerminalPane } from "./pane.ts"
import { captureRows } from "./capture.ts"
import { LIB_DIR } from "./ghostty-library.ts"
import {
  ScrollTo,
  captureRange,
  clearSelection,
  scrollViewport,
  setSelection,
} from "./shim.ts"

/**
 * Keyboard copy mode: a tmux-style modal over a pane's terminal, entered with
 * `<leader>[`.
 *
 * The mode is a pure read layer — a cursor plus an optional selection drawn in
 * the uniform scrollback space via the existing setSelection/clearSelection
 * machinery. Nothing is sent to the child, so the process under the pane keeps
 * running while the mode is up, and the viewport behaves exactly as ghostty
 * already makes it behave outside the mode: pinned when parked in history,
 * following at the bottom. See #reconcile for the one place the mode tracks the
 * live bottom itself.
 */

/** The keys the mode reads off a keypress. A subset of KeyEvent, so tests can
 *  hand it a plain object instead of building a real renderer event. */
export interface CopyModeKey {
  name: string
  ctrl?: boolean
  shift?: boolean
  eventType?: string
}

/** A cell position in the terminal's uniform scrollback space: row 0 is the
 *  oldest row the terminal still holds, growing downward to the active screen. */
interface Point {
  x: number
  y: number
}

const isSpace = (char: string) => char.trim() === ""

/* ------------------------------------------------------------------ *
 * Pure text-level motions. Operate on one display row's text and return
 * the target column, or null when the row has no such position — the caller
 * then carries the motion across to the next row. These are the rules vim
 * (and tmux's vi copy mode, which copies them) uses.
 * ------------------------------------------------------------------ */

/** The column of the next word start at or after `col`. A col of -1 means the
 *  cursor is before the line, so the first word on it counts rather than being
 *  skipped. In a word, `w` skips to the start of the NEXT word; on whitespace
 *  it lands on the next word. */
export function forwardWordStart(line: string, col: number): number | null {
  const before = col < 0
  let i = Math.max(0, col)
  if (!before && i < line.length && !isSpace(line[i]!)) {
    while (i < line.length && !isSpace(line[i]!)) i++
  }
  while (i < line.length && isSpace(line[i]!)) i++
  return i < line.length ? i : null
}

/** The column of the end of the word at or after `col`. From inside a word `e`
 *  lands on that word's last character; from whitespace it lands on the next
 *  word's last character. */
export function forwardWordEnd(line: string, col: number): number | null {
  let i = Math.max(0, col)
  if (i < line.length && isSpace(line[i]!)) {
    while (i < line.length && isSpace(line[i]!)) i++
  }
  if (i >= line.length) return null
  let end = i
  while (end + 1 < line.length && !isSpace(line[end + 1]!)) end++
  return end
}

/** The column of the start of the word at or before `col`. `b` inside a word
 *  lands on its start; from whitespace it lands on the previous word's start. */
export function backwardWordStart(line: string, col: number): number | null {
  let i = Math.min(col - 1, line.length - 1)
  while (i >= 0 && isSpace(line[i]!)) i--
  if (i < 0) return null
  while (i > 0 && !isSpace(line[i - 1]!)) i--
  return i
}

/** Smartcase folding for literal search: case-insensitive unless the query
 *  itself contains an uppercase letter, in which case the match is exact. */
export function foldQuery(query: string): string {
  return /[A-Z]/.test(query) ? query : query.toLowerCase()
}

/* ------------------------------------------------------------------ *
 * Cell-aware text mapping.
 *
 * A captured row's text is plain Unicode, but the terminal laid it out in
 * cells: a CJK character or emoji is two cells wide, combining marks and
 * variation selectors attach to their cluster, and a ZWJ family collapses
 * into a single cell. Searching the text yields a string index; landing the
 * cursor or a selection needs the matching *cell* column. Rather than
 * approximate wcwidth, we walk the text with libghostty-vt's own width
 * engine — the same tables the terminal used when it printed the row — so
 * the mapping can never drift from the layout the terminal actually made.
 * ------------------------------------------------------------------ */

/** libghostty-vt's grapheme-width probe, loaded here only because copy mode
 *  is its sole consumer (and this file is the only one in scope to change).
 *  It measures already-laid-out text; it is not a terminal binding, so it
 *  lives apart from the bindings in ghostty.ts. */
const graphemeWidth = (() => {
  const lib = process.env.GHOSTTY_VT_LIB ?? `${LIB_DIR}/libghostty-vt.so.0.1.0`
  const { symbols } = dlopen(lib, {
    ghostty_unicode_grapheme_width: {
      args: [T.ptr, T.u64, T.ptr],
      returns: T.u64,
    },
  })
  const width = new Uint8Array(1)
  return (cps: Uint32Array): { consumed: number; width: number } => {
    if (cps.length === 0) return { consumed: 0, width: 0 }
    width[0] = 0
    const consumed = Number(
      symbols.ghostty_unicode_grapheme_width(ptr(cps), BigInt(cps.length), ptr(width)),
    )
    return { consumed, width: width[0]! }
  }
})()

/** A grapheme boundary in a captured row: the string index of its leading
 *  edge and the terminal cell column it sits at. The final entry is the row's
 *  end (`at` = text length), so every string index and every cell column has
 *  a value to resolve to. */
export interface RowMap {
  at: number[]
  col: number[]
}

/** Map a captured row's text onto its terminal cells: one entry per grapheme
 *  (the terminal's own cluster segmentation), plus the row's end. Printable
 *  ASCII text maps to the identity — `at[i] === col[i]` — so cell-aware
 *  search and word motion degrade to the plain string layer on ordinary rows.
 *  Rows holding anything else (control characters included) fall through to
 *  the cluster engine, whose width is the only source of truth. */
export function rowCells(text: string): RowMap {
  // Fast path: printable ASCII is one cell per code unit, so the map is the
  // identity without touching the FFI engine. Capture expands tabs to spaces,
  // so this covers every ordinary row; anything exotic falls through below.
  if (/^[\x20-\x7e]*$/.test(text)) {
    const n = text.length
    const at = new Array<number>(n + 1)
    const col = new Array<number>(n + 1)
    for (let i = 0; i <= n; i++) {
      at[i] = i
      col[i] = i
    }
    return { at, col }
  }
  const cps = new Uint32Array([...text].map((ch) => ch.codePointAt(0)!))
  const at: number[] = [0]
  const col: number[] = [0]
  let i = 0
  let str = 0
  while (i < cps.length) {
    const { consumed, width } = graphemeWidth(cps.subarray(i))
    for (let k = 0; k < consumed; k++) str += cps[i + k]! > 0xffff ? 2 : 1
    i += consumed
    at.push(str)
    col.push(col[col.length - 1]! + width)
  }
  return { at, col }
}

/** The cell column of the grapheme that contains string index `at`. A match
 *  always begins on a grapheme boundary, so a match index lands on its own
 *  leading cell. */
export function cellColumnOf(map: RowMap, at: number): number {
  let lo = 0
  let hi = map.at.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (map.at[mid]! <= at) lo = mid
    else hi = mid - 1
  }
  return map.col[lo]!
}

/** The string index of the first grapheme whose leading cell is at or past
 *  `col`: where a scan starting at a cursor cell must begin. Columns past the
 *  row resolve to the row's end. */
export function stringIndexOf(map: RowMap, col: number): number {
  let lo = 0
  let hi = map.col.length - 1
  let res = map.at[map.at.length - 1]!
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (map.col[mid]! >= col) {
      res = map.at[mid]!
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return res
}

/* ------------------------------------------------------------------ *
 * The mode itself.
 * ------------------------------------------------------------------ */

export class CopyMode {
  #pane: TerminalPane | null = null
  #cursor: Point = { x: 0, y: 0 }
  #anchor: Point | null = null
  #search: { query: string; dir: "forward" | "backward" } | null = null
  /** True while the cursor rides the live bottom of the scrollback. New output
   *  re-pins it to the newest row instead of leaving it stranded mid-history. */
  #following = false

  /** Fired on `/` and `?` — the app shows its search prompt, then calls
   *  `search` with the typed query. */
  onSearchRequest?: (dir: "forward" | "backward") => void
  /** Fired whenever the mode enters or exits, so the app can refresh chrome
   *  that reflects the mode (the tab marker). */
  onStateChange?: () => void

  get active(): boolean {
    return this.#pane !== null
  }

  get pane(): TerminalPane | null {
    return this.#pane
  }

  /** The cursor, in scrollback coordinates. Read-only, for chrome and tests. */
  get cursor(): { x: number; y: number } {
    return { ...this.#cursor }
  }

  get term() {
    return this.#pane!.agent.term
  }

  /**
   * Enter the mode on a pane. Ends any copy mode already up — there is one
   * mode in the app, and starting it again somewhere else starts it fresh.
   *
   * Entry is tmux's: scroll the viewport up one line so the mode starts
   * parked in history (new output will not yank the view), and put the cursor
   * at the top-left of what is now visible.
   */
  enter(pane: TerminalPane) {
    this.exit()
    this.#pane = pane
    pane.onCopyModeInterrupt = () => this.exit()
    scrollViewport(pane.agent.term.handle, ScrollTo.delta, -1)
    const s = pane.agent.term.scrollbar
    this.#cursor = { x: 0, y: Math.min(s.offset, Math.max(0, s.total - 1)) }
    this.#anchor = null
    this.#search = null
    this.#following = false
    this.#paint()
    this.#refresh()
    this.onStateChange?.()
  }

  /** Leave the mode without copying. The viewport stays where it is — the
   *  terminal was never moved on the way in, so it is not moved on the way out. */
  exit() {
    if (!this.#pane) return
    this.#pane.onCopyModeInterrupt = null
    try {
      clearSelection(this.#pane.agent.term.handle)
    } catch {
      // The terminal may already be gone under us (the pane was closed).
    }
    this.#pane.invalidate()
    this.#pane = null
    this.#anchor = null
    this.#search = null
    this.onStateChange?.()
  }

  /**
   * Handle one unhandled keystroke. Returns true always while active: every key
   * is consumed by the mode, so nothing leaks through to the child.
   */
  onKey(key: CopyModeKey): boolean {
    if (key.eventType && key.eventType !== "press" && key.eventType !== "repeat") return true
    this.reconcile()

    // Normalize like the bindings do, so "G" and shift+g are the same press
    // whether the terminal reported the capital as the name or as a shift.
    const letter = key.name.length === 1 && /[A-Za-z]/.test(key.name)
    const name = letter ? key.name.toLowerCase() : key.name
    const shift = !!key.shift || (letter && key.name !== key.name.toLowerCase())

    if (name === "escape") this.#escape()
    else if (name === "q") this.exit()
    else if (name === "h" || name === "left") this.#move(-1, 0)
    else if (name === "j" || name === "down") this.#move(0, 1)
    else if (name === "k" || name === "up") this.#move(0, -1)
    else if (name === "l" || name === "right") this.#move(1, 0)
    else if (name === "w") this.#word("forward-start")
    else if (name === "b") this.#word("backward-start")
    else if (name === "e") this.#word("forward-end")
    else if (name === "{") this.#paragraph("prev")
    else if (name === "}") this.#paragraph("next")
    else if (name === "pageup" || (key.ctrl && name === "b")) this.#page(-1)
    else if (name === "pagedown" || (key.ctrl && name === "f")) this.#page(1)
    else if (key.ctrl && name === "u") this.#halfPage(-1)
    else if (key.ctrl && name === "d") this.#halfPage(1)
    else if (name === "0") this.#to(0, this.#cursor.y)
    else if (name === "$") this.#to(this.term.cols - 1, this.#cursor.y)
    else if (name === "g" && !shift) this.#to(this.#cursor.x, 0)
    else if (name === "g" && shift) this.#to(this.#cursor.x, this.#total() - 1)
    else if (name === "v" || name === "space") this.#startSelection()
    else if (name === "y" || name === "return" || name === "enter") this.#yank()
    else if (name === "/") this.onSearchRequest?.("forward")
    else if (name === "?") this.onSearchRequest?.("backward")
    else if (name === "n" && !shift) this.#repeatSearch(false)
    else if (name === "n" && shift) this.#repeatSearch(true)
    return true
  }

  /** Search forward or backward for `query` from the cursor, wrapping around
   *  the scrollback. The query becomes the mode's search, so n/N repeat it. */
  search(query: string, dir: "forward" | "backward") {
    if (!this.#pane) return
    this.#search = { query, dir }
    this.#doSearch(query, dir, true)
  }

  /** Called on a timer while the mode is up, so output that lands while the
   *  cursor rides the bottom does not leave the highlight stranded on a row
   *  that stopped being the newest. */
  reconcile() {
    if (!this.#following || !this.#pane) return
    const s = this.term.scrollbar
    if (s.total === 0) return
    const last = s.total - 1
    if (this.#cursor.y === last) return
    this.#place(this.#cursor.x, last)
    this.#reveal()
    this.#paint()
    this.#refresh()
  }

  #startSelection() {
    this.#anchor = { ...this.#cursor }
    this.#paint()
    this.#refresh()
  }

  /** Copy the selection and leave the mode. A selection is what v or Space
   *  started; without one there is nothing to copy, so this is just leaving. */
  #yank() {
    const pane = this.#pane
    const a = this.#anchor
    if (!pane) return
    if (!a) {
      this.exit()
      return
    }
    const b = this.#cursor
    const start = a.y < b.y || (a.y === b.y && a.x <= b.x) ? a : b
    const end = start === a ? b : a
    const bytes = captureRange(pane.agent.term.handle, {
      startTag: 2,
      startX: start.x,
      startY: start.y,
      endTag: 2,
      endX: end.x,
      endY: end.y,
    })
    // The formatter trims trailing whitespace and blank lines, the way tmux's
    // capture-pane does; leading whitespace — indentation — is kept, exactly
    // as the mouse-drag copy path keeps it.
    const text = new TextDecoder().decode(bytes)
    this.exit()
    pane.copyText(text)
  }

  /** Escape backs out of the mode one layer at a time: drop an active
   *  selection first, then forget an active search, and only then leave. */
  #escape() {
    if (this.#anchor) {
      this.#anchor = null
      this.#paint()
      this.#refresh()
    } else if (this.#search) {
      this.#search = null
    } else {
      this.exit()
    }
  }

  #repeatSearch(reverse: boolean) {
    const s = this.#search
    if (!s) return
    const dir = reverse ? (s.dir === "forward" ? "backward" : "forward") : s.dir
    this.#doSearch(s.query, dir, false)
  }

  /**
   * Run one search pass and move the cursor to the first hit, wrapping around
   * the whole scrollback. `inclusive` decides whether the pass may count a
   * match starting exactly at the cursor: a fresh / may, n must not, or it
   * would never advance. Returns whether a match moved the cursor.
   */
  #doSearch(query: string, dir: "forward" | "backward", inclusive: boolean): boolean {
    const t = this.term
    const total = t.scrollbar.total
    if (total === 0) return false
    const folded = foldQuery(query)
    if (!folded) return false
    // Smartcase: a query with any uppercase letter matches exactly, anything
    // else matches case-insensitively (which is what foldQuery lowercased).
    const caseInsensitive = folded === query.toLowerCase()
    const fromRow = this.#cursor.y
    const fromCol = this.#cursor.x

    const rowText = (r: number) => {
      const line = captureRows(t, { start: r, end: r })
      return caseInsensitive ? line.toLowerCase() : line
    }

    for (let step = 0; step < total; step++) {
      const r = dir === "forward" ? (fromRow + step) % total : ((fromRow - step) % total + total) % total
      const line = rowText(r)
      // The scan begins at the cursor's cell on the starting row: a fresh /
      // may count a match starting there, a repeat (n/N) must skip it. The
      // cursor column is a cell; convert it to a string index through the
      // row's grapheme map so wide characters before it cannot skew the scan.
      const map = step === 0 ? rowCells(line) : null
      // Forward scans from the cursor cell (inclusive) or just past it
      // (repeat); backward scans strictly before the cursor, as the original
      // string-index code always did. Both are cell-aware conversions.
      const start = map
        ? dir === "forward"
          ? stringIndexOf(map, inclusive ? fromCol : fromCol + 1)
          : stringIndexOf(map, fromCol)
        : 0
      const at =
        dir === "forward"
          ? line.indexOf(folded, start)
          : step === 0
            ? line.slice(0, start).lastIndexOf(folded)
            : line.lastIndexOf(folded)
      if (at >= 0) {
        // The match is a string index; the cursor is a cell column. The map
        // (built for the matching row) converts one into the other.
        this.#place(cellColumnOf(map ?? rowCells(line), at), r)
        this.#afterMove()
        return true
      }
    }
    return false
  }

  /** Move the cursor by a cell delta, walking the edges off the scrollback. */
  #move(dx: number, dy: number) {
    this.#to(this.#cursor.x + dx, this.#cursor.y + dy)
  }

  /** Set the cursor, clamped into the terminal, and settle the follow flag:
   *  on the newest row the cursor rides new output; anywhere else it is pinned. */
  #place(x: number, y: number) {
    const total = Math.max(1, this.#total())
    this.#cursor = {
      x: Math.max(0, Math.min(this.term.cols - 1, x)),
      y: Math.max(0, Math.min(total - 1, y)),
    }
    this.#following = this.#cursor.y === total - 1
  }

  /** Place the cursor and settle the viewport and the highlight after it. */
  #to(x: number, y: number) {
    this.#place(x, y)
    this.#afterMove()
  }

  #afterMove() {
    this.#reveal()
    // Leaving the live bottom pins the viewport: ghostty keeps a viewport that
    // is at the bottom following output, so a cursor that just moved up off the
    // newest row would otherwise have the screen pulled out from under it.
    if (!this.#following && this.term.atBottom) {
      scrollViewport(this.term.handle, ScrollTo.delta, -1)
    }
    this.#paint()
    this.#refresh()
  }

  /**
   * Scroll the viewport just enough to keep the cursor on screen: nothing while
   * it is already visible, otherwise the minimal nudge. Delta rather than
   * `row` scrolling, so navigation never jumps the cursor to a page edge — and
   * ghostty clamps both ends, so the bottom of the scrollback is the limit.
   */
  #reveal() {
    const s = this.term.scrollbar
    if (s.total === 0) return
    const y = Math.max(0, Math.min(s.total - 1, this.#cursor.y))
    if (y < s.offset) {
      scrollViewport(this.term.handle, ScrollTo.delta, y - s.offset)
    } else if (y >= s.offset + s.len) {
      scrollViewport(this.term.handle, ScrollTo.delta, y - (s.offset + s.len) + 1)
    }
  }

  #page(dir: -1 | 1) {
    this.#move(0, dir * Math.max(1, this.term.scrollbar.len))
  }

  #halfPage(dir: -1 | 1) {
    this.#move(0, dir * Math.max(1, Math.floor(this.term.scrollbar.len / 2)))
  }

  /**
   * Word motion across rows: walk the display rows until a row yields a
   * target column, then move there. With no word left in the whole scrollback
   * the cursor falls to the edge of the direction it was moving.
   *
   * The pure text helpers work in string-index space, but the cursor lives in
   * cell space, and the two diverge on any row whose graphemes are not one
   * cell per code unit (CJK, emoji, combining marks, ZWJ families). So the
   * cursor cell is converted to a string index on the starting row, and a
   * found target index is converted back to a cell on the row it lands. Maps
   * are built only where they are used — the starting row and the landing row
   * — so a motion that walks many plain rows pays nothing for the engine.
   */
  #word(dir: "forward-start" | "forward-end" | "backward-start") {
    const total = this.#total()
    const from = { ...this.#cursor }
    let y = from.y
    for (let guard = 0; guard < total; guard++) {
      const line = this.#rowText(y)
      // The starting row must map the cursor cell to a string index; other
      // rows start the scan at a row edge (-1 / the end), which is already a
      // string position, so no map is needed until a landing row is found.
      const map = y === from.y ? rowCells(line) : null
      const startAt = map
        ? stringIndexOf(map, from.x)
        : dir === "backward-start"
          ? line.length
          : -1
      const next =
        dir === "forward-start"
          ? forwardWordStart(line, startAt)
          : dir === "forward-end"
            ? forwardWordEnd(line, startAt)
            : backwardWordStart(line, startAt)
      if (next !== null) {
        // The target is a string index; convert it to the cell column of the
        // grapheme it lands on. A word start is always a grapheme boundary,
        // and a word end inside a combining cluster resolves to that cluster's
        // leading cell, so the cursor lands where the word is actually drawn.
        this.#place(cellColumnOf(map ?? rowCells(line), next), y)
        this.#afterMove()
        return
      }
      if (dir === "backward-start") {
        if (y === 0) break
        y--
      } else {
        if (y === total - 1) break
        y++
      }
    }
    this.#place(0, dir === "backward-start" ? 0 : total - 1)
    this.#afterMove()
  }

  /** Jump to the next/previous blank line (whitespace-only), falling back to
   *  the edge of the scrollback when no paragraph boundary exists. */
  #paragraph(dir: "next" | "prev") {
    const total = this.#total()
    let y = this.#cursor.y
    const isBlank = (r: number) => this.#rowText(r).trim() === ""
    if (dir === "next") {
      while (y + 1 < total && !isBlank(y + 1)) y++
      y = y + 1 < total ? y + 1 : total - 1
    } else {
      while (y - 1 >= 0 && !isBlank(y - 1)) y--
      y = y - 1 >= 0 ? y - 1 : 0
    }
    this.#place(0, y)
    this.#afterMove()
  }

  #total(): number {
    return this.term.scrollbar.total
  }

  /** The text of one display row, trimmed the way captures are. */
  #rowText(r: number): string {
    return captureRows(this.term, { start: r, end: r })
  }

  /** Draw the current state: the selection when one is active, else a
   *  collapsed one-cell selection that ghostty renders as the cursor highlight. */
  #paint() {
    if (!this.#pane) return
    if (this.#anchor) {
      setSelection(
        this.term.handle,
        this.#anchor.x,
        this.#anchor.y,
        this.#cursor.x,
        this.#cursor.y,
      )
    } else {
      setSelection(this.term.handle, this.#cursor.x, this.#cursor.y, this.#cursor.x, this.#cursor.y)
    }
  }

  #refresh() {
    this.#pane?.invalidate()
  }
}
