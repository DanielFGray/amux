/**
 * Projection substrate spike tests (ts-27d143).
 *
 * Proves: (1) two structurally different surfaces satisfy the contract,
 * (2) editor motions.ts drives both projections, (3) text-offset marks die
 * under live updates that payload pins survive (open question 4).
 */
import { expect, test } from "bun:test";
import { Option } from "effect";
import { applyMotion, wordForwardSmall, type MotionContext } from "../../../editor/src/motions.ts";
import { textInRange, type TextPoint, type TextRange } from "./contract.ts";
import { ScrollbackSurface } from "./scrollback-surface.ts";
import { TranscriptSurface } from "./transcript-surface.ts";

const motionCtx = (lines: readonly string[], cursor: TextPoint): MotionContext => ({
  lines,
  cursor,
  count: 1,
  curswant: cursor.col,
  viewport: { top: 0, height: Math.max(1, lines.length) },
});

const point = (row: number, col: number): TextPoint => ({ row, col });
const rangeAt = (p: TextPoint): TextRange => ({ anchor: p, head: p });

test("one engine: motions.ts word-forward drives scrollback and transcript projections", () => {
  const scrollback = new ScrollbackSurface("pty://spike", ["alpha beta gamma", "delta epsilon"]);
  const transcript = new TranscriptSurface("transcript://spike", [
    { kind: "user", turn: "t1", text: "alpha beta gamma" },
    { kind: "assistant", turn: "t1", text: "delta epsilon" },
  ]);

  const sb = scrollback.project(80);
  const tr = transcript.project(80);

  const sbNext = applyMotion(wordForwardSmall, motionCtx(sb.lines, point(0, 0)));
  // Start on the payload word, not the "user>" prefix — same algebra either way.
  const trStart = point(0, "user> ".length);
  const trNext = applyMotion(wordForwardSmall, motionCtx(tr.lines, trStart));

  expect(sb.lines[sbNext.to.row]!.slice(sbNext.to.col)).toMatch(/^beta/);
  expect(tr.lines[trNext.to.row]!.slice(trNext.to.col)).toMatch(/^beta/);

  const yanked = textInRange(sb, {
    anchor: point(0, 0),
    head: { row: sbNext.to.row, col: sbNext.to.col + 3 },
  });
  expect(yanked).toContain("alpha");
});

test("open question 4: pure append keeps text-row indices (not the kill case)", () => {
  const surface = new TranscriptSurface("transcript://append", [
    { kind: "user", turn: "t1", text: "hello" },
  ]);
  const width = 80;
  const before = surface.project(width);
  const mark: TextPoint = point(0, 6); // 'h' of hello — "user> hello"
  expect(before.lines[0]![mark.col]).toBe("h");

  surface.append({ kind: "assistant", turn: "t1", text: "world" });
  const after = surface.project(width);
  expect(after.lines[mark.row]![mark.col]).toBe("h");
});

test("open question 4 KILL: streaming an earlier block shifts text-rows; payload pin holds", () => {
  const surface = new TranscriptSurface("transcript://stream", [
    { kind: "user", turn: "t1", text: "hi" },
    { kind: "assistant", turn: "t1", text: "TARGET" },
  ]);
  const width = 80;
  const before = surface.project(width);
  // Second line is "assistant> TARGET" — land on T.
  const textMark = point(1, "assistant> ".length);
  expect(before.lines[1]!.slice(textMark.col)).toBe("TARGET");

  const pin = surface.pin(rangeAt(textMark), width);
  expect(pin.blockKey).toBe("assistant:t1");

  // Stream into the *earlier* block — display rows after it shift when wrap
  // grows. Use a narrow width so growth adds wrapped rows.
  const narrow = 12;
  const pinNarrow = surface.pin(rangeAt(textMark), 80);
  // Re-pin at narrow width against current (pre-stream) content.
  const atNarrow = surface.project(narrow);
  // Find TARGET under narrow wrap via locate after pinning at width 80's pin
  // (offset into block text is width-independent).
  const locatedBefore = surface.locate(pinNarrow, narrow);
  expect(Option.isSome(locatedBefore)).toBe(true);
  const textMarkNarrow = Option.getOrThrow(locatedBefore).head;
  expect(atNarrow.lines[textMarkNarrow.row]!.includes("T")).toBe(true);

  surface.stream("t1", "user", " — a long suffix that forces more wrapped rows");

  const after = surface.project(narrow);
  // Text-row mark from before the stream now points at different content.
  const stale = after.lines[textMarkNarrow.row] ?? "";
  expect(stale.includes("TARGET")).toBe(false);

  // Payload pin still resolves onto TARGET.
  const located = surface.locate(pinNarrow, narrow);
  expect(Option.isSome(located)).toBe(true);
  const live = Option.getOrThrow(located).head;
  expect(after.lines[live.row]!.slice(live.col)).toMatch(/^T/);
});

test("open question 4 KILL: reflow (width change) invalidates text-rows; pin relocates", () => {
  const surface = new TranscriptSurface("transcript://reflow", [
    { kind: "assistant", turn: "t1", text: "abcdefghijKLMNOP" },
  ]);
  const wide = surface.project(80);
  const mark = point(0, "assistant> ".length + 10); // near K
  expect(wide.lines[0]![mark.col]).toBe("K");

  const pin = surface.pin(rangeAt(mark), 80);

  const narrow = surface.project(10);
  expect(narrow.lines.length).toBeGreaterThan(1);
  // Same text-row/col is garbage after reflow.
  expect(narrow.lines[mark.row]?.[mark.col]).not.toBe("K");

  const located = surface.locate(pin, 10);
  expect(Option.isSome(located)).toBe(true);
  const live = Option.getOrThrow(located).head;
  expect(narrow.lines[live.row]![live.col]).toBe("K");
});

test("open question 4: scrollback append keeps indices; top-drop makes text-row lie and pin die cleanly", () => {
  const surface = new ScrollbackSurface("pty://ring", ["keep", "TARGET", "tail"], 100);
  const mark = point(1, 0);
  expect(surface.project(80).lines[mark.row]).toBe("TARGET");

  const pin = surface.pin(rangeAt(mark), 80);
  surface.append("newer");
  expect(surface.project(80).lines[mark.row]).toBe("TARGET");
  expect(Option.isSome(surface.locate(pin, 80))).toBe(true);

  surface.dropOldest(1); // "keep" gone; "TARGET" is now row 0
  const after = surface.project(80);
  // Text-row mark still says row 1 — that cell is now "tail", a silent lie.
  expect(after.lines[mark.row]).toBe("tail");
  expect(after.lines[mark.row]).not.toBe("TARGET");
  // Generation-scoped pin refuses rather than lying.
  expect(Option.isNone(surface.locate(pin, 80))).toBe(true);
});

test("contract: Selection is uri + opaque pin — core does not interpret pin shape", () => {
  const transcript = new TranscriptSurface("transcript://sel", [
    { kind: "user", turn: "t1", text: "x" },
  ]);
  const scrollback = new ScrollbackSurface("pty://sel", ["x"]);
  const tPin = transcript.pin(rangeAt(point(0, 0)), 80);
  const sPin = scrollback.pin(rangeAt(point(0, 0)), 80);

  // Different pin shapes, same Selection envelope.
  const tSel = { surface: transcript.uri, pin: tPin };
  const sSel = { surface: scrollback.uri, pin: sPin };
  expect(tSel.surface).toStartWith("transcript://");
  expect(sSel.surface).toStartWith("pty://");
  expect(typeof tSel.pin).toBe("object");
  expect(typeof sSel.pin).toBe("object");
});
