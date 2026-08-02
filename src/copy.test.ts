import { run, runAsync, scopedSpaceSet } from "./harness.ts"
import { test, expect, afterEach } from "bun:test"
import { MouseEvent, BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Agent } from "./agent.ts"
import { TerminalPane } from "./pane.ts"
import { CopyMode, backwardWordStart, foldQuery, forwardWordEnd, forwardWordStart } from "./copy.ts"
import { createBindings, type CommandSpec } from "./bindings.ts"
import { RenderState, Terminal } from "./ghostty.ts"
import { SpaceSet } from "./space.ts"
import { makeLayout } from "./layout.ts"
import { workspaceEnv } from "./env.ts"

const bytes = (value: string) => new TextEncoder().encode(value)

/** A pane on a tombstone agent (no PTY) with a real ghostty terminal, sized
 *  40x10. The pane is never mounted — CopyMode only reads the terminal and
 *  calls invalidate/copyText, neither of which needs layout. */
async function makePane(vt: string) {
  const t = await createTestRenderer({ width: 80, height: 24 })
  const agent = new Agent({ cmd: ["true"], exited: { code: 0 }, cols: 40, rows: 10 })
  const pane = new TerminalPane(t.renderer, { id: "pane", agent })
  agent.term.resize(40, 10)
  if (vt) agent.term.write(bytes(vt))
  return {
    t,
    agent,
    pane,
    dispose: () => {
      pane.destroyRecursively()
      agent.dispose()
      t.renderer.destroy()
    },
  }
}

/** Enter copy mode on a fresh pane and return the mode plus helpers. */
async function modeOn(vt: string) {
  const env = await makePane(vt)
  const mode = new CopyMode()
  mode.enter(env.pane)
  return { ...env, mode }
}

/** The cells ghostty reports as selected, in scrollback coordinates. Only
 *  cells carrying text reach the render state, so a cursor parked on a blank
 *  cell reads as nothing here — cursor-position tests assert `mode.cursor`
 *  instead, and this is reserved for proving the highlight actually renders. */
function selected(term: Terminal): string[] {
  const state = new RenderState()
  state.update(term)
  const out: string[] = []
  const offset = term.scrollbar.offset
  state.forEachCell((x, y, _text, _f, _b, _w, sel) => {
    if (sel) out.push(`${x},${y + offset}`)
  })
  state.free()
  return out
}

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

/* ------------------------------------------------------------------ *
 * Pure text motions.
 * ------------------------------------------------------------------ */

test("forwardWordStart: next word, from whitespace, from mid-word", () => {
  const line = "foo bar  baz"
  expect(forwardWordStart(line, 0)).toBe(4)
  // Mid-word: skip the current word, land on the next.
  expect(forwardWordStart(line, 1)).toBe(4)
  // On whitespace before a word: land on that word.
  expect(forwardWordStart(line, 3)).toBe(4)
  expect(forwardWordStart(line, 7)).toBe(9)
  // Past the last word: no target on this row.
  expect(forwardWordStart(line, 11)).toBeNull()
  // Before the line: the first word counts.
  expect(forwardWordStart(line, -1)).toBe(0)
  expect(forwardWordStart("  spaced", -1)).toBe(2)
})

test("forwardWordEnd: end of current word, then next", () => {
  const line = "foo bar  baz"
  expect(forwardWordEnd(line, 0)).toBe(2)
  expect(forwardWordEnd(line, 1)).toBe(2)
  // On whitespace: end of the next word.
  expect(forwardWordEnd(line, 3)).toBe(6)
  expect(forwardWordEnd(line, 7)).toBe(11)
  expect(forwardWordEnd("foo", 0)).toBe(2)
  expect(forwardWordEnd(line, 10)).toBe(11)
})

test("backwardWordStart: start of current word, then previous", () => {
  const line = "foo bar  baz"
  expect(backwardWordStart(line, 6)).toBe(4)
  expect(backwardWordStart(line, 5)).toBe(4)
  // From whitespace: the previous word's start.
  expect(backwardWordStart(line, 7)).toBe(4)
  expect(backwardWordStart(line, 4)).toBe(0)
  // From the top of the row: nothing here.
  expect(backwardWordStart(line, 0)).toBeNull()
  // From past the end (crossing from the next row): the last word.
  expect(backwardWordStart(line, line.length)).toBe(9)
})

test("foldQuery is smartcase", () => {
  expect(foldQuery("hello")).toBe("hello")
  expect(foldQuery("Hello")).toBe("Hello")
  expect(foldQuery("HELLO")).toBe("HELLO")
  expect(foldQuery("miXeD")).toBe("miXeD")
})

/* ------------------------------------------------------------------ *
 * Entering and leaving the mode.
 * ------------------------------------------------------------------ */

