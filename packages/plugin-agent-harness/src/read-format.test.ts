import { expect, test } from "bun:test";
import {
  SUMMARIZE_CHAR_THRESHOLD,
  SUMMARIZE_LINE_THRESHOLD,
  formatFileRead,
  numberLines,
} from "./read-format.ts";

test("formatFileRead returns verbatim for small files and for any offset/limit slice", () => {
  const small = ["a", "b", "c"];
  expect(formatFileRead(small, {})).toBe(numberLines(small, 1));
  expect(formatFileRead(small, { offset: 2, limit: 1 })).toBe("2: b");

  const large = Array.from({ length: SUMMARIZE_LINE_THRESHOLD + 1 }, (_, i) => `line-${i + 1}`);
  expect(formatFileRead(large, { offset: 10, limit: 2 })).toBe("10: line-10\n11: line-11");
});

test("formatFileRead outlines large unconstrained files and points at offset/limit", () => {
  const lines = Array.from({ length: SUMMARIZE_LINE_THRESHOLD + 20 }, (_, i) => {
    if (i === 5) return "export function foo() {}";
    return `body-${i + 1}`;
  });
  const out = formatFileRead(lines, {});
  expect(out).toContain(`${lines.length} lines`);
  expect(out).toContain("offset=");
  expect(out).toContain("--- head ---");
  expect(out).toContain("--- tail ---");
  expect(out).toContain("structure");
  expect(out).toContain("export function foo()");
  expect(out).not.toContain("body-70");
});

test("formatFileRead also summarizes by character budget", () => {
  const longLine = "x".repeat(SUMMARIZE_CHAR_THRESHOLD + 1);
  const out = formatFileRead([longLine], {});
  expect(out).toContain("outline");
  expect(out).toContain("offset/limit");
  expect(out.length).toBeLessThan(longLine.length);
});
