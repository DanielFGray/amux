/**
 * A niri-style horizontal scrolling-column tiling algorithm.
 *
 * The arrangement is a single root `LayoutContainer` (kind `"scroll"`) whose
 * plain `children` are columns, positioned along the scroll axis by an
 * opaque `NiriArrangement` blob (offset plus a size list index-aligned with
 * `children`) — this module owns that shape entirely; core's `layout.ts`
 * has no scrolling/viewport/offset concept anywhere (see
 * docs/adr/0004-arrangement-kind-is-an-open-registry.md, which superseded
 * the two-named-shapes design this module used to depend on). Each column
 * is one pane on its own, or an ordinary `LayoutSplit` (direction "column")
 * stacking that column's panes vertically with weight-based sizing —
 * nothing inside a column is special, only the column's own placement along
 * the scroll axis is size-based rather than weight-based. This module
 * registers `"./daemon"`'s schema and `"."`'s renderer for kind `"scroll"`
 * (see daemon.ts, index.ts); it only produces and reads the data here.
 *
 * Only `close` and `focusInDirection` are required by `TilingAlgorithm`, plus
 * `init` to build the first arrangement, plus `resizeFocus` as the one resize
 * with a clean niri-native meaning (column width for left/right, the column's
 * own vertical weight split for up/down). `swap`, `applyPreset`,
 * `resizeDivider` and `hasNeighbour` are deliberately omitted: a scroll strip
 * has no divider paths to name and no preset vocabulary, which the interface
 * anticipates — omitting an optional capability is a valid outcome, not a gap.
 *
 * The `split` method dispatches to the niri-native column operations:
 * "row" (side-by-side) inserts a new column via `insertColumn`, and "column"
 * (stacked) inserts into the focused column's vertical stack via
 * `insertIntoColumn`. This gives the algorithm the full `TilingAlgorithm`
 * vocabulary while keeping its own extended helpers on `niriColumns` for
 * callers that need the raw primitives.
 */

import {
  closeLayout,
  collapse,
  DOCK_SIDES,
  emptyDockStrips,
  layoutPanes,
  makeLayout,
  type Direction,
  type Layout,
  type LayoutContainer,
  type LayoutNode,
  type LayoutSize,
  type PaneRef,
  type TilingAlgorithm,
} from "@danielfgray/amux";

/** A fresh column is half the viewport, so two new columns sit side by side —
 *  niri's default col widths behave the same way (a window takes a share of the
 *  screen, not the whole of it). Floored so a narrow viewport still yields a
 *  usable terminal, and capped at the viewport itself so the floor never makes
 *  a column wider than the screen it opens on. */
const MIN_COLUMN_WIDTH = 20;

/** Minimum height of a pane inside a column, in cells. Mirrors geometry.ts's
 *  own minimum for the same reason: a divider move that would strand a pane
 *  below it is refused rather than clamped into an unusable sliver. */
const MIN_CELL_HEIGHT = 3;

/** The `"scroll"` kind's private arrangement shape — offset plus a size list
 *  index-aligned with the container's `children`. Never seen outside this
 *  module and the registered schema/renderer in daemon.ts/index.ts. */
export interface NiriArrangement {
  readonly offset: number;
  readonly sizes: readonly number[];
}

function isScrollRoot(node: LayoutNode | null): node is LayoutContainer & { kind: "scroll" } {
  return node !== null && node.type === "container" && node.kind === "scroll";
}

function arrangementOf(root: LayoutContainer): NiriArrangement {
  return root.arrangement as NiriArrangement;
}

function scrollRoot(
  children: readonly LayoutNode[],
  sizes: readonly number[],
  offset = 0,
): LayoutContainer {
  return {
    type: "container",
    kind: "scroll",
    weight: 1,
    arrangement: { offset, sizes: [...sizes] },
    children: [...children],
  };
}

function defaultColumnWidth(size: LayoutSize): number {
  if (!(size.cols > 0)) return 40;
  return Math.min(size.cols, Math.max(MIN_COLUMN_WIDTH, Math.floor(size.cols / 2)));
}