test("entering copy mode scrolls up one line and pins the cursor top-left", async () => {
  // 15 lines on a 10-row screen: 5 rows of history, viewport at the bottom.
  const vt = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\r\n")
  const { agent, mode, dispose } = await modeOn(vt)
  cleanup.push(dispose)
  const s = agent.term.scrollbar
  expect(s.total).toBe(15)
  // Entry parked the viewport one line up from the bottom.
  expect(s.offset).toBe(s.total - s.len - 1)
  // The cursor is the top-left of what is now visible.
  expect(mode.cursor).toEqual({ x: 0, y: s.offset })
  // And that cell carries the highlight, drawn as a one-cell selection.
  expect(selected(agent.term)).toEqual([`0,${s.offset}`])
  expect(mode.active).toBe(true)
})

test("q leaves copy mode without copying and clears the highlight", async () => {
  const { agent, pane, mode, dispose } = await modeOn("alpha\r\nbeta")
  cleanup.push(dispose)
  pane.onCopy = () => {
    throw new Error("must not copy on q")
  }
  mode.onKey({ name: "v" })
  mode.onKey({ name: "j" })
  mode.onKey({ name: "q" })
  expect(mode.active).toBe(false)
  expect(selected(agent.term)).toEqual([])
})

test("y without a selection just leaves", async () => {
  const { agent, pane, mode, dispose } = await modeOn("alpha\r\nbeta")
  cleanup.push(dispose)
  const copied: string[] = []
  pane.onCopy = (text) => {
    copied.push(text)
    return true
  }
  mode.onKey({ name: "y" })
  expect(copied).toEqual([])
  expect(mode.active).toBe(false)
  expect(selected(agent.term)).toEqual([])
})

/** Dispatch a real mouse-down through the pane's event path, exactly as the
 *  renderer delivers it. The pane is never mounted in these tests, so its
 *  origin is the renderer's (0,0) and its default edges add one column and one
 *  row of border padding: terminal cell (x, y) sits at event (x + 1, y + 1). */
function mouseDown(pane: TerminalPane, x: number, y: number, opts: { shift?: boolean } = {}) {
  const event = new MouseEvent(pane, {
    type: "down",
    button: 0,
    x: x + 1,
    y: y + 1,
    modifiers: { shift: !!opts.shift, alt: false, ctrl: false },
  })
  pane.processMouseEvent(event)
}

test("a real mouse-down starts the selection path and interrupts copy mode", async () => {
  const { agent, pane, mode, dispose } = await modeOn("alpha\r\nbeta")
  cleanup.push(dispose)
  const writes: string[] = []
  const origWrite = agent.write.bind(agent)
  agent.write = (data) => {
    writes.push(typeof data === "string" ? data : new TextDecoder().decode(data))
    origWrite(data)
  }
  expect(mode.active).toBe(true)
  // No mouse reporting, so a plain left-down claims a local drag selection —
  // the renderer's routing, not the interrupt hook called by hand.
  mouseDown(pane, 0, 0)
  expect(writes).toEqual([])
  expect(mode.active).toBe(false)
  // The selection really started: the mode's exit cleared the cursor highlight,
  // and the pane's own drag-selection slot now holds the cell it was pressed on.
  expect(selected(agent.term)).toEqual(["0,0"])
  // The interrupt hook is cleared, so a second drag is a no-op.
  expect(pane.onCopyModeInterrupt).toBeNull()
})

test("a click routed to a mouse-reporting child interrupts copy mode first", async () => {
  // vim-style: the child enabled SGR mouse reporting, so the pane hands the
  // event to it instead of starting a local selection.
  const { agent, pane, mode, dispose } = await modeOn("\x1b[?1000h\x1b[?1006h")
  cleanup.push(dispose)
  const atChildWrite = { active: null as boolean | null }
  const writes: string[] = []
  const origWrite = agent.write.bind(agent)
  agent.write = (data) => {
    atChildWrite.active = mode.active
    writes.push(typeof data === "string" ? data : new TextDecoder().decode(data))
    origWrite(data)
  }
  expect(mode.active).toBe(true)
  mouseDown(pane, 0, 0)
  // The child got its mouse sequence...
  expect(writes[0]).toContain("\u001B[<")
  // ...but copy mode was already out before the sequence was written.
  expect(atChildWrite.active).toBe(false)
  expect(mode.active).toBe(false)
  expect(pane.onCopyModeInterrupt).toBeNull()
})

test("re-entering copy mode on another pane starts fresh", async () => {
  const first = await makePane("one\r\ntwo")
  const second = await makePane("three\r\nfour")
  cleanup.push(first.dispose, second.dispose)
  const mode = new CopyMode()
  mode.enter(first.pane)
  mode.onKey({ name: "j" })
  mode.enter(second.pane)
  expect(mode.active).toBe(true)
  expect(mode.pane).toBe(second.pane)
  // The first pane's interrupt hook is cleared, so its mouse no longer exits.
  expect(first.pane.onCopyModeInterrupt).toBeNull()
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
})

