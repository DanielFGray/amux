import { describe, expect, test } from "bun:test";
import { pathFromUnifiedDiff, splitUnifiedDiffs, stripUnifiedDiffs } from "./diff-view.ts";
import { conciseDiff } from "./edit-core.ts";

describe("diff-view", () => {
  test("splitUnifiedDiffs finds each ---/+++ patch", () => {
    const a = conciseDiff("a.ts", "one\n", "two\n");
    const b = conciseDiff("b.ts", "x\n", "y\n");
    expect(splitUnifiedDiffs(`${a}\n\n${b}`)).toEqual([a, b]);
  });

  test("stripUnifiedDiffs keeps the prose summary", () => {
    const diff = conciseDiff("a.ts", "old\n", "new\n");
    const text = `Successfully replaced 1 block(s) in a.ts.\n\n${diff}`;
    expect(stripUnifiedDiffs(text)).toBe("Successfully replaced 1 block(s) in a.ts.");
  });

  test("pathFromUnifiedDiff reads the +++ header", () => {
    const diff = conciseDiff("src/foo.ts", "a\n", "b\n");
    expect(pathFromUnifiedDiff(diff)).toBe("src/foo.ts");
  });
});
