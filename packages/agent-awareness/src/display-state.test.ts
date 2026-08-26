import { expect, test } from "bun:test";
import { ProcessState } from "@danielfgray/amux/process-state.ts";
import { deriveProcessDisplay } from "./display-state.ts";

const facts = (state: ProcessState, exitCode: number | null, detached: boolean) => ({
  state,
  exitCode,
  detached,
});

test("a done process with a nonzero exit derives failed", () => {
  expect(deriveProcessDisplay(facts(ProcessState.Done, 17, false))).toEqual({
    glyph: "!",
    label: "failed",
    rank: 3,
  });
});

test("a done process with a zero exit stays a clean finish", () => {
  expect(deriveProcessDisplay(facts(ProcessState.Done, 0, false))).toEqual({
    glyph: "✓",
    label: "done",
    rank: 0,
  });
});

test("a live detached process derives detached", () => {
  expect(deriveProcessDisplay(facts(ProcessState.Running, null, true))).toEqual({
    glyph: "⊘",
    label: "detached",
    rank: 2,
  });
});

test("a finished process is not detached even when its attachment was lost", () => {
  expect(deriveProcessDisplay(facts(ProcessState.Done, 0, true))).toEqual({
    glyph: "✓",
    label: "done",
    rank: 0,
  });
});

test("a blocked process keeps its neutral glyph, which outranks the others", () => {
  expect(deriveProcessDisplay(facts(ProcessState.Blocked, null, false))).toEqual({
    glyph: "●",
    label: "blocked",
    rank: 4,
  });
});