/* ------------------------------------------------------------------ *
 * Cursor motion.
 * ------------------------------------------------------------------ */

test("j/k/h/l move the cursor and clamp at the scrollback edges", async () => {
  const { agent, mode, dispose } = await modeOn("alpha\r\nbeta\r\ngamma")
  cleanup.push(dispose)
  // No history, so the screen is rows 0..9 and the cursor starts at 0,0.
  mode.onKey({ name: "j" })
  mode.onKey({ name: "j" })
  expect(mode.cursor).toEqual({ x: 0, y: 2 })
  expect(selected(agent.term)).toEqual(["0,2"])
  mode.onKey({ name: "l" })
  expect(mode.cursor).toEqual({ x: 1, y: 2 })
  mode.onKey({ name: "h" })
  mode.onKey({ name: "h" })
  expect(mode.cursor).toEqual({ x: 0, y: 2 })
  // Clamped at the bottom row, not past it.
  for (let i = 0; i < 20; i++) mode.onKey({ name: "j" })
  expect(mode.cursor).toEqual({ x: 0, y: 9 })
  // And the arrows do the same as the vi keys.
  mode.onKey({ name: "up" })
  mode.onKey({ name: "right" })
  expect(mode.cursor).toEqual({ x: 1, y: 8 })
})

test("0 and $ move to the row ends; g and G to the scrollback ends", async () => {
  const { mode, dispose } = await modeOn("alpha beta\r\ngamma")
  cleanup.push(dispose)
  mode.onKey({ name: "$" })
  expect(mode.cursor).toEqual({ x: 39, y: 0 })
  mode.onKey({ name: "0" })
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
  mode.onKey({ name: "G" })
  expect(mode.cursor).toEqual({ x: 0, y: 9 })
  mode.onKey({ name: "g" })
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
})

test("word motions skip between words, across rows", async () => {
  const { agent, mode, dispose } = await modeOn("one two\r\nthree four")
  cleanup.push(dispose)
  mode.onKey({ name: "w" })
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
  mode.onKey({ name: "e" })
  expect(mode.cursor).toEqual({ x: 6, y: 0 })
  mode.onKey({ name: "w" })
  // Into the next row's first word.
  expect(mode.cursor).toEqual({ x: 0, y: 1 })
  mode.onKey({ name: "w" })
  expect(mode.cursor).toEqual({ x: 6, y: 1 })
  mode.onKey({ name: "b" })
  expect(mode.cursor).toEqual({ x: 0, y: 1 })
  mode.onKey({ name: "b" })
  // Back to the start of "two", the last word on the row above.
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
  mode.onKey({ name: "b" })
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
  // A word motion highlights the cell it lands on.
  expect(selected(agent.term)).toEqual(["0,0"])
})

test("paragraph motions jump to the nearest blank line", async () => {
  const { mode, dispose } = await modeOn("a\r\nb\r\n\r\nc\r\n\r\nd")
  cleanup.push(dispose)
  mode.onKey({ name: "}" })
  expect(mode.cursor).toEqual({ x: 0, y: 2 })
  mode.onKey({ name: "}" })
  expect(mode.cursor).toEqual({ x: 0, y: 4 })
  mode.onKey({ name: "}" })
  // The blank screen rows below count: the first one is row 6.
  expect(mode.cursor).toEqual({ x: 0, y: 6 })
  mode.onKey({ name: "{" })
  expect(mode.cursor).toEqual({ x: 0, y: 4 })
  mode.onKey({ name: "{" })
  expect(mode.cursor).toEqual({ x: 0, y: 2 })
  mode.onKey({ name: "{" })
  // No blank line above: fall to the top.
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
})

test("page and half-page motions move the cursor by a screen", async () => {
  const { mode, dispose } = await modeOn("")
  cleanup.push(dispose)
  mode.onKey({ name: "pagedown" })
  expect(mode.cursor).toEqual({ x: 0, y: 9 })
  mode.onKey({ name: "u", ctrl: true })
  // A half-page up from the bottom of a 10-row screen.
  expect(mode.cursor).toEqual({ x: 0, y: 4 })
  mode.onKey({ name: "f", ctrl: true })
  expect(mode.cursor).toEqual({ x: 0, y: 9 })
  mode.onKey({ name: "pageup" })
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
  mode.onKey({ name: "d", ctrl: true })
  expect(mode.cursor).toEqual({ x: 0, y: 5 })
})

/* ------------------------------------------------------------------ *
 * Selection and yank.
 * ------------------------------------------------------------------ */