function columnNode(panes: readonly PaneRef[]): LayoutNode {
  const [first, ...rest] = panes;
  if (!first) throw new Error("niri column needs at least one pane");
  if (rest.length === 0) {
    // A one-child column split would collapse to this anyway (see collapse()
    // in layout.ts), so build the fixed point directly: the pane itself.
    return { type: "pane", ...first, weight: 1 };
  }
  return {
    type: "split",
    direction: "column",
    weight: 1,
    children: panes.map((ref) => ({ type: "pane" as const, ...ref, weight: 1 })),
  };
}

function contentWidth(sizes: readonly number[]): number {
  return sizes.reduce((sum, s) => sum + s, 0);
}

/** Keep the viewport inside the content: `[0, content - viewport]`, or 0 when
 *  the whole strip fits on screen. Every path that changes column widths or
 *  drops a column passes through here, so a removed trailing column can never
 *  leave the offset pointing past the end of the strip. */
function clampOffset(offset: number, sizes: readonly number[], viewportCols: number): number {
  const max = Math.max(0, contentWidth(sizes) - Math.max(0, viewportCols));
  return Math.min(Math.max(0, offset), max);
}

/** Which column holds `paneId`, and where the pane sits in that column's own
 *  top-to-bottom pane order. Null when the layout places the pane nowhere in
 *  the tiled strip (a float, a dock, or an unknown id). */
function locate(
  root: LayoutContainer,
  paneId: string,
): { column: number; row: number; ids: readonly string[] } | null {
  for (let column = 0; column < root.children.length; column++) {
    const ids = layoutPanes(root.children[column]!).map((pane) => pane.id);
    const row = ids.indexOf(paneId);
    if (row !== -1) return { column, row, ids };
  }
  return null;
}

function columnsOf(root: LayoutContainer): string[][] {
  return root.children.map((child) => layoutPanes(child).map((pane) => pane.id));
}

/** The pane tmux-style directional focus reaches from `from`, without moving
 *  anything. Left/right cross to the adjacent column — holding the same row
 *  position, or the column's first pane when the target column is shorter —
 *  while up/down walk the current column's vertical stack. Null at either
 *  edge. This is the algorithm's own geometry: columns are sized, not
 *  weighed, so nothing in geometry.ts (which only understands split trees)
 *  can answer it. */
function neighbour(root: LayoutNode | null, from: string, direction: Direction): string | null {
  if (!isScrollRoot(root)) return null;
  const columns = columnsOf(root);
  const at = locate(root, from);
  if (!at) return null;
  if (direction === "left" || direction === "right") {
    const ids = columns[at.column + (direction === "right" ? 1 : -1)];
    if (!ids || ids.length === 0) return null;
    return ids[at.row] ?? ids[0] ?? null;
  }
  const ids = columns[at.column] ?? [];
  return ids[at.row + (direction === "down" ? 1 : -1)] ?? null;
}

/** The offset that brings `paneId`'s column fully into view with the minimum
 *  move: untouched when the column is already fully visible, shifted to the
 *  column's near edge when it hangs off the left, and to its far edge minus
 *  the viewport when it hangs off the right. Spans come from summing
 *  preceding columns' sizes against the running offset. */
function scrollOffset(root: LayoutContainer, viewportCols: number, paneId: string): number {
  const { offset, sizes } = arrangementOf(root);
  const viewport = Math.max(0, viewportCols);
  let start = 0;
  for (let i = 0; i < root.children.length; i++) {
    const columnSize = sizes[i] ?? 0;
    const end = start + columnSize;
    if (layoutPanes(root.children[i]!).some((pane) => pane.id === paneId)) {
      if (start < offset) return clampOffset(start, sizes, viewport);
      if (end > offset + viewport) return clampOffset(end - viewport, sizes, viewport);
      return offset;
    }
    start = end;
  }
  return offset;
}

/** Bring `paneId`'s column fully into view with the minimum offset move, as a
 *  pure transform: a fresh Layout when the offset changes, the same Layout
 *  back when the column is already fully visible (or unknown), so callers can
 *  rely on reference equality to skip re-rendering. */
function scrollIntoView(layout: Layout, size: LayoutSize, paneId: string): Layout {
  const root = layout.root;
  if (!isScrollRoot(root)) return layout;
  const next = scrollOffset(root, size.cols, paneId);
  const arrangement = arrangementOf(root);
  if (next === arrangement.offset) return layout;
  return makeLayout({
    ...layout,
    root: { ...root, arrangement: { ...arrangement, offset: next } },
  });
}

