import type { Direction, SplitDirection } from "./window.ts";
import { makeLayout, type Layout, type LayoutNode, type LayoutSplit } from "./layout.ts";

export interface LayoutSize {
  cols: number;
  rows: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutPath = readonly number[];

const MIN_CELLS = 3;

/**
 * Compute pane rectangles in window-root coordinates without a renderer.
 *
 * Borders are drawn inside pane rectangles and consume no layout space. Every
 * adjacent pair in a split has one divider cell between it; the remaining
 * cells are divided by weight. Yoga rounds absolute boundaries, rather than
 * rounding each child's size independently, so the same cumulative rounding
 * is used here.
 */
export function computeRects(layout: Layout, size: LayoutSize): ReadonlyMap<string, Rect> {
  return geometry(layout, size).panes;
}

/** The pane tmux-style directional focus reaches, or null at an outer edge. */
export function paneInDirection(
  layout: Layout,
  size: LayoutSize,
  fromId: string,
  direction: Direction,
): string | null {
  const rects = computeRects(layout, size);
  const from = rects.get(fromId);
  if (!from || rects.size < 2) return null;
  const horizontal = direction === "left" || direction === "right";
  const backwards = direction === "left" || direction === "up";
  const start = (rect: Rect) => (horizontal ? rect.x : rect.y);
  const end = (rect: Rect) => start(rect) + (horizontal ? rect.width : rect.height);
  const crossStart = (rect: Rect) => (horizontal ? rect.y : rect.x);
  const crossEnd = (rect: Rect) => crossStart(rect) + (horizontal ? rect.height : rect.width);

  let best: string | null = null;
  let bestGap = Infinity;
  let bestOverlap = 0;
  for (const [id, rect] of rects) {
    if (id === fromId) continue;
    const gap = backwards ? start(from) - end(rect) : start(rect) - end(from);
    if (gap < 0 || gap > bestGap) continue;
    const overlap =
      Math.min(crossEnd(from), crossEnd(rect)) - Math.max(crossStart(from), crossStart(rect));
    if (overlap <= 0) continue;
    if (gap < bestGap || overlap > bestOverlap) {
      best = id;
      bestGap = gap;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** Move the divider bordering a pane in a screen direction. */
export function resizePane(
  layout: Layout,
  size: LayoutSize,
  paneId: string,
  direction: Direction,
  cells = 1,
): Layout {
  const axis: SplitDirection = direction === "left" || direction === "right" ? "row" : "column";
  const side: -1 | 1 = direction === "left" || direction === "up" ? -1 : 1;
  const path = panePath(layout.root, paneId);
  if (!path) return layout;

  for (let depth = path.length - 1; depth >= 0; depth--) {
    const splitPath = path.slice(0, depth);
    const split = nodeAt(layout.root, splitPath);
    const child = path[depth]!;
    if (split?.type !== "split" || split.direction !== axis) continue;
    if (side < 0 && child > 0) return resizeDivider(layout, size, splitPath, child - 1, -cells);
    if (side > 0 && child < split.children.length - 1) {
      return resizeDivider(layout, size, splitPath, child, cells);
    }
  }
  return layout;
}

/** Move one model divider; `index` is the child immediately before it. */
export function resizeDivider(
  layout: Layout,
  size: LayoutSize,
  path: LayoutPath,
  index: number,
  delta: number,
): Layout {
  if (delta === 0) return layout;
  const split = nodeAt(layout.root, path);
  if (split?.type !== "split" || index < 0 || index >= split.children.length - 1) return layout;

  const rects = geometry(layout, size).nodes;
  const sizes = split.children.map((child) => axisSize(rects.get(child), split.direction));
  const total = sizes[index]! + sizes[index + 1]!;
  if (total < MIN_CELLS * 2) return layout;
  const before = Math.max(MIN_CELLS, Math.min(total - MIN_CELLS, sizes[index]! + delta));
  if (before === sizes[index]) return layout;

  sizes[index] = before;
  sizes[index + 1] = total - before;
  const replacement: LayoutSplit = {
    ...split,
    // Cell sizes are proportional weights. Rewriting every sibling makes the
    // current rendered allocation the fixed point, even in a 3+ child split.
    children: split.children.map((child, at) => ({
      ...child,
      weight: Math.max(0.0001, sizes[at]!),
    })),
  };
  return makeLayout(replaceAt(layout.root, path, replacement), layout.focus);
}

export function paneHasNeighbour(
  layout: Layout,
  paneId: string,
  axis: SplitDirection,
  side: -1 | 1,
): boolean {
  const path = panePath(layout.root, paneId);
  return path ? pathHasNeighbour(layout.root, path, axis, side) : false;
}

export function dividerHasNeighbour(
  layout: Layout,
  path: LayoutPath,
  axis: SplitDirection,
  side: -1 | 1,
): boolean {
  return pathHasNeighbour(layout.root, path, axis, side);
}

export function dividerTouchesPane(
  layout: Layout,
  path: LayoutPath,
  index: number,
  paneId: string,
): boolean {
  const split = nodeAt(layout.root, path);
  return (
    split?.type === "split" &&
    (containsPane(split.children[index], paneId) || containsPane(split.children[index + 1], paneId))
  );
}

interface ExactRect extends Rect {}

function geometry(
  layout: Layout,
  size: LayoutSize,
): {
  panes: Map<string, Rect>;
  nodes: Map<LayoutNode, Rect>;
} {
  const panes = new Map<string, Rect>();
  const nodes = new Map<LayoutNode, Rect>();
  if (!layout.root) return { panes, nodes };

  const walk = (node: LayoutNode, exact: ExactRect) => {
    const rect = rounded(exact);
    nodes.set(node, rect);
    if (node.type === "pane") {
      panes.set(node.id, rect);
      return;
    }

    const horizontal = node.direction === "row";
    const length = horizontal ? exact.width : exact.height;
    const available = Math.max(0, length - (node.children.length - 1));
    const totalWeight = node.children.reduce((sum, child) => sum + child.weight, 0);
    let cursor = horizontal ? exact.x : exact.y;
    for (const child of node.children) {
      const childLength = totalWeight > 0 ? (available * child.weight) / totalWeight : 0;
      walk(
        child,
        horizontal
          ? { x: cursor, y: exact.y, width: childLength, height: exact.height }
          : { x: exact.x, y: cursor, width: exact.width, height: childLength },
      );
      cursor += childLength + 1;
    }
  };

  walk(layout.root, {
    x: 0,
    y: 0,
    width: Math.max(0, Math.floor(size.cols)),
    height: Math.max(0, Math.floor(size.rows)),
  });
  return { panes, nodes };
}

function rounded(rect: ExactRect): Rect {
  const right = Math.round(rect.x + rect.width);
  const bottom = Math.round(rect.y + rect.height);
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function axisSize(rect: Rect | undefined, axis: SplitDirection): number {
  if (!rect) return 0;
  return axis === "row" ? rect.width : rect.height;
}

function panePath(node: LayoutNode | null, paneId: string, path: number[] = []): number[] | null {
  if (!node) return null;
  if (node.type === "pane") return node.id === paneId ? path : null;
  for (let i = 0; i < node.children.length; i++) {
    const found = panePath(node.children[i]!, paneId, [...path, i]);
    if (found) return found;
  }
  return null;
}

function nodeAt(root: LayoutNode | null, path: LayoutPath): LayoutNode | null {
  let node = root;
  for (const index of path) {
    if (node?.type !== "split") return null;
    node = node.children[index] ?? null;
  }
  return node;
}

function replaceAt(
  root: LayoutNode | null,
  path: LayoutPath,
  replacement: LayoutNode,
): LayoutNode | null {
  if (path.length === 0) return replacement;
  if (root?.type !== "split") return root;
  const [index, ...rest] = path;
  return {
    ...root,
    children: root.children.map((child, at) =>
      at === index ? replaceAt(child, rest, replacement)! : child,
    ),
  };
}

function pathHasNeighbour(
  root: LayoutNode | null,
  path: LayoutPath,
  axis: SplitDirection,
  side: -1 | 1,
): boolean {
  let node = root;
  for (const index of path) {
    if (node?.type !== "split") return false;
    if (node.direction === axis && (side < 0 ? index > 0 : index < node.children.length - 1))
      return true;
    node = node.children[index] ?? null;
  }
  return false;
}

function containsPane(node: LayoutNode | undefined, paneId: string): boolean {
  if (!node) return false;
  return node.type === "pane"
    ? node.id === paneId
    : node.children.some((child) => containsPane(child, paneId));
}