test("v starts a selection that yank copies and then leaves", async () => {
  const { agent, pane, mode, dispose } = await modeOn("alpha beta\r\ngamma delta")
  cleanup.push(dispose)
  const copied: string[] = []
  pane.onCopy = (text) => {
    copied.push(text)
    return true
  }
  mode.onKey({ name: "j" })
  mode.onKey({ name: "v" })
  mode.onKey({ name: "e" })
  // The selection spans the anchored cell through the word's end, inclusive,
  // and renders as the highlight.
  expect(selected(agent.term)).toEqual(["0,1", "1,1", "2,1", "3,1", "4,1"])
  mode.onKey({ name: "y" })
  expect(copied).toEqual(["gamma"])
  expect(mode.active).toBe(false)
  expect(selected(agent.term)).toEqual([])
})

test("a selection spanning rows captures each whole row, trimmed", async () => {
  const { pane, mode, dispose } = await modeOn("alpha\r\nbeta\r\ngamma")
  cleanup.push(dispose)
  const copied: string[] = []
  pane.onCopy = (text) => {
    copied.push(text)
    return true
  }
  mode.onKey({ name: "j" })
  mode.onKey({ name: "v" })
  mode.onKey({ name: "$" })
  mode.onKey({ name: "j" })
  mode.onKey({ name: "y" })
  expect(copied).toEqual(["beta\ngamma"])
})

test("escape drops the selection first, then quits", async () => {
  const { agent, pane, mode, dispose } = await modeOn("alpha\r\nbeta")
  cleanup.push(dispose)
  pane.onCopy = () => {
    throw new Error("must not copy")
  }
  mode.onKey({ name: "j" })
  mode.onKey({ name: "v" })
  mode.onKey({ name: "j" })
  expect(mode.cursor).toEqual({ x: 0, y: 2 })
  // A selection crossing rows highlights every intermediate row in full.
  expect(selected(agent.term)).toEqual(["0,1", "1,1", "2,1", "3,1"])
  mode.onKey({ name: "escape" })
  expect(mode.active).toBe(true)
  // Selection dropped to a cursor-only highlight; the cursor did not move.
  expect(mode.cursor).toEqual({ x: 0, y: 2 })
  expect(selected(agent.term)).toEqual([])
  mode.onKey({ name: "escape" })
  expect(mode.active).toBe(false)
})

test("enter yanks like y", async () => {
  const { pane, mode, dispose } = await modeOn("alpha\r\nbeta")
  cleanup.push(dispose)
  const copied: string[] = []
  pane.onCopy = (text) => {
    copied.push(text)
    return true
  }
  mode.onKey({ name: "v" })
  mode.onKey({ name: "$" })
  mode.onKey({ name: "j" })
  mode.onKey({ name: "return" })
  expect(copied).toEqual(["alpha\nbeta"])
})

test("yank keeps leading indentation, like the mouse-drag path and tmux", async () => {
  const { pane, mode, dispose } = await modeOn("  indented\r\nplain")
  cleanup.push(dispose)
  const copied: string[] = []
  pane.onCopy = (text) => {
    copied.push(text)
    return true
  }
  mode.onKey({ name: "v" })
  mode.onKey({ name: "$" })
  mode.onKey({ name: "y" })
  expect(copied).toEqual(["  indented"])
})

/* ------------------------------------------------------------------ *
 * Search.
 * ------------------------------------------------------------------ */

test("forward and backward search move to the match and wrap around", async () => {
  const { agent, mode, dispose } = await modeOn("alpha beta\r\ngamma alpha")
  cleanup.push(dispose)
  mode.search("alpha", "forward")
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
  expect(selected(agent.term)).toEqual(["0,0"])
  mode.onKey({ name: "n" })
  expect(mode.cursor).toEqual({ x: 6, y: 1 })
  mode.onKey({ name: "n" })
  // Wraps around to the first match.
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
  mode.onKey({ name: "N" })
  expect(mode.cursor).toEqual({ x: 6, y: 1 })
  mode.search("alpha", "backward")
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
})

test("search respects the cursor: forward is inclusive, repeat is not", async () => {
  const { mode, dispose } = await modeOn("one one")
  cleanup.push(dispose)
  mode.search("one", "forward")
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
  // n must advance past the match under the cursor, not re-land on it.
  mode.onKey({ name: "n" })
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
})

/* ------------------------------------------------------------------ *
 * Search over wide characters.
 *
 * A match position is a string index into the captured text; the cursor and
 * selection live in terminal cells. A CJK character or emoji occupies two
 * cells, so the two diverge the moment a wide grapheme precedes the match.
 * These tests run against a real ghostty terminal and assert the cursor (and
 * the rendered highlight) lands on the cells the match actually occupies.
 * ------------------------------------------------------------------ */

test("forward search lands on the cells of a match after CJK characters", async () => {
  const { agent, mode, dispose } = await modeOn("你好foo bar")
  cleanup.push(dispose)
  // 你 spans cells 0-1 and 好 spans 2-3, so "foo" begins at cell 4 — not at
  // its string index 2. The cursor and the highlight must sit on cell 4.
  mode.search("foo", "forward")
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
  expect(selected(agent.term)).toEqual(["4,0"])
})