/** Remove one pane from a column's subtree. The caller runs the result through
 *  `collapse()` — a column drained to one pane becomes that pane, the same
 *  fixed point `init` builds — and drops a column that drains to nothing. A
 *  scroll root recursing into itself (never expected in practice — a column
 *  never nests another scroll strip) keeps its sizes index-aligned with
 *  whichever children survive. */
function excise(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "pane") return node.id === paneId ? null : node;
  if (isScrollRoot(node)) {
    const sizes = arrangementOf(node).sizes;
    const children: LayoutNode[] = [];
    const kept: number[] = [];
    node.children.forEach((child, i) => {
      const next = excise(child, paneId);
      if (next) {
        children.push(next);
        kept.push(sizes[i] ?? MIN_COLUMN_WIDTH);
      }
    });
    return children.length > 0 ? scrollRoot(children, kept, arrangementOf(node).offset) : null;
  }
  const children = node.children
    .map((child) => excise(child, paneId))
    .filter((child): child is LayoutNode => child !== null);
  return children.length > 0 ? { ...node, children } : null;
}

function closeScroll(
  layout: Layout,
  size: LayoutSize,
  root: LayoutContainer,
  paneId: string,
): Layout {
  const dockStrips = layout.docks ?? emptyDockStrips();
  const panes = layoutPanes(root);
  const index = panes.findIndex((pane) => pane.id === paneId);
  const floats = layout.floats.filter((float) => float.id !== paneId);
  const docks = {
    left: dockStrips.left.filter((pane) => pane.id !== paneId),
    right: dockStrips.right.filter((pane) => pane.id !== paneId),
    top: dockStrips.top.filter((pane) => pane.id !== paneId),
    bottom: dockStrips.bottom.filter((pane) => pane.id !== paneId),
  } as typeof dockStrips;
  const dockChanged = DOCK_SIDES.some((side) => docks[side].length !== dockStrips[side].length);
  if (index === -1 && floats.length === layout.floats.length && !dockChanged) return layout;

  // The tiled half mirrors closeLayout's removal, minus its collapse: a scroll
  // with one column left is still a scroll strip (it keeps its offset), and
  // only the column's own inner split collapses via collapse(). Zero columns
  // is the empty layout, the same real state closeLayout produces.
  let next: LayoutNode | null = root;
  if (index !== -1) {
    const sizes = arrangementOf(root).sizes;
    const children: LayoutNode[] = [];
    const kept: number[] = [];
    root.children.forEach((child, i) => {
      if (!layoutPanes(child).some((pane) => pane.id === paneId)) {
        children.push(child);
        kept.push(sizes[i] ?? MIN_COLUMN_WIDTH);
        return;
      }
      const pruned = collapse(excise(child, paneId));
      if (pruned) {
        children.push(pruned);
        kept.push(sizes[i] ?? MIN_COLUMN_WIDTH);
      }
    });
    if (children.length === 0) {
      next = null;
    } else {
      next = scrollRoot(children, kept, clampOffset(arrangementOf(root).offset, kept, size.cols));
    }
  }
  // Focus handoff is closeLayout's rule: the tiled pane that took the closed
  // pane's place, or the last one when it was at the end — falling back to
  // whatever the layout still places, topmost last.
  const survivors = layoutPanes(next);
  const heir = index === -1 ? undefined : survivors[Math.min(index, survivors.length - 1)];
  const remaining = [...survivors, ...DOCK_SIDES.flatMap((side) => docks[side]), ...floats];
  const focus = layout.focus === paneId ? (heir ?? remaining.at(-1))?.id : layout.focus;
  return makeLayout({ ...layout, root: next, floats, docks, focus });
}

