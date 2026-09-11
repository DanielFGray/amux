/**
 * B+ SumTree of text chunks.
 *
 * Cite: Zed `sum_tree` (TREE_BASE fanout, leaf items + child summaries) and
 * Zed rope chunks (`CHUNK_BASE`, max `2 * CHUNK_BASE` UTF-8 bytes per leaf item).
 * Seek dimensions are UTF-16 chars and newline count via {@link TextSummary}.
 *
 * Invariants:
 * - Blank storage (`""` / only newlines) collapses to {@link empty} via {@link normalize}.
 * - Char splits never tear UTF-16 surrogate pairs (left-biased {@link clampCharBoundary}).
 * - Every node stores `height`; Internal children always share that height − 1.
 */
import { Option } from "effect";
import { TextSummary, lineCountOf } from "./text-summary.ts";

/** Zed release `CHUNK_BASE` — leaf item target size in UTF-8 bytes. */
export const CHUNK_BASE = 64;
export const MAX_CHUNK_BYTES = 2 * CHUNK_BASE;

/** Zed-style branching factor; nodes hold at most `2 * TREE_BASE` children/items. */
export const TREE_BASE = 16;
export const MAX_NODE = 2 * TREE_BASE;

type Leaf = {
  readonly _tag: "Leaf";
  readonly items: readonly string[];
  readonly itemSummaries: readonly TextSummary[];
  readonly summary: TextSummary;
  readonly height: 0;
};

type Internal = {
  readonly _tag: "Internal";
  readonly children: readonly SumTree[];
  readonly childSummaries: readonly TextSummary[];
  readonly summary: TextSummary;
  readonly height: number;
};

export type SumTree = Leaf | Internal;

const emptyLeaf: Leaf = {
  _tag: "Leaf",
  items: [],
  itemSummaries: [],
  summary: TextSummary.zero,
  height: 0,
};

export const empty = (): SumTree => emptyLeaf;

export const isEmpty = (tree: SumTree): boolean => tree.summary.bytes === 0;

export const summaryOf = (tree: SumTree): TextSummary => tree.summary;

export const charCount = (tree: SumTree): number => tree.summary.chars;

export const byteCount = (tree: SumTree): number => tree.summary.bytes;

export const lineCount = (tree: SumTree): number => lineCountOf(tree.summary);

const leafOf = (items: readonly string[], itemSummaries: readonly TextSummary[]): Leaf => ({
  _tag: "Leaf",
  items,
  itemSummaries,
  summary: TextSummary.addAll(itemSummaries),
  height: 0,
});

const internalOf = (
  children: readonly SumTree[],
  childSummaries: readonly TextSummary[],
): SumTree => {
  if (children.length === 0) return empty();
  if (children.length === 1) return children[0]!;
  const childHeight = children[0]!.height;
  return {
    _tag: "Internal",
    children,
    childSummaries,
    summary: TextSummary.addAll(childSummaries),
    height: childHeight + 1,
  };
};

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Snap a UTF-16 index to a code-point boundary. Left bias: if `index` sits on
 * a low surrogate, move before its high pair so both halves stay together on
 * the right of a split.
 */
export const clampCharBoundary = (text: string, index: number): number => {
  const at = Math.max(0, Math.min(index, text.length));
  if (
    at > 0 &&
    at < text.length &&
    isLowSurrogate(text.charCodeAt(at)) &&
    isHighSurrogate(text.charCodeAt(at - 1))
  ) {
    return at - 1;
  }
  return at;
};

/** Split `text` into UTF-8-sized chunks on code-point boundaries. */
export const chunkString = (text: string, maxBytes = MAX_CHUNK_BYTES): string[] => {
  if (text.length === 0) return [];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
      const cp = text.codePointAt(end)!;
      const width = cp > 0xffff ? 2 : 1;
      const cpBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      if (bytes > 0 && bytes + cpBytes > maxBytes) break;
      bytes += cpBytes;
      end += width;
      if (bytes >= maxBytes) break;
    }
    if (end === start) {
      const cp = text.codePointAt(start)!;
      end = start + (cp > 0xffff ? 2 : 1);
    }
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
};

const coalesceChunks = (chunks: readonly string[]): string[] => {
  if (chunks.length === 0) return [];
  const out: string[] = [];
  let acc = chunks[0]!;
  let accBytes = Buffer.byteLength(acc, "utf8");
  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i]!;
    const nextBytes = Buffer.byteLength(next, "utf8");
    if (accBytes + nextBytes <= MAX_CHUNK_BYTES) {
      acc += next;
      accBytes += nextBytes;
    } else {
      out.push(acc);
      acc = next;
      accBytes = nextBytes;
    }
  }
  out.push(acc);
  return out;
};