test("n and N repeat over CJK-prefixed matches by cell, not string index", async () => {
  const { mode, dispose } = await modeOn("你好foo\r\nbar foo")
  cleanup.push(dispose)
  // Row 0: 你@0-1, 好@2-3, so "foo" begins at cell 4 — not its string index 2.
  mode.search("foo", "forward")
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
  mode.onKey({ name: "n" })
  expect(mode.cursor).toEqual({ x: 4, y: 1 })
  mode.onKey({ name: "n" })
  // Wraps around to the first match again.
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
  mode.onKey({ name: "N" })
  expect(mode.cursor).toEqual({ x: 4, y: 1 })
})

test("a search started on a wide row respects the cursor cell, inclusively", async () => {
  const { mode, dispose } = await modeOn("你好foo foo")
  cleanup.push(dispose)
  // Four rights walk past 你 and 好 (two wide cells each) onto 'f' at cell 4.
  for (let i = 0; i < 4; i++) mode.onKey({ name: "l" })
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
  // A fresh / may count the match beginning under the cursor, so it must land
  // on cell 4 rather than skimming past it in string-index space.
  mode.search("foo", "forward")
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
  // n skips the match under the cursor and advances to the one at cell 8.
  mode.onKey({ name: "n" })
  expect(mode.cursor).toEqual({ x: 8, y: 0 })
})

test("backward search lands on the cells of a match after CJK characters", async () => {
  const { mode, dispose } = await modeOn("alpha 你好foo")
  cleanup.push(dispose)
  // Park the cursor past the whole line, then search backwards.
  mode.onKey({ name: "$" })
  mode.search("foo", "backward")
  // 你@6-7 and 好@8-9 push "foo" to cell 10; its string index is 9.
  expect(mode.cursor).toEqual({ x: 10, y: 0 })
})

test("backward repeat (N) steps to the earlier match by cell on a wide row", async () => {
  const { mode, dispose } = await modeOn("你好foo 好foo")
  cleanup.push(dispose)
  // Two "foo" matches: at cell 4 and, after 你@0-1, 好@2-3, a space and 好@8-9,
  // at cell 10 (string index 9). Forward to the second, then N back.
  mode.search("foo", "forward")
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
  mode.onKey({ name: "n" })
  expect(mode.cursor).toEqual({ x: 10, y: 0 })
  mode.onKey({ name: "N" })
  // N continues backwards to the first match, landing at cell 4, not the
  // string index 2 that the CJK cells would otherwise skew it to.
  expect(mode.cursor).toEqual({ x: 4, y: 0 })
})

test("forward search lands on the cells of a match after an emoji", async () => {
  const { agent, mode, dispose } = await modeOn("👨你 foo")
  cleanup.push(dispose)
  // 👨 (a surrogate pair) spans cells 0-1, 你 spans 2-3, so "foo" starts at
  // cell 5 even though its string index is 4.
  mode.search("foo", "forward")
  expect(mode.cursor).toEqual({ x: 5, y: 0 })
  expect(selected(agent.term)).toEqual(["5,0"])
})

test("search counts a ZWJ family as the single cell the terminal gives it", async () => {
  const { mode, dispose } = await modeOn("👨‍👩‍👧 hit")
  cleanup.push(dispose)
  // The family renders as one two-cell-wide grapheme, so the space is at cell
  // 2 and "hit" begins at cell 3 — not at its string index 9.
  mode.search("hit", "forward")
  expect(mode.cursor).toEqual({ x: 3, y: 0 })
})

test("search counts a variation-selector emoji as its widened cell", async () => {
  const { mode, dispose } = await modeOn("❤️你 foo")
  cleanup.push(dispose)
  // ❤ + VS16 becomes a two-cell-wide grapheme (like 你), so "foo" begins at
  // cell 5 despite starting at string index 4.
  mode.search("foo", "forward")
  expect(mode.cursor).toEqual({ x: 5, y: 0 })
})

test("yank after a wide-char search captures the text at the matched cells", async () => {
  const { pane, mode, dispose } = await modeOn("你好foo bar")
  cleanup.push(dispose)
  const copied: string[] = []
  pane.onCopy = (text) => {
    copied.push(text)
    return true
  }
  mode.search("foo", "forward")
  mode.onKey({ name: "v" })
  mode.onKey({ name: "$" })
  mode.onKey({ name: "y" })
  // The anchor sat on cell 4 (the 'f'), not cell 2 (mid-好), so the capture
  // starts at "foo" and leaves the wide characters out of it.
  expect(copied).toEqual(["foo bar"])
})

/* ------------------------------------------------------------------ *
 * Word motion over wide characters.
 *
 * w/e/b scan a row's string indices, but the cursor and selection live in
 * cells. A CJK character, emoji, combining cluster, or ZWJ family breaks the
 * correspondence, so a motion must convert the cursor cell to a string index
 * before scanning and the landing index back to a cell. These tests assert
 * the cursor (and the rendered highlight) lands on the cells the word
 * actually occupies.
 * ------------------------------------------------------------------ */

