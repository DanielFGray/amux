import { expect, test } from "bun:test";
import { Option, Result } from "effect";
import {
  applyEdit,
  applyEdits,
  byteLength,
  charCount,
  fromText,
  lineAt,
  lineCount,
  replaceLines,
  sliceLines,
  toText,
} from "./buffer.ts";
import { OpenDocumentStore } from "./store.ts";
import * as Tree from "./sumtree.ts";
import { TextSummary } from "./text-summary.ts";

test("fromText / toText round-trip keeps a trailing newline convention", () => {
  expect(toText(fromText("a\nb\n"))).toBe("a\nb\n");
  expect(toText(fromText(""))).toBe("");
  expect(lineCount(fromText(""))).toBe(1);
  expect(Option.getOrThrow(lineAt(fromText(""), 0))).toBe("");
});

test("byteLength is UTF-8 and charCount is UTF-16, both O(1)", () => {
  expect(byteLength(fromText(""))).toBe(0);
  expect(charCount(fromText(""))).toBe(0);
  expect(byteLength(fromText("a\nb\n"))).toBe(Buffer.byteLength("a\nb\n", "utf8"));
  expect(charCount(fromText("a\nb\n"))).toBe("a\nb\n".length);
  const multi = fromText("é\n"); // U+00E9 → 2 UTF-8 bytes, 1 UTF-16 unit + newline
  expect(charCount(multi)).toBe("é\n".length);
  expect(byteLength(multi)).toBe(Buffer.byteLength("é\n", "utf8"));
  expect(byteLength(multi)).toBeGreaterThan(charCount(multi));
});

test("replaceLines splices via rope split without losing neighbors", () => {
  const doc = fromText("a\nb\nc\nd\n");
  const next = replaceLines(doc, 1, 3, ["B", "C"]);
  expect(toText(next)).toBe("a\nB\nC\nd\n");
  expect(lineCount(next)).toBe(4);
  expect(charCount(next)).toBe("a\nB\nC\nd\n".length);
});

test("applyEdit inserts across lines", () => {
  const doc = fromText("hello\nworld\n");
  const next = applyEdit(doc, {
    range: { start: { line: 0, character: 5 }, end: { line: 1, character: 0 } },
    newText: ",\nW",
  });
  expect(toText(next)).toBe("hello,\nWworld\n");
});

test("applyEdits rejects overlaps and applies high-to-low", () => {
  const doc = fromText("abcd\n");
  const ok = applyEdits(doc, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "A" },
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } }, newText: "C" },
  ]);
  expect(Result.isSuccess(ok)).toBe(true);
  if (Result.isSuccess(ok)) expect(toText(ok.success)).toBe("AbCd\n");

  const bad = applyEdits(doc, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "X" },
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: "Y" },
  ]);
  expect(Result.isFailure(bad)).toBe(true);
});

test("sliceLines returns a viewport without materializing the whole file", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `L${i}`);
  const doc = fromText(`${lines.join("\n")}\n`);
  expect(sliceLines(doc, 10, 13)).toEqual(["L10", "L11", "L12"]);
});

test("chunks stay within MAX_CHUNK_BYTES and TREE_BASE fanout holds", () => {
  const text = "x".repeat(10_000) + "\n";
  const tree = Tree.fromString(text);
  const chunks = Tree.chunkString(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(Tree.MAX_CHUNK_BYTES);
  }
  expect(Tree.toString(tree)).toBe(text);
  expect(tree.summary).toEqual(TextSummary.of(text));
  expect(Tree.isBalanced(tree)).toBe(true);
});

