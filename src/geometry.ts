import type { Direction, SplitDirection } from "./window.ts";
import {
  layoutPanes,
  makeLayout,
  type Layout,
  type LayoutFloat,
  type LayoutNode,
  type LayoutSplit,
} from "./layout.ts";

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
 *
 * Floats are in here too, at the cells their fractions name. They overlap the
 * tiled rectangles rather than displacing them, which is what floating means
 * and why the result is a map and not a partition of the window.
 */
export function computeRects(layout: Layout, size: LayoutSize): ReadonlyMap<string, Rect> {
  return geometry(layout, size).panes;
}

/**
 * The pane tmux-style directional focus reaches, or null at an outer edge.
 *
 * The tiled plane only. "The pane to the right" is a fact about tiling — it
 * means the one across a shared edge — and a float shares an edge with nothing,
 * it covers. So directional focus neither enters the floating plane nor leaves
 * it, and from a float there is no direction to go.
 */
export function paneInDirection(
  layout: Layout,
  size: LayoutSize,
  fromId: string,
  direction: Direction,
): string | null {
  const tiled = new Set(layoutPanes(layout.root).map((pane) => pane.id));
  if (!tiled.has(fromId) || tiled.size < 2) return null;
  const rects = computeRects(layout, size);
  const from = rects.get(fromId);
  if (!from) return null;
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
    if (id === fromId || !tiled.has(id)) continue;
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

/** Resize a pane in a screen direction: a tiled pane moves the divider on
 *  that side, a float grows or shrinks its own rectangle. */
export function resizePane(
  layout: Layout,
  size: LayoutSize,
  paneId: string,
  direction: Direction,
  cells = 1,
): Layout {
  const float = layout.floats.find((float) => float.id === paneId);
  if (float) return resizeFloat(layout, float, size, direction, cells);

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
  return makeLayout({ ...layout, root: replaceAt(layout.root, path, replacement) });
}

/**
 * Move a float's origin `cells` in a screen direction.
 *
 * The gesture the plain arrows mean while a float is focused. A float covers
 * the tiled plane, so directional focus has nowhere to go from it; movement is
 * what those keys can mean instead. A tiled pane cannot move — its position is
 * derived from the tree — so this is a float's own transform, a direct edit of
 * x/y rather than a weight rewrite.
 *
 * The float never leaves the window. Movement snaps to the boundary rather
 * than stopping short of it, so the stored fractions stay flush with the edge:
 * a float parked there is still flush after a window resize, which a gap of a
 * fraction of a cell would not be.
 */
export function moveFloat(
  layout: Layout,
  size: LayoutSize,
  paneId: string,
  direction: Direction,
  cells = 1,
): Layout {
  const float = layout.floats.find((float) => float.id === paneId);
  if (!float) return layout;
  const horizontal = direction === "left" || direction === "right";
  const axis = horizontal ? size.cols : size.rows;
  if (axis <= 0) return layout;
  const step = cells / axis;
  const side: -1 | 1 = direction === "left" || direction === "up" ? -1 : 1;
  const origin = horizontal ? float.x : float.y;
  const span = horizontal ? float.width : float.height;
  const moved = origin + side * step;
  const clamped = moved < 0 ? 0 : moved + span > 1 ? 1 - span : moved;
  if (clamped === origin) return layout;
  const rect: LayoutFloat = horizontal ? { ...float, x: clamped } : { ...float, y: clamped };
  return replaceFloat(layout, rect);
}

/** Grow or shrink a float's rectangle by `cells` in a screen direction. */
function resizeFloat(
  layout: Layout,
  float: LayoutFloat,
  size: LayoutSize,
  direction: Direction,
  cells: number,
): Layout {
  const horizontal = direction === "left" || direction === "right";
  const axis = horizontal ? size.cols : size.rows;
  if (axis <= 0) return layout;
  const step = cells / axis;
  // Right and down extend the far edge; left and up shrink from the origin's
  // side, moving it over so the far edge stays put — what tmux's resize-pane
  // does to a float.
  const backwards = direction === "left" || direction === "up";
  const origin = horizontal ? float.x : float.y;
  const sizeNow = horizontal ? float.width : float.height;
  const newOrigin = backwards ? origin + step : origin;
  const newSize = sizeNow + (backwards ? -step : step);
  // The geometry rounds a rect's edges, not its size, so the minimum is the
  // cell width the float would actually render at: round the edges, the way
  // computeRects does.
  const near = Math.round(newOrigin * axis);
  const far = Math.round((newOrigin + newSize) * axis);
  if (far - near < MIN_CELLS) return layout;
  if (newOrigin + newSize > 1) return layout;
  const rect: LayoutFloat = horizontal
    ? { ...float, x: newOrigin, width: newSize }
    : { ...float, y: newOrigin, height: newSize };
  return replaceFloat(layout, rect);
}

/** Put `rect` back in the floating plane, keeping its stack position. */
function replaceFloat(layout: Layout, rect: LayoutFloat): Layout {
  return makeLayout({
    ...layout,
    floats: layout.floats.map((float) => (float.id === rect.id ? rect : float)),
  });
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
  const cols = Math.max(0, Math.floor(size.cols));
  const rows = Math.max(0, Math.floor(size.rows));

  // Same rounding as the tiled walk, and for the same reason: yoga rounds a
  // node's absolute edges, so a float placed by percentage lands where rounding
  // its own edges says it does.
  for (const float of layout.floats) {
    panes.set(
      float.id,
      rounded({
        x: float.x * cols,
        y: float.y * rows,
        width: float.width * cols,
        height: float.height * rows,
      }),
    );
  }
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

  walk(layout.root, { x: 0, y: 0, width: cols, height: rows });
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