test("w skips a CJK word by cell and lands on the next word's cell", async () => {
  const { agent, mode, dispose } = await modeOn("\u4F60\u597Dfoo bar")
  cleanup.push(dispose)
  // 你 spans cells 0-1 and 好 spans 2-3, so "bar" starts at cell 8 — not at
  // its string index 6. The highlight must sit on that cell too.
  mode.onKey({ name: "w" })
  expect(mode.cursor).toEqual({ x: 8, y: 0 })
  expect(selected(agent.term)).toEqual(["8,0"])
})

test("e lands on the last cell of a CJK-prefixed word", async () => {
  const { mode, dispose } = await modeOn("\u4F60\u597Dfoo bar")
  cleanup.push(dispose)
  // The word is 你好foo; it ends on the 'o' at cell 6, not its string index 4.
  mode.onKey({ name: "e" })
  expect(mode.cursor).toEqual({ x: 6, y: 0 })
})

test("b returns to the start of a wide-prefixed word", async () => {
  const { mode, dispose } = await modeOn("\u4F60\u597Dfoo bar")
  cleanup.push(dispose)
  mode.onKey({ name: "w" })
  mode.onKey({ name: "b" })
  // Back from "bar" to the start of the whole CJK-prefixed word at cell 0.
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
})

test("word motion crosses rows by cell through wide rows", async () => {
  const { mode, dispose } = await modeOn("\u4F60\u597Dfoo\r\nbar \u597D")
  cleanup.push(dispose)
  mode.onKey({ name: "w" })
  // Row 0 is one word (你好foo) with no break, so w falls to row 1's "bar".
  expect(mode.cursor).toEqual({ x: 0, y: 1 })
  mode.onKey({ name: "w" })
  // The next word on row 1 is 好 at cell 4, not at its string index 3.
  expect(mode.cursor).toEqual({ x: 4, y: 1 })
  mode.onKey({ name: "b" })
  expect(mode.cursor).toEqual({ x: 0, y: 1 })
  mode.onKey({ name: "b" })
  // Up to the last word on the row above: 你好foo's start at cell 0.
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
})

test("a ZWJ family is one word of one wide cluster", async () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"
  const { mode, dispose } = await modeOn(`${family} hit`)
  cleanup.push(dispose)
  // The family is one grapheme at cells 0-1, so "hit" starts at cell 3 even
  // though its 'h' is at string index 9. w must land on the cell.
  mode.onKey({ name: "w" })
  expect(mode.cursor).toEqual({ x: 3, y: 0 })
  mode.onKey({ name: "e" })
  // End of "hit" is the 't' at cell 5, not string index 11.
  expect(mode.cursor).toEqual({ x: 5, y: 0 })
  mode.onKey({ name: "b" })
  // b from mid-word lands on "hit"'s own start at cell 3...
  expect(mode.cursor).toEqual({ x: 3, y: 0 })
  mode.onKey({ name: "b" })
  // ...and once more onto the family word's start at cell 0.
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
})

test("a combining cluster counts as the single cell the terminal gives it", async () => {
  const { mode, dispose } = await modeOn("caf\u00E9 bar")
  cleanup.push(dispose)
  // café is one four-cell word: c@0, a@1, f@2, é@3. e lands on the é's cell
  // 3, not on its string index 4.
  mode.onKey({ name: "e" })
  expect(mode.cursor).toEqual({ x: 3, y: 0 })
  mode.onKey({ name: "w" })
  // The next word "bar" begins at cell 5.
  expect(mode.cursor).toEqual({ x: 5, y: 0 })
})

test("a selection started at a wide word's start yanks the word, not a slice of it", async () => {
  const { pane, mode, dispose } = await modeOn("\u4F60\u597Dfoo bar")
  cleanup.push(dispose)
  const copied: string[] = []
  pane.onCopy = (text) => {
    copied.push(text)
    return true
  }
  mode.onKey({ name: "v" })
  mode.onKey({ name: "e" })
  // The anchor sat on cell 0 and e landed on cell 6, so the selection is the
  // whole word 你好foo — a string-index e would have sliced through 好.
  mode.onKey({ name: "y" })
  expect(copied).toEqual(["\u4F60\u597Dfoo"])
})

test("smartcase: lowercase query matches capitals, capitals demand exact", async () => {
  const { mode, dispose } = await modeOn("Hello WORLD")
  cleanup.push(dispose)
  mode.search("hello", "forward")
  expect(mode.cursor).toEqual({ x: 0, y: 0 })
  mode.search("world", "forward")
  expect(mode.cursor).toEqual({ x: 6, y: 0 })
  // "World" has a capital, so it must match case-sensitively: no match.
  mode.search("World", "forward")
  expect(mode.cursor).toEqual({ x: 6, y: 0 })
})