function resizeColumnWidths(
  layout: Layout,
  size: LayoutSize,
  root: LayoutContainer,
  paneId: string,
  direction: Direction,
  delta: number,
): Layout {
  const at = locate(root, paneId);
  if (!at) return layout;
  const arrangement = arrangementOf(root);
  if (direction === "left" || direction === "right") {
    // A free strip has no neighbour to steal cells from, so left/right resize
    // the column itself: rightward widens, leftward narrows (a tmux-style
    // grow-toward would widen either way, which leaves no way to shrink).
    const current = arrangement.sizes[at.column];
    if (current === undefined) return layout;
    const next = current + (direction === "right" ? delta : -delta);
    if (next === current || next < MIN_COLUMN_WIDTH) return layout;
    const sizes = arrangement.sizes.map((s, i) => (i === at.column ? next : s));
    return makeLayout({
      ...layout,
      root: {
        ...root,
        arrangement: { offset: clampOffset(arrangement.offset, sizes, size.cols), sizes },
      },
    });
  }
  // Up/down move inside the column, whose panes are weight-based: the same
  // grow-at-the-neighbour's-expense math geometry.ts applies to a split, done
  // by hand here because that code cannot see inside a scroll node. The rows
  // available are the full viewport height — columns are full-height strips.
  const column = root.children[at.column];
  if (!column || column.type !== "split") return layout;
  const paneIndex = column.children.findIndex(
    (child) => child.type === "pane" && child.id === paneId,
  );
  const other = paneIndex + (direction === "down" ? 1 : -1);
  const focused = column.children[paneIndex];
  const rival = column.children[other];
  if (!focused || !rival) return layout;
  if (size.rows <= 0) return layout;
  const available = Math.max(0, size.rows - (column.children.length - 1));
  const total = column.children.reduce((sum, child) => sum + child.weight, 0);
  if (!(total > 0)) return layout;
  const sizes = column.children.map((child) => (available * child.weight) / total);
  const focusedSize = sizes[paneIndex];
  const rivalSize = sizes[other];
  if (focusedSize === undefined || rivalSize === undefined) return layout;
  const grown = focusedSize + delta;
  const shrunk = rivalSize - delta;
  if (grown < MIN_CELL_HEIGHT || shrunk < MIN_CELL_HEIGHT) return layout;
  if (grown === focusedSize) return layout;
  sizes[paneIndex] = grown;
  sizes[other] = shrunk;
  return makeLayout({
    ...layout,
    root: {
      ...root,
      children: root.children.map((child, i) =>
        i === at.column
          ? {
              ...column,
              children: column.children.map((entry, j) => ({
                ...entry,
                weight: Math.max(0.0001, sizes[j] ?? entry.weight),
              })),
            }
          : child,
      ),
    },
  });
}

export const niriTilingAlgorithm: TilingAlgorithm = {
  id: "niri",
  version: 1,

  init(panes, size) {
    if (panes.length === 0) return makeLayout({ root: null });
    // A niri window opens a new column by default: one pane per column.
    const width = defaultColumnWidth(size);
    const children = panes.map((ref) => columnNode([ref]));
    const sizes = panes.map(() => width);
    return makeLayout({ root: scrollRoot(children, sizes), focus: panes[0]!.id });
  },

  close(layout, size, paneId) {
    const root = layout.root;
    // A shape this algorithm did not build (a handover from the split-tree
    // algorithm, or an empty root with only floats/docks to close from) keeps
    // core's semantics: delegate rather than reinterpret it.
    if (!isScrollRoot(root)) return closeLayout(layout, paneId);
    return closeScroll(layout, size, root, paneId);
  },

  focusInDirection(layout, size, from, direction) {
    // A pure query: the interface returns only the focused pane's id, with no
    // channel back to a revised Layout, so any scroll-position change travels
    // separately via `ensureVisible` below (which Window calls right after any
    // focus move). Nothing here is mutated.
    return neighbour(layout.root, from, direction);
  },

  split(layout, size, at, direction, pane) {
    return direction === "row"
      ? niriColumns.insertColumn(layout, size, pane, at)
      : niriColumns.insertIntoColumn(layout, size, at, pane);
  },

  resizeFocus(layout, size, paneId, direction, delta) {
    const root = layout.root;
    if (!isScrollRoot(root)) return layout;
    return resizeColumnWidths(layout, size, root, paneId, direction, delta);
  },

  // The scroll-into-view half of a focus move: the pure transform above, which
  // Window calls right after any operation that moves focus.
  ensureVisible: scrollIntoView,
};

/**
 * Niri-native inserts: opening beside (a new column) versus opening below
 * (into the focused column's stack). `split` above dispatches to these by
 * axis; they stay exposed here too for callers that need the raw primitive
 * directly (e.g. `insertColumn`'s optional `afterPaneId` anchor, which
 * `split`'s fixed axis+at signature can't express on its own).
 */