/** Build a balanced tree from already-sized chunks. */
export const fromChunks = (chunks: readonly string[]): SumTree => {
  if (chunks.length === 0) return empty();
  let nodes: SumTree[] = chunks.map((chunk) => leafOf([chunk], [TextSummary.of(chunk)]));
  while (nodes.length > 1) {
    const next: SumTree[] = [];
    for (let i = 0; i < nodes.length; i += MAX_NODE) {
      const group = nodes.slice(i, i + MAX_NODE);
      next.push(
        internalOf(
          group,
          group.map((child) => child.summary),
        ),
      );
    }
    nodes = next;
  }
  return nodes[0]!;
};

/** Build a rope from exact storage bytes (no blank canonicalization). */
export const fromString = (text: string): SumTree => {
  if (text.length === 0) return empty();
  return fromChunks(chunkString(text));
};

export const toString = (tree: SumTree): string => {
  if (isEmpty(tree)) return "";
  const parts: string[] = [];
  collectChunks(tree, parts);
  return parts.join("");
};

const collectChunks = (tree: SumTree, out: string[]): void => {
  if (tree._tag === "Leaf") {
    for (const item of tree.items) out.push(item);
    return;
  }
  for (const child of tree.children) collectChunks(child, out);
};

/**
 * Collapse blank storage to {@link empty}, and ensure a single trailing `\n`
 * when non-empty — matches buffer `fromText` / `toText`.
 */
export const normalize = (tree: SumTree): SumTree => {
  if (isEmpty(tree)) return empty();
  const text = toString(tree);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.length === 0) return empty();
  const stored = `${body}\n`;
  return text === stored ? tree : fromChunks(chunkString(stored));
};

/**
 * Concat by coalescing chunks and rebuilding a balanced B+ tree.
 * O(chunk count). Structural spine concat was abandoned — it could recurse
 * forever once post-split heights diverged; {@link fromChunks} is the trusted constructor.
 */
export const concat = (left: SumTree, right: SumTree): SumTree => {
  if (isEmpty(left)) return right;
  if (isEmpty(right)) return left;
  const chunks: string[] = [];
  collectChunks(left, chunks);
  collectChunks(right, chunks);
  return fromChunks(coalesceChunks(chunks));
};

/** True when every Internal node's children share one height. */
export const isBalanced = (tree: SumTree): boolean => {
  const walk = (node: SumTree): boolean => {
    if (node._tag === "Leaf") return true;
    const expected = node.height - 1;
    for (const child of node.children) {
      if (child.height !== expected || !walk(child)) return false;
    }
    return true;
  };
  return walk(tree);
};

/** Split so the left tree contains `chars` UTF-16 units, snapped to a code-point boundary. */
export const splitAtChars = (tree: SumTree, chars: number): readonly [SumTree, SumTree] => {
  const at = Math.max(0, Math.min(chars, tree.summary.chars));
  if (at === 0) return [empty(), tree];
  if (at === tree.summary.chars) return [tree, empty()];
  return splitExactChars(tree, at);
};

const nodeFromChildren = (
  children: readonly SumTree[],
  summaries: readonly TextSummary[],
): SumTree => {
  if (children.length === 0) return empty();
  if (children.length === 1) return children[0]!;
  const expected = children[0]!.height;
  if (children.every((child) => child.height === expected)) {
    return internalOf(children, summaries);
  }
  const chunks: string[] = [];
  for (const child of children) collectChunks(child, chunks);
  return fromChunks(coalesceChunks(chunks));
};