test("a search with no match leaves the cursor where it is", async () => {
  const { mode, dispose } = await modeOn("alpha beta")
  cleanup.push(dispose)
  mode.onKey({ name: "j" })
  mode.search("absent", "forward")
  expect(mode.cursor).toEqual({ x: 0, y: 1 })
})

test("escape forgets the search before quitting the mode", async () => {
  const { mode, dispose } = await modeOn("alpha alpha")
  cleanup.push(dispose)
  mode.search("alpha", "forward")
  mode.onKey({ name: "n" })
  expect(mode.cursor).toEqual({ x: 6, y: 0 })
  mode.onKey({ name: "escape" })
  // The search is forgotten: n no longer repeats.
  mode.onKey({ name: "n" })
  expect(mode.cursor).toEqual({ x: 6, y: 0 })
  mode.onKey({ name: "escape" })
  expect(mode.active).toBe(false)
})

/* ------------------------------------------------------------------ *
 * Live output.
 * ------------------------------------------------------------------ */

test("output stays pinned when parked in history, and follows at the bottom", async () => {
  const vt = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\r\n")
  const { agent, mode, dispose } = await modeOn(vt)
  cleanup.push(dispose)
  // Parked in history: enter scrolled up one, so the viewport is pinned.
  const parked = agent.term.scrollbar.offset
  agent.term.write(bytes("\r\nline 15"))
  expect(agent.term.scrollbar.offset).toBe(parked)
  // Cursor rides the live bottom.
  mode.onKey({ name: "G" })
  expect(mode.cursor).toEqual({ x: 0, y: 15 })
  agent.term.write(bytes("\r\nline 16"))
  expect(agent.term.scrollbar.offset).toBeGreaterThan(parked)
  // The viewport followed the output...
  expect(agent.term.atBottom).toBe(true)
  // ...and reconcile re-pins the cursor to the newest row.
  mode.reconcile()
  expect(mode.cursor).toEqual({ x: 0, y: 16 })
})

test("moving up off the live bottom pins the viewport against new output", async () => {
  const vt = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\r\n")
  const { agent, mode, dispose } = await modeOn(vt)
  cleanup.push(dispose)
  mode.onKey({ name: "G" })
  expect(agent.term.atBottom).toBe(true)
  mode.onKey({ name: "k" })
  // Moving up off the newest row parks the viewport...
  expect(agent.term.atBottom).toBe(false)
  const parked = agent.term.scrollbar.offset
  agent.term.write(bytes("\r\nline 15"))
  // ...and new output leaves it exactly where it was.
  expect(agent.term.scrollbar.offset).toBe(parked)
  expect(mode.cursor).toEqual({ x: 0, y: 13 })
})

/* ------------------------------------------------------------------ *
 * App keymap integration.
 * ------------------------------------------------------------------ */

test("the keymap enters copy mode and the leader keeps its meaning inside it", async () => {
  const t = await createTestRenderer({ width: 60, height: 12 })
  const agent = new Agent({ cmd: ["true"], exited: { code: 0 }, cols: 40, rows: 10 })
  const pane = new TerminalPane(t.renderer, { id: "pane", agent })
  agent.term.resize(40, 10)
  agent.term.write(bytes("alpha beta\r\ngamma"))
  const mode = new CopyMode()
  let focusLeft = 0
  const commands: CommandSpec[] = [
    {
      name: "pane.copy-mode",
      key: "<leader>[",
      desc: "copy mode",
      group: "panes",
      run: () => mode.enter(pane),
    },
    {
      name: "pane.focus-left",
      key: "<leader>h",
      desc: "focus left",
      group: "panes",
      run: () => focusLeft++,
    },
  ]
  const bindings = createBindings(t.renderer, commands, {
    onUnhandled: (event) => {
      if (mode.active && mode.pane === pane) return mode.onKey(event)
      return true
    },
  })

  t.mockInput.pressKey("a", { ctrl: true })
  t.mockInput.pressKey("[")
  expect(mode.active).toBe(true)
  t.mockInput.pressKey("l")
  expect(mode.cursor).toEqual({ x: 1, y: 0 })

  // The leader is a keymap sequence, so ^a h still dispatches its command
  // instead of being swallowed by the mode.
  t.mockInput.pressKey("a", { ctrl: true })
  t.mockInput.pressKey("h")
  expect(focusLeft).toBe(1)
  expect(mode.active).toBe(true)

  // A bare h is an unbound key, so the mode owns it as a motion.
  t.mockInput.pressKey("h")
  expect(mode.cursor).toEqual({ x: 0, y: 0 })

  // q ends the mode; ^a [ enters it again fresh.
  t.mockInput.pressKey("q")
  expect(mode.active).toBe(false)
  t.mockInput.pressKey("a", { ctrl: true })
  t.mockInput.pressKey("[")
  expect(mode.active).toBe(true)
  expect(mode.cursor).toEqual({ x: 0, y: 0 })

  pane.destroyRecursively()
  agent.dispose()
  t.renderer.destroy()
})

