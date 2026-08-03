/**
 * The replay serialization, in isolation.
 *
 * Attach replay's whole bet is that ghostty's own TerminalFormatter (VT mode)
 * can serialize an agent's active screen into bytes a fresh terminal consumes
 * to resume identical state. These tests hold that bet to a round trip: write
 * VT to one terminal, format it, feed the result to a fresh terminal, and
 * require the second to match the first — text and terminal modes alike. The
 * modes are what a bounded raw-byte replay cannot carry: they are built up
 * incrementally across the byte stream, and an application sitting in the
 * alternate screen would be drawn into the wrong screen without them.
 */

import { afterEach, expect, test } from "bun:test"
import { MODE_ALT_SCREEN, MODE_BRACKETED_PASTE, Terminal } from "./ghostty.ts"
import { formatScreen } from "./shim.ts"
import { captureVisible } from "./capture.ts"

const terminals: Terminal[] = []

afterEach(() => {
  for (const t of terminals.splice(0)) t.free()
})

/** Feed `vt` into a screen, serialize it, and apply the replay to a fresh one. */
function roundTrip(vt: string, cols = 40, rows = 10) {
  const source = new Terminal(cols, rows, 0)
  terminals.push(source)
  source.write(new TextEncoder().encode(vt))
  const bytes = formatScreen(source.handle)
  const target = new Terminal(cols, rows, 0)
  terminals.push(target)
  target.write(bytes)
  return { source, target, bytes }
}

test("formatScreen reproduces a plain screen in a fresh terminal", () => {
  const { source, target } = roundTrip("\x1b[2Jline one\r\nline two\r\nline three")
  expect(captureVisible(target)).toBe(captureVisible(source))
  expect(target.mode(MODE_ALT_SCREEN)).toBe(false)
})

test("formatScreen carries the alternate screen across a replay", () => {
  const { source, target } = roundTrip("\x1b[?1049h\x1b[2J\x1b[2;3Halt-mode-content")
  expect(source.mode(MODE_ALT_SCREEN)).toBe(true)
  expect(target.mode(MODE_ALT_SCREEN)).toBe(true)
  expect(captureVisible(target)).toBe(captureVisible(source))
})

test("a primary-screen replay leaves an old alternate screen behind", () => {
  const source = new Terminal(40, 10, 0)
  terminals.push(source)
  source.write(new TextEncoder().encode("primary-content"))
  const target = new Terminal(40, 10, 0)
  terminals.push(target)
  target.write(new TextEncoder().encode("\x1b[?1049h\x1b[2Jstale-alt"))
  target.write(formatScreen(source.handle))

  expect(source.mode(MODE_ALT_SCREEN)).toBe(false)
  expect(target.mode(MODE_ALT_SCREEN)).toBe(false)
  expect(captureVisible(target)).toBe(captureVisible(source))
})

test("formatScreen replays modes a byte suffix cannot", () => {
  const { source, target } = roundTrip("\x1b[?2004h\x1b[?1049hhello")
  expect(source.mode(MODE_BRACKETED_PASTE)).toBe(true)
  expect(target.mode(MODE_BRACKETED_PASTE)).toBe(true)
})

test("the replay is the current screen, not the scrollback", () => {
  const cols = 40
  const rows = 4
  const { source, target } = roundTrip("one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix", cols, rows)
  // Six lines on a four-row screen: the first two scrolled away. A replay that
  // restored history would be a compatibility lie; the current screen is all
  // the daemon keeps (the replay terminal is created with scrollback 0).
  const visible = captureVisible(source)
  expect(visible).not.toContain("one")
  expect(visible).toContain("five")
  expect(visible).toContain("six")
  expect(captureVisible(target)).toBe(visible)
})