test("splitAtChars never tears surrogate pairs and concat stays balanced", () => {
  const emoji = "x👍y\n";
  const tree = Tree.fromString(emoji);
  for (let i = 0; i <= tree.summary.chars; i++) {
    const [left, right] = Tree.splitAtChars(tree, i);
    expect(Tree.toString(Tree.concat(left, right))).toBe(emoji);
    expect(Tree.isBalanced(left)).toBe(true);
    expect(Tree.isBalanced(right)).toBe(true);
    const leftText = Tree.toString(left);
    const rightText = Tree.toString(right);
    // No lone surrogates at the cut.
    if (leftText.length > 0) {
      const last = leftText.charCodeAt(leftText.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    if (rightText.length > 0) {
      const first = rightText.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
  }
  expect(Tree.clampCharBoundary("👍", 1)).toBe(0);
});

test('clearing a file collapses to the same empty as fromText("")', () => {
  const cleared = applyEdit(fromText("hello\n"), {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    newText: "",
  });
  expect(toText(cleared)).toBe("");
  expect(lineCount(cleared)).toBe(1);
  expect(byteLength(cleared)).toBe(0);
  expect(toText(cleared)).toBe(toText(fromText("")));
  expect(toText(replaceLines(fromText("a\nb\n"), 0, 2, []))).toBe("");
});

test("repeated mid-file replaces keep a balanced B+ tree", () => {
  let doc = fromText(`${Array.from({ length: 2_000 }, (_, i) => `line-${i}`).join("\n")}\n`);
  for (let i = 0; i < 50; i++) {
    doc = replaceLines(doc, 1_000, 1_000, [`INSERT-${i}`]);
  }
  expect(Tree.isBalanced(doc)).toBe(true);
  expect(lineCount(doc)).toBe(2_050);
});

test("splitAtChars + concat round-trips", () => {
  const text = Array.from({ length: 500 }, (_, i) => `L${i}`).join("\n") + "\n";
  const tree = Tree.fromString(text);
  const [left, right] = Tree.splitAtChars(tree, 400);
  expect(Tree.charCount(left) + Tree.charCount(right)).toBe(tree.summary.chars);
  expect(Tree.toString(Tree.concat(left, right))).toBe(text);
  expect(Tree.isBalanced(Tree.concat(left, right))).toBe(true);
});

test("OpenDocumentStore sequences apply and rejects stale generations", () => {
  const store = new OpenDocumentStore();
  const meta = store.open("file:///x.ts", "const x = 1\n");
  expect(meta.generation).toBe(1);
  expect(meta.dirty).toBe(false);
  expect(meta.byteLength).toBe(Buffer.byteLength("const x = 1\n", "utf8"));
  expect(meta.charCount).toBe("const x = 1\n".length);

  const first = store.apply("file:///x.ts", 1, [
    {
      range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } },
      newText: "2",
    },
  ]);
  expect(Result.isSuccess(first)).toBe(true);
  if (Result.isSuccess(first)) {
    expect(first.success.generation).toBe(2);
    expect(first.success.dirty).toBe(true);
    expect(first.success.charCount).toBe("const x = 2\n".length);
  }

  const stale = store.apply("file:///x.ts", 1, [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      newText: "let",
    },
  ]);
  expect(Result.isFailure(stale)).toBe(true);

  const snap = Option.getOrThrow(store.snapshot("file:///x.ts"));
  expect(snap.text).toBe("const x = 2\n");
});

test("OpenDocumentStore subscribe emits on open/write/save, not on re-open", () => {
  const store = new OpenDocumentStore();
  const seen: number[] = [];
  const unsub = store.subscribe((snap) => seen.push(snap.generation));
  store.open("file:///watch.ts", "a\n");
  expect(seen).toEqual([1]);
  store.open("file:///watch.ts");
  expect(seen).toEqual([1]);
  store.write("file:///watch.ts", 1, "b\n");
  expect(seen).toEqual([1, 2]);
  store.markSaved("file:///watch.ts");
  expect(seen.at(-1)).toBe(2);
  expect(Option.getOrThrow(store.snapshot("file:///watch.ts")).dirty).toBe(false);
  unsub();
  store.write("file:///watch.ts", 2, "c\n");
  expect(seen).toEqual([1, 2, 2]);
});

test("human and agent contend on one store: second writer rebases", () => {
  const store = new OpenDocumentStore();
  store.open("file:///race.ts", "one\n");
  const human = store.apply("file:///race.ts", 1, [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      newText: "human",
    },
  ]);
  expect(Result.isSuccess(human)).toBe(true);

  const agent = store.apply("file:///race.ts", 1, [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      newText: "agent",
    },
  ]);
  expect(Result.isFailure(agent)).toBe(true);

  const retry = store.apply("file:///race.ts", 2, [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      newText: "agent",
    },
  ]);
  expect(Result.isSuccess(retry)).toBe(true);
  expect(Option.getOrThrow(store.snapshot("file:///race.ts")).text).toBe("agent\n");
});

test("close refuses dirty on last ref unless forced; shared opens keep the doc alive", () => {
  const store = new OpenDocumentStore();
  store.open("file:///shared.ts", "x\n");
  store.open("file:///shared.ts");
  store.write("file:///shared.ts", 1, "y\n");
  expect(Result.isSuccess(store.close("file:///shared.ts"))).toBe(true);
  expect(Option.isSome(store.meta("file:///shared.ts"))).toBe(true);
  expect(Result.isFailure(store.close("file:///shared.ts"))).toBe(true);
  expect(Result.isSuccess(store.close("file:///shared.ts", { force: true }))).toBe(true);
  expect(Option.isNone(store.meta("file:///shared.ts"))).toBe(true);
});

test("mid-file insert on 50k lines stays under a loose latency budget", () => {
  const lines = Array.from({ length: 50_000 }, (_, i) => `line-${i}`);
  let doc = fromText(`${lines.join("\n")}\n`);
  const start = performance.now();
  for (let i = 0; i < 200; i++) {
    doc = replaceLines(doc, 25_000, 25_000, [`insert-${i}`]);
  }
  const ms = performance.now() - start;
  expect(lineCount(doc)).toBe(50_200);
  // Rebuild-on-concat is O(chunks) per edit; keep a loose ceiling.
  expect(ms).toBeLessThan(5_000);
  expect(Tree.isBalanced(doc)).toBe(true);
});