/* ------------------------------------------------------------------ *
 * Teardown safety.
 *
 * main.tsx is an app entry that boots a client, so it cannot be imported
 * here. These tests reproduce its copy-mode teardown wiring — the orphan
 * guard on onChange plus the exit-before-teardown every pane-destroying
 * command applies — and drive the REAL Window/Space close and replacement
 * ordering, which hook-only tests cannot reach.
 * ------------------------------------------------------------------ */

/** A real window with `count` tombstone agents on real ghostty terminals.
 *  `split` leaves the last-created pane focused and every earlier one parked. */
async function makeWindow(count: number) {
  const t = await createTestRenderer({ width: 80, height: 24 })
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 })
  const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer), paneHost)
  const space = run(spaces.create("proj", process.cwd()))
  const win = run(space.newWindow())
  const agents = Array.from({ length: count }, () =>
    run(win.startAgent({ cmd: ["true"], exited: { code: 0 }, cols: 40, rows: 10 })),
  )
  const panes = agents.map((agent, i) => win.split(i === 0 ? "row" : "column", agent)!)
  return { t, spaces, space, win, agents, panes }
}

/** The same teardown discipline main.tsx wires: the orphan guard reacts to a
 *  pane leaving the tree, and `stepDown` is the exit-before-teardown the
 *  destructive commands call first. */
function wireCopyModeTeardown(spaces: SpaceSet, mode: CopyMode) {
  const stillMounted = (pane: TerminalPane): boolean =>
    spaces.spaces.some((s) => s.windows.some((w) => w.panes.includes(pane)))
  const prior = spaces.onChange
  spaces.onChange = () => {
    prior?.()
    const pane = mode.active ? mode.pane : null
    if (pane && !stillMounted(pane)) mode.exit()
  }
  const stepDown = (panes: TerminalPane | readonly TerminalPane[]) => {
    const pane = mode.pane
    if (!pane) return
    const affected = Array.isArray(panes) ? panes.includes(pane) : panes === pane
    if (affected) mode.exit()
  }
  return { stepDown }
}

/** Flag any call to the pane's invalidate that happens after the pane was
 *  destroyed — the exact call the teardown fixes must prevent. */
function trackInvalidateAfterDestroy(pane: TerminalPane) {
  let afterDestroy = false
  const real = pane.invalidate.bind(pane)
  pane.invalidate = () => {
    if (pane.isDestroyed) afterDestroy = true
    real()
  }
  return { get: () => afterDestroy }
}

test("closing a window ends copy mode before its terminal is freed", async () => {
  const { t, spaces, space, win, panes } = await makeWindow(2)
  cleanup.push(() => {
    t.renderer.destroy()
  })
  const paneA = panes[0]!
  // The copy-mode pane is the unfocused one: closing the window used to free
  // its terminal before the orphan guard ever ran, so CopyMode.exit's
  // clearSelection hit a freed handle — a segfault no try/catch can see.
  expect(win.focused).not.toBe(paneA)

  const mode = new CopyMode()
  const { stepDown } = wireCopyModeTeardown(spaces, mode)
  mode.enter(paneA)
  expect(mode.active).toBe(true)

  const invalidateAfterDestroy = trackInvalidateAfterDestroy(paneA)

  // The same exit-before-teardown main.tsx's window.close / killSelection apply.
  stepDown(win.panes)
  await runAsync(space.closeWindow(win))

  expect(paneA.isDestroyed).toBe(true)
  expect(mode.active).toBe(false)
  expect(invalidateAfterDestroy.get()).toBe(false)
})

test("replacing the layout ends copy mode before leftover panes are destroyed", async () => {
  const { t, spaces, space, win, panes, agents } = await makeWindow(3)
  cleanup.push(() => {
    t.renderer.destroy()
  })
  const paneA = panes[0]!
  const agentB = agents[1]!
  const agentC = agents[2]!

  const mode = new CopyMode()
  const { stepDown } = wireCopyModeTeardown(spaces, mode)
  mode.enter(paneA)
  expect(mode.active).toBe(true)

  const invalidateAfterDestroy = trackInvalidateAfterDestroy(paneA)

  // A layout with no slot for agent A: applying it destroys pane A as a
  // leftover. main.tsx's layout commands step the mode down first, so the
  // destroyed pane is never invalidated.
  stepDown(win.panes)
  win.applyLayout(
    makeLayout(
      {
        type: "split",
        direction: "column",
        weight: 1,
        children: [
          { type: "pane", agent: agentB.id, weight: 1 },
          { type: "pane", agent: agentC.id, weight: 1 },
        ],
      },
      agentB.id,
    ),
  )

  expect(paneA.isDestroyed).toBe(true)
  expect(mode.active).toBe(false)
  expect(invalidateAfterDestroy.get()).toBe(false)
})