export const niriColumns = {
  /** A fresh column's width for this viewport. Exposed so tests and future
   *  callers share the one rule instead of restating it. */
  defaultColumnWidth(size: LayoutSize): number {
    return defaultColumnWidth(size);
  },

  /** Bring `paneId`'s column fully into view with the minimum offset move.
   *  The same pure transform the algorithm's own `ensureVisible` runs. */
  scrollIntoView(layout: Layout, size: LayoutSize, paneId: string): Layout {
    return scrollIntoView(layout, size, paneId);
  },

  /** Open `pane` as a new column after the column holding `afterPaneId`
   *  (the focused pane when omitted), focusing it and scrolling it into view
   *  the way niri focuses a newly opened window. */
  insertColumn(layout: Layout, size: LayoutSize, pane: PaneRef, afterPaneId?: string): Layout {
    const root = layout.root;
    const width = defaultColumnWidth(size);
    const newChild = columnNode([pane]);
    if (!isScrollRoot(root)) {
      const panes = [...layoutPanes(root), pane];
      const children = panes.map((ref) => (ref.id === pane.id ? newChild : columnNode([ref])));
      const sizes = panes.map(() => width);
      return makeLayout({ ...layout, root: scrollRoot(children, sizes), focus: pane.id });
    }
    const anchor = afterPaneId ?? layout.focus;
    const at = anchor ? locate(root, anchor)?.column : undefined;
    const insertAt = at === undefined ? root.children.length : at + 1;
    const children = [...root.children];
    children.splice(insertAt, 0, newChild);
    const sizes = [...arrangementOf(root).sizes];
    sizes.splice(insertAt, 0, width);
    const clamped = clampOffset(arrangementOf(root).offset, sizes, size.cols);
    const fresh = scrollRoot(children, sizes, clamped);
    const shown = scrollOffset(fresh, size.cols, pane.id);
    return makeLayout({
      ...layout,
      root: { ...fresh, arrangement: { ...arrangementOf(fresh), offset: shown } },
      focus: pane.id,
    });
  },

  /** Open `pane` inside the column holding `atPaneId` — after it by default —
   *  as a new bottom-weight stack entry, keeping the column's width. */
  insertIntoColumn(
    layout: Layout,
    size: LayoutSize,
    atPaneId: string,
    pane: PaneRef,
    position: "before" | "after" = "after",
  ): Layout {
    const root = layout.root;
    if (!isScrollRoot(root)) {
      // The window hasn't been arranged into niri's own scroll-root shape yet
      // (it switched onto niri mid-session, or was initialized under a
      // different algorithm) — give every existing pane its own column, the
      // same fallback insertColumn uses, except atPaneId's column becomes the
      // two-pane stack this call asked for.
      const panes = layoutPanes(root);
      if (!panes.some((candidate) => candidate.id === atPaneId)) return layout;
      const width = defaultColumnWidth(size);
      const leaf: LayoutNode = { type: "pane", ...pane, weight: 1 };
      const children: LayoutNode[] = panes.map((ref) => {
        if (ref.id !== atPaneId) return columnNode([ref]);
        const existing: LayoutNode = { ...ref, weight: 1 };
        return {
          type: "split",
          direction: "column",
          weight: 1,
          children: position === "after" ? [existing, leaf] : [leaf, existing],
        };
      });
      const sizes = panes.map(() => width);
      return makeLayout({ ...layout, root: scrollRoot(children, sizes), focus: pane.id });
    }
    const at = locate(root, atPaneId);
    if (!at) return layout;
    const column = root.children[at.column];
    if (!column) return layout;
    const leaf: LayoutNode = { type: "pane", ...pane, weight: 1 };
    let node: LayoutNode;
    if (column.type === "pane") {
      node = {
        type: "split",
        direction: "column",
        weight: column.weight,
        children:
          position === "after"
            ? [{ ...column, weight: 1 }, leaf]
            : [leaf, { ...column, weight: 1 }],
      };
    } else if (column.type === "split") {
      const index = column.children.findIndex(
        (child) => child.type === "pane" && child.id === atPaneId,
      );
      const children = [...column.children];
      children.splice(
        index === -1 ? children.length : index + (position === "after" ? 1 : 0),
        0,
        leaf,
      );
      node = { ...column, children };
    } else {
      return layout;
    }
    return makeLayout({
      ...layout,
      root: {
        ...root,
        children: root.children.map((child, i) => (i === at.column ? node : child)),
      },
      focus: pane.id,
    });
  },
};