const splitExactChars = (tree: SumTree, chars: number): readonly [SumTree, SumTree] => {
  if (tree._tag === "Leaf") {
    let remaining = chars;
    const leftItems: string[] = [];
    const leftSummaries: TextSummary[] = [];
    const rightItems: string[] = [];
    const rightSummaries: TextSummary[] = [];
    let side: "left" | "right" = "left";
    for (let i = 0; i < tree.items.length; i++) {
      const item = tree.items[i]!;
      const summary = tree.itemSummaries[i]!;
      if (side === "right") {
        rightItems.push(item);
        rightSummaries.push(summary);
        continue;
      }
      if (remaining >= summary.chars) {
        leftItems.push(item);
        leftSummaries.push(summary);
        remaining -= summary.chars;
        if (remaining === 0) side = "right";
        continue;
      }
      const cut = clampCharBoundary(item, remaining);
      if (cut > 0) {
        const leftPart = item.slice(0, cut);
        leftItems.push(leftPart);
        leftSummaries.push(TextSummary.of(leftPart));
      }
      if (cut < item.length) {
        const rightPart = item.slice(cut);
        rightItems.push(rightPart);
        rightSummaries.push(TextSummary.of(rightPart));
      }
      side = "right";
      remaining = 0;
    }
    return [
      leftItems.length === 0 ? empty() : leafOf(leftItems, leftSummaries),
      rightItems.length === 0 ? empty() : leafOf(rightItems, rightSummaries),
    ];
  }

  let remaining = chars;
  const leftChildren: SumTree[] = [];
  const leftSummaries: TextSummary[] = [];
  const rightChildren: SumTree[] = [];
  const rightSummaries: TextSummary[] = [];
  let side: "left" | "right" = "left";
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i]!;
    const summary = tree.childSummaries[i]!;
    if (side === "right") {
      rightChildren.push(child);
      rightSummaries.push(summary);
      continue;
    }
    if (remaining >= summary.chars) {
      leftChildren.push(child);
      leftSummaries.push(summary);
      remaining -= summary.chars;
      if (remaining === 0) side = "right";
      continue;
    }
    const [l, r] = splitExactChars(child, remaining);
    if (!isEmpty(l)) {
      leftChildren.push(l);
      leftSummaries.push(l.summary);
    }
    if (!isEmpty(r)) {
      rightChildren.push(r);
      rightSummaries.push(r.summary);
    }
    side = "right";
    remaining = 0;
  }
  return [
    nodeFromChildren(leftChildren, leftSummaries),
    nodeFromChildren(rightChildren, rightSummaries),
  ];
};

export const sliceChars = (tree: SumTree, start: number, end: number): string => {
  const lo = Math.max(0, start);
  const hi = Math.max(lo, Math.min(end, tree.summary.chars));
  if (lo >= hi) return "";
  const [, rest] = splitAtChars(tree, lo);
  const [mid] = splitAtChars(rest, hi - lo);
  return toString(mid);
};

/**
 * UTF-16 offset of the start of `line` (0-based). For an empty rope, line 0 is 0.
 * Non-empty stored docs end with `\n`, so line N starts after N newlines.
 */
export const charOffsetOfLine = (tree: SumTree, line: number): number => {
  if (isEmpty(tree) || line <= 0) return 0;
  const target = Math.min(line, tree.summary.newlines);
  return offsetAfterNewlines(tree, target);
};

const offsetAfterNewlines = (tree: SumTree, newlines: number): number => {
  if (newlines <= 0) return 0;
  if (tree._tag === "Leaf") {
    let seen = 0;
    let chars = 0;
    for (let i = 0; i < tree.items.length; i++) {
      const item = tree.items[i]!;
      const summary = tree.itemSummaries[i]!;
      if (seen + summary.newlines < newlines) {
        seen += summary.newlines;
        chars += summary.chars;
        continue;
      }
      for (let j = 0; j < item.length; j++) {
        chars += 1;
        if (item.charCodeAt(j) === 10) {
          seen += 1;
          if (seen === newlines) return chars;
        }
      }
    }
    return chars;
  }
  let seen = 0;
  let chars = 0;
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i]!;
    const summary = tree.childSummaries[i]!;
    if (seen + summary.newlines < newlines) {
      seen += summary.newlines;
      chars += summary.chars;
      continue;
    }
    return chars + offsetAfterNewlines(child, newlines - seen);
  }
  return chars;
};

export const lineAt = (tree: SumTree, row: number): Option.Option<string> => {
  const lines = lineCount(tree);
  if (row < 0 || row >= lines) return Option.none();
  if (isEmpty(tree)) return Option.some("");
  const start = charOffsetOfLine(tree, row);
  const end = charOffsetOfLine(tree, row + 1) - 1;
  return Option.some(sliceChars(tree, start, Math.max(start, end)));
};

export const sliceLines = (tree: SumTree, start: number, end: number): readonly string[] => {
  const lines = lineCount(tree);
  const lo = Math.max(0, start);
  const hi = Math.max(lo, Math.min(end, lines));
  const out: string[] = [];
  for (let row = lo; row < hi; row++) {
    out.push(Option.getOrThrow(lineAt(tree, row)));
  }
  return out;
};

/** Replace the UTF-16 range [start, end) with `text`, then canonicalize blank storage. */
export const replaceChars = (tree: SumTree, start: number, end: number, text: string): SumTree => {
  const [left, rest] = splitAtChars(tree, start);
  const [, right] = splitAtChars(rest, Math.max(0, end - start));
  const mid = text.length === 0 ? empty() : fromString(text);
  return normalize(concat(concat(left, mid), right));
};
