import { test, expect } from "bun:test"
import { Terminal } from "./ghostty.ts"
import {
  captureRows,
  captureVisible,
  captureScrollback,
  captureRowsAround,
  captureSpan,
  pickCaptureTarget,
  visibleRows,
  scrollbackRows,
} from "./capture.ts"

function term(cols = 40, rows = 10): Terminal {
  return new Terminal(cols, rows, 1000)
}

test("an empty terminal captures as empty text", () => {
  const t = term()
  expect(captureVisible(t)).toBe("")
  expect(captureScrollback(t)).toBe("")
})

test("a single line captures without a trailing newline", () => {
  const t = term()
  t.write(new TextEncoder().encode("hello"))
  expect(captureVisible(t)).toBe("hello")
})

test("multiple lines are joined with newlines", () => {
  const t = term()
  t.write(new TextEncoder().encode("a\r\nb\r\nc"))
  expect(captureVisible(t)).toBe("a\nb\nc")
})

test("trailing blank rows are trimmed", () => {
  const t = term()
  // Two blank rows follow the content; only the content survives.
  t.write(new TextEncoder().encode("a\r\nb\r\n\r\n\r\n"))
  expect(captureVisible(t)).toBe("a\nb")
})

test("interior blank rows are preserved", () => {
  const t = term()
  t.write(new TextEncoder().encode("a\r\n\r\n\r\nb"))
  expect(captureVisible(t)).toBe("a\n\n\nb")
})

test("trailing whitespace is trimmed but leading is kept", () => {
  const t = term()
  t.write(new TextEncoder().encode("  a  \r\nb"))
  expect(captureVisible(t)).toBe("  a\nb")
})

test("soft-wrapped rows stay split unless unwrapped", () => {
  const t = term(10, 5)
  t.write(new TextEncoder().encode("A".repeat(23)))
  // 10 cols -> three wrapped rows.
  expect(captureVisible(t)).toBe("AAAAAAAAAA\nAAAAAAAAAA\nAAA")
})

test("wide characters survive as their own graphemes", () => {
  const t = term()
  t.write(new TextEncoder().encode("\u30a2\u30a2\u3042x"))
  expect(captureVisible(t)).toBe("\u30a2\u30a2\u3042x")
})

test("scrolled-out rows are reachable through the scrollback space", () => {
  const t = term(10, 4)
  const lines = ["l0", "l1", "l2", "l3", "l4", "l5", "l6"]
  t.write(new TextEncoder().encode(lines.join("\r\n")))
  const sb = t.scrollbar
  expect(sb.total).toBe(7)
  // The oldest rows are gone from the screen but still captured.
  expect(captureScrollback(t)).toBe(lines.join("\n"))
  expect(captureVisible(t)).toBe("l3\nl4\nl5\nl6")
  // A slice of history alone.
  expect(captureRows(t, { start: 1, end: 2 })).toBe("l1\nl2")
})

test("captureRowsAround extends the visible range like tmux -S/-E", () => {
  const t = term(10, 4)
  const lines = ["l0", "l1", "l2", "l3", "l4", "l5", "l6"]
  t.write(new TextEncoder().encode(lines.join("\r\n")))
  // Viewport sits on l3..l6; -S 2 pulls l1/l2 in.
  expect(captureRowsAround(t, 2, 0)).toBe("l1\nl2\nl3\nl4\nl5\nl6")
  // Requesting more history than exists clamps to the top.
  expect(captureRowsAround(t, 100, 0)).toBe(lines.join("\n"))
})

test("out-of-range rows are clamped, not errors", () => {
  const t = term()
  t.write(new TextEncoder().encode("a"))
  expect(captureRows(t, { start: -5, end: -1 })).toBe("")
  expect(captureRows(t, { start: 0, end: 999 })).toBe("a")
  expect(captureRows(t, { start: 5, end: 10 })).toBe("")
})

test("visibleRows and scrollbackRows describe the scrollbar space", () => {
  const t = term(10, 4)
  t.write(new TextEncoder().encode("l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6"))
  expect(scrollbackRows(t)).toEqual({ start: 0, end: 6 })
  expect(visibleRows(t)).toEqual({ start: 3, end: 6 })
  expect(captureRows(t, visibleRows(t))).toBe(captureVisible(t))
  expect(captureRows(t, scrollbackRows(t))).toBe(captureScrollback(t))
})

test("detached-style capture does not move the viewport", () => {
  const t = term(10, 4)
  t.write(new TextEncoder().encode("l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6"))
  const before = t.scrollbar
  captureScrollback(t)
  captureVisible(t)
  expect(t.scrollbar).toEqual(before)
})

test("captureSpan maps the two named spans onto visible and scrollback", () => {
  const t = term(10, 4)
  t.write(new TextEncoder().encode("l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6"))
  expect(captureSpan(t, "visible")).toBe(captureVisible(t))
  expect(captureSpan(t, "scrollback")).toBe(captureScrollback(t))
  expect(captureSpan(t, "scrollback")).toBe("l0\nl1\nl2\nl3\nl4\nl5\nl6")
})

test("pickCaptureTarget prefers the focused pane over the selected agent", () => {
  const focused = { term: term(), describe: () => "focused" }
  const selected = { term: term(), describe: () => "selected" }
  expect(pickCaptureTarget(focused, selected)).toBe(focused)
})

test("pickCaptureTarget falls back to the selected agent", () => {
  const selected = { term: term(), describe: () => "selected" }
  expect(pickCaptureTarget(null, selected)).toBe(selected)
})

test("pickCaptureTarget reports an explicit miss", () => {
  expect(pickCaptureTarget(null, null)).toBeNull()
})

test("a selected agent is captured without a viewport and without moving it", () => {
  const t = term(10, 4)
  t.write(new TextEncoder().encode("l0\r\nl1\r\nl2\r\nl3"))
  const target = pickCaptureTarget(null, { term: t, describe: () => "detached" })
  expect(target).not.toBeNull()
  const before = t.scrollbar
  // No pane is mounted anywhere — the terminal alone is the target, exactly
  // the detached-agent case — and capturing it leaves it where it sat.
  expect(captureVisible(target!.term)).toBe("l0\nl1\nl2\nl3")
  expect(captureScrollback(target!.term)).toBe("l0\nl1\nl2\nl3")
  expect(target!.term.scrollbar).toEqual(before)
})
