import { expect, test } from "bun:test";
import { Result } from "effect";
import { applyExactEdits, conciseDiff, splitBom } from "./edit-core.ts";
import { applyUpdateChunks, parsePatch, planPatch } from "./apply-patch.ts";

test("applyExactEdits replaces a unique span and preserves BOM + CRLF", () => {
  const raw = "\uFEFFhello\r\nworld\r\n";
  const applied = applyExactEdits(raw, "x.ts", [{ oldText: "world", newText: "amux" }]);
  expect(Result.isSuccess(applied)).toBe(true);
  if (Result.isSuccess(applied)) {
    expect(applied.success.text).toBe("\uFEFFhello\r\namux\r\n");
    expect(applied.success.diff).toContain("-world");
    expect(applied.success.diff).toContain("+amux");
  }
});

test("applyExactEdits rejects missing, ambiguous, and overlapping edits with actionable messages", () => {
  const raw = "aaa bbb aaa\nccc\n";
  const missing = applyExactEdits(raw, "x.ts", [{ oldText: "zzz", newText: "y" }]);
  expect(Result.isFailure(missing)).toBe(true);
  if (Result.isFailure(missing)) {
    expect(missing.failure.message).toContain("could not find");
    expect(missing.failure.message).toContain("Nearby context");
    expect(missing.failure.message).toContain("Re-read");
  }

  const ambiguous = applyExactEdits(raw, "x.ts", [{ oldText: "aaa", newText: "A" }]);
  expect(Result.isFailure(ambiguous)).toBe(true);
  if (Result.isFailure(ambiguous)) {
    expect(ambiguous.failure.message).toContain("matched 2 times");
    expect(ambiguous.failure.message).toContain("lines 1, 1");
  }

  const overlap = applyExactEdits(raw, "x.ts", [
    { oldText: "aaa bbb", newText: "X" },
    { oldText: "bbb aaa", newText: "Y" },
  ]);
  expect(Result.isFailure(overlap)).toBe(true);
  if (Result.isFailure(overlap)) {
    expect(overlap.failure.message).toContain("edits[0]");
    expect(overlap.failure.message).toContain("edits[1]");
    expect(overlap.failure.message).toContain("overlap");
  }
});

test("applyExactEdits applies multiple disjoint edits against the original", () => {
  const raw = "one two three\n";
  const applied = applyExactEdits(raw, "x.ts", [
    { oldText: "one", newText: "1" },
    { oldText: "three", newText: "3" },
  ]);
  expect(Result.isSuccess(applied)).toBe(true);
  if (Result.isSuccess(applied)) expect(applied.success.text).toBe("1 two 3\n");
});

test("splitBom and conciseDiff helpers", () => {
  expect(splitBom("\uFEFFx").bom).toBe("\uFEFF");
  expect(conciseDiff("a.ts", "a\nb\n", "a\nc\n")).toContain("-b");
});

test("parsePatch + planPatch validate add/update/delete before mutation", () => {
  const patch = `*** Begin Patch
*** Add File: new.ts
+export const x = 1
*** Update File: old.ts
@@
-const y = 1
+const y = 2
*** Delete File: gone.ts
*** End Patch
`;
  const hunks = parsePatch(patch);
  expect(Result.isSuccess(hunks)).toBe(true);
  if (!Result.isSuccess(hunks)) return;

  const files = new Map<string, string | undefined>([
    ["old.ts", "const y = 1\n"],
    ["gone.ts", "bye\n"],
  ]);
  const planned = planPatch(hunks.success, files);
  expect(Result.isSuccess(planned)).toBe(true);
  if (!Result.isSuccess(planned)) return;
  expect(planned.success.map((c) => c.type)).toEqual(["add", "update", "delete"]);

  const stale = planPatch(hunks.success, new Map([["old.ts", "const y = 9\n"]]));
  expect(Result.isFailure(stale)).toBe(true);
  if (Result.isFailure(stale)) {
    expect(stale.failure.message).toContain("failed to find expected lines");
    expect(stale.failure.message).toContain("Nearby:");
    expect(stale.failure.message).toContain("Re-read");
  }
});

test("applyUpdateChunks supports Move-style updates via content rewrite", () => {
  const next = applyUpdateChunks("a.ts", "hello\n", [
    { oldLines: ["hello"], newLines: ["hello", "world"] },
  ]);
  expect(Result.isSuccess(next)).toBe(true);
  if (Result.isSuccess(next)) expect(next.success).toBe("hello\nworld\n");
});

test("empty patch is rejected", () => {
  expect(Result.isFailure(parsePatch("*** Begin Patch\n*** End Patch\n"))).toBe(true);
});

test("planPatch supports Move to: and rejects a stale update without mutating the plan", () => {
  const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@
-const y = 1
+const y = 2
*** End Patch
`;
  const hunks = parsePatch(patch);
  expect(Result.isSuccess(hunks)).toBe(true);
  if (!Result.isSuccess(hunks)) return;
  expect(hunks.success[0]).toMatchObject({ type: "update", path: "old.ts", movePath: "new.ts" });

  const ok = planPatch(hunks.success, new Map([["old.ts", "const y = 1\n"]]));
  expect(Result.isSuccess(ok)).toBe(true);
  if (Result.isSuccess(ok)) {
    expect(ok.success[0]).toMatchObject({
      type: "update",
      path: "old.ts",
      movePath: "new.ts",
      content: "const y = 2\n",
    });
  }

  const stale = planPatch(hunks.success, new Map([["old.ts", "const y = 9\n"]]));
  expect(Result.isFailure(stale)).toBe(true);
});
