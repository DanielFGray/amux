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
 * Method-shaped helpers build the Effect algorithm via tilingAlgorithmFromMethods.
 * `hasNeighbour` stays a client-side render query on the methods object (not a
 * core layout operation). `ensureVisible` folds into focus/close answers.
 *
 * The `split` method dispatches to the niri-native column operations:
 * "row" (side-by-side) inserts a new column via `insertColumn`, and "column"
 * (stacked) inserts into the focused column's vertical stack via
 * `insertIntoColumn`. Extended helpers stay on `niriColumns` for callers that
 * need the raw primitives.
 */

import {
  closeLayout,
  collapse,
  DOCK_SIDES,
  emptyDockStrips,
  layoutPanes,
  makeLayout,
  tilingAlgorithmFromMethods,
  type Direction,
  type Layout,
  type LayoutContainer,
  type LayoutNode,
  type LayoutSize,
  type PaneRef,
  type SplitDirection,
  type TilingAlgorithmMethods,
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

/** Cells of empty space between adjacent columns — niri's layout gaps, sized
 *  to match amux's one-cell split dividers so a strip reads as panes with
 *  gutters rather than a fused wall of terminals. Exported for the scroll
 *  renderer, which draws the same gap via Yoga. */
export const COLUMN_GAP = 1;

/** The `"scroll"` kind's private arrangement shape — offset plus a size list
 *  index-aligned with the container's `children`, plus the last-focused pane
 *  in each column (niri's `active_tile_idx`, keyed by pane id). Never seen
 *  outside this module and the registered schema/renderer in daemon.ts/
 *  index.ts. */
export interface NiriArrangement {
  readonly offset: number;
  readonly sizes: readonly number[];
  /** Last-focused pane id per column, index-aligned with `children`/`sizes`. */
  readonly active: readonly string[];
  /** Viewport cols the `sizes` were last resolved against. When the pane host
   *  shrinks (sidebar open, terminal resize), ensureVisible scales sizes by
   *  `size.cols / basisCols` so two half-width columns still fit — niri's
   *  proportion widths reflow the same way against working_area. */
  readonly basisCols?: number;
}

function isScrollRoot(node: LayoutNode | null): node is LayoutContainer & { kind: "scroll" } {
  return node !== null && node.type === "container" && node.kind === "scroll";
}

function arrangementOf(root: LayoutContainer): NiriArrangement {
  const raw = root.arrangement as NiriArrangement;
  // Older saved strips (and hand-built fixtures) may omit `active` — fill from
  // each column's top pane so every reader sees a complete arrangement.
  const active =
    raw.active && raw.active.length === root.children.length
      ? raw.active
      : root.children.map((child, i) => raw.active?.[i] ?? layoutPanes(child)[0]?.id ?? "");
  return {
    offset: raw.offset,
    sizes: raw.sizes,
    active,
    basisCols: raw.basisCols,
  };
}

function scrollRoot(
  children: readonly LayoutNode[],
  sizes: readonly number[],
  offset = 0,
  active?: readonly string[],
  basisCols?: number,
): LayoutContainer {
  const resolved =
    active && active.length === children.length
      ? [...active]
      : children.map((child) => layoutPanes(child)[0]?.id ?? "");
  const arrangement: NiriArrangement = {
    offset,
    sizes: [...sizes],
    active: resolved,
    basisCols: basisCols !== undefined && basisCols > 0 ? basisCols : undefined,
  };
  return {
    type: "container",
    kind: "scroll",
    weight: 1,
    arrangement,
    children: [...children],
  };
}

function defaultColumnWidth(size: LayoutSize): number {
  if (!(size.cols > 0)) return 40;
  // Subtract one gap so two fresh columns plus the gutter between them fit
  // the viewport exactly — otherwise half+half+gap overflows by one cell and
  // ensureVisible nudges the strip on every focus, which feels like jank.
  const pair = Math.max(0, size.cols - COLUMN_GAP);
  return Math.min(size.cols, Math.max(MIN_COLUMN_WIDTH, Math.floor(pair / 2)));
}

/**
 * A lone column fills the viewport. niri opens at half-width so a second
 * column can slide in beside it; in a terminal mux that leaves an empty half
 * of the screen whenever you start with one pane or close down to one.
 * Borrowed from niri's `expand_column_to_available_width` when only the active
 * column is on screen (toggle full-width) — here it's the standing policy for
 * a sole column, not a user gesture.
 */
function fillSoleColumn(sizes: readonly number[], viewportCols: number): number[] {
  if (sizes.length !== 1) return [...sizes];
  const cols = Math.max(0, Math.floor(viewportCols));
  if (!(cols > 0)) return [...sizes];
  return [Math.max(MIN_COLUMN_WIDTH, cols)];
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
  if (sizes.length === 0) return 0;
  return sizes.reduce((sum, s) => sum + s, 0) + COLUMN_GAP * (sizes.length - 1);
}

/** Absolute x of column `index` along the strip, including the gaps that
 *  separate preceding columns — niri's `column_x`. */
function columnStart(sizes: readonly number[], index: number): number {
  let x = 0;
  for (let i = 0; i < index; i++) {
    x += (sizes[i] ?? 0) + COLUMN_GAP;
  }
  return x;
}

/** Keep the viewport inside the content: `[0, content - viewport]`, or 0 when
 *  the whole strip fits on screen. Every path that changes column widths or
 *  drops a column passes through here, so a removed trailing column can never
 *  leave the offset pointing past the end of the strip. */
function clampOffset(offset: number, sizes: readonly number[], viewportCols: number): number {
  const max = Math.max(0, contentWidth(sizes) - Math.max(0, viewportCols));
  return Math.min(Math.max(0, offset), max);
}

/**
 * Absolute viewport offset that brings `newColX`..`+newColWidth` into view.
 *
 * Borrowed from niri's `compute_new_view_offset` (`../niri/src/layout/scrolling.rs`):
 * leave the view alone when the column is already fully visible (with gap
 * padding), otherwise pick the left or right alignment that moves less. A
 * column wider than the viewport always left-aligns.
 */
function computeNewViewOffset(
  curX: number,
  viewWidth: number,
  newColX: number,
  newColWidth: number,
  gaps: number,
): number {
  if (viewWidth <= newColWidth) return newColX;

  const padding = Math.min(gaps, Math.max(0, (viewWidth - newColWidth) / 2));
  const newX = newColX - padding;
  const newRightX = newColX + newColWidth + padding;

  if (curX <= newX && newRightX <= curX + viewWidth) return curX;

  const distToLeft = Math.abs(curX - newX);
  const distToRight = Math.abs(curX + viewWidth - newRightX);
  return distToLeft <= distToRight ? newX : newRightX - viewWidth;
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
 *  anything. Left/right cross to the adjacent column — restoring that column's
 *  last-focused pane (niri's per-column `active_tile_idx`), falling back to
 *  the same row index or the column's first pane when the target is shorter —
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
    const target = at.column + (direction === "right" ? 1 : -1);
    const ids = columns[target];
    if (!ids || ids.length === 0) return null;
    const remembered = arrangementOf(root).active[target];
    if (remembered && ids.includes(remembered)) return remembered;
    return ids[at.row] ?? ids[0] ?? null;
  }
  const ids = columns[at.column] ?? [];
  return ids[at.row + (direction === "down" ? 1 : -1)] ?? null;
}

/** Whether `paneId` has a neighbour on `side` along `axis` inside the scroll
 *  strip — columns for row, stack siblings for column. Used by Window chrome
 *  (via the kind renderer) so gap=false mode can leave internal seams bare. */
function columnHasNeighbour(
  root: LayoutContainer,
  paneId: string,
  axis: "row" | "column",
  side: -1 | 1,
): boolean {
  const at = locate(root, paneId);
  if (!at) return false;
  if (axis === "row") {
    return side < 0 ? at.column > 0 : at.column < root.children.length - 1;
  }
  return side < 0 ? at.row > 0 : at.row < at.ids.length - 1;
}

/**
 * Rescale column widths when the pane-host viewport changed since sizes were
 * last written (sidebar toggle, terminal resize). Preserves relative layout the
 * way niri proportion widths reflow against working_area; stamps `basisCols`
 * so a no-op size is reference-equal after the first stamp. A sole column is
 * always expanded to the viewport (see {@link fillSoleColumn}).
 */
function adaptViewport(layout: Layout, size: LayoutSize): Layout {
  const root = layout.root;
  if (!isScrollRoot(root)) return layout;
  const arrangement = arrangementOf(root);
  const cols = Math.max(0, Math.floor(size.cols));
  if (!(cols > 0)) return layout;
  const basis = arrangement.basisCols ?? cols;
  const scaled =
    basis === cols
      ? [...arrangement.sizes]
      : arrangement.sizes.map((s) => Math.max(MIN_COLUMN_WIDTH, Math.round(s * (cols / basis))));
  const sizes = fillSoleColumn(scaled, cols);
  const sameSizes =
    sizes.length === arrangement.sizes.length && sizes.every((s, i) => s === arrangement.sizes[i]);
  if (basis === cols && arrangement.basisCols === cols && sameSizes) return layout;
  const offset = clampOffset(
    basis === cols ? arrangement.offset : Math.round(arrangement.offset * (cols / basis)),
    sizes,
    cols,
  );
  return makeLayout({
    ...layout,
    root: scrollRoot(root.children, sizes, offset, arrangement.active, cols),
  });
}

/** The offset that brings `paneId`'s column into view the way niri does —
 *  untouched when already fully visible (with gap padding), otherwise the
 *  left/right alignment that moves the viewport less. */
function scrollOffset(root: LayoutContainer, viewportCols: number, paneId: string): number {
  const { offset, sizes } = arrangementOf(root);
  const at = locate(root, paneId);
  if (!at) return offset;
  const next = computeNewViewOffset(
    offset,
    Math.max(0, viewportCols),
    columnStart(sizes, at.column),
    sizes[at.column] ?? 0,
    COLUMN_GAP,
  );
  return clampOffset(next, sizes, viewportCols);
}

/** Bring `paneId`'s column into view and remember it as that column's active
 *  pane. Also adapts column widths when the viewport's cell count drifted
 *  from `basisCols` (sidebar / terminal resize). Returns the same Layout when
 *  nothing changes, so callers can rely on reference equality to skip
 *  re-rendering. */
function scrollIntoView(layout: Layout, size: LayoutSize, paneId: string): Layout {
  const adapted = adaptViewport(layout, size);
  const root = adapted.root;
  if (!isScrollRoot(root)) return adapted;
  const arrangement = arrangementOf(root);
  const nextOffset = scrollOffset(root, size.cols, paneId);
  const at = locate(root, paneId);
  const nextActive =
    at && arrangement.active[at.column] !== paneId
      ? arrangement.active.map((id, i) => (i === at.column ? paneId : id))
      : arrangement.active;
  if (nextOffset === arrangement.offset && nextActive === arrangement.active) return adapted;
  return makeLayout({
    ...adapted,
    root: {
      ...root,
      arrangement: {
        ...arrangement,
        offset: nextOffset,
        active: nextActive === arrangement.active ? arrangement.active : [...nextActive],
      },
    },
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

/** Drop `paneId` from the scroll strip. Returns the surviving root (or null)
 *  and the pane that should inherit focus when the closed pane held it —
 *  stack survivor in the same column, else the previous column's active pane
 *  (niri's activate_prev_column_on_removal default). */
interface RemovePaneFromStripResult {
  readonly next: LayoutNode | null;
  readonly heir: string | undefined;
}

function removePaneFromStrip(
  root: LayoutContainer,
  paneId: string,
  size: LayoutSize,
  columnHint: number,
): RemovePaneFromStripResult {
  const arrangement = arrangementOf(root);
  const children: LayoutNode[] = [];
  const kept: number[] = [];
  const active: string[] = [];
  let heir: string | undefined;

  const keep = (child: LayoutNode, sizeIdx: number, pick?: string) => {
    children.push(child);
    kept.push(arrangement.sizes[sizeIdx] ?? MIN_COLUMN_WIDTH);
    active.push(pick ?? arrangement.active[sizeIdx] ?? layoutPanes(child)[0]?.id ?? "");
  };

  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i]!;
    if (!layoutPanes(child).some((pane) => pane.id === paneId)) {
      keep(child, i);
      continue;
    }
    const pruned = collapse(excise(child, paneId));
    if (pruned) {
      const ids = layoutPanes(pruned).map((pane) => pane.id);
      const remembered = arrangement.active[i];
      const pick =
        remembered && remembered !== paneId && ids.includes(remembered)
          ? remembered
          : (ids[0] ?? "");
      keep(pruned, i, pick);
      heir = pick || undefined;
      continue;
    }
    const prev = children.length - 1;
    if (prev >= 0) heir = active[prev] || layoutPanes(children[prev]!)[0]?.id;
  }

  if (children.length === 0) return { next: null, heir: undefined };
  if (heir === undefined) {
    const idx = Math.min(columnHint, children.length - 1);
    heir = active[idx] || layoutPanes(children[idx]!)[0]?.id;
  }
  const sizes = fillSoleColumn(kept, size.cols);
  return {
    next: scrollRoot(
      children,
      sizes,
      clampOffset(arrangement.offset, sizes, size.cols),
      active,
      size.cols,
    ),
    heir,
  };
}

function closeScroll(
  layout: Layout,
  size: LayoutSize,
  root: LayoutContainer,
  paneId: string,
): Layout {
  const dockStrips = layout.docks ?? emptyDockStrips();
  const floats = layout.floats.filter((float) => float.id !== paneId);
  const docks = {
    left: dockStrips.left.filter((pane) => pane.id !== paneId),
    right: dockStrips.right.filter((pane) => pane.id !== paneId),
    top: dockStrips.top.filter((pane) => pane.id !== paneId),
    bottom: dockStrips.bottom.filter((pane) => pane.id !== paneId),
  } as typeof dockStrips;
  const dockChanged = DOCK_SIDES.some((side) => docks[side].length !== dockStrips[side].length);
  const at = locate(root, paneId);
  if (!at && floats.length === layout.floats.length && !dockChanged) return layout;

  const removed = at ? removePaneFromStrip(root, paneId, size, at.column) : null;
  const next = removed ? removed.next : root;
  const survivors = layoutPanes(next);
  const remaining = [...survivors, ...DOCK_SIDES.flatMap((side) => docks[side]), ...floats];
  const focus = layout.focus === paneId ? (removed?.heir ?? remaining.at(-1)?.id) : layout.focus;
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
    // A sole column always fills the viewport (fillSoleColumn); shrinking it
    // would only invent empty space that ensureVisible immediately reclaims.
    if (arrangement.sizes.length === 1) return layout;
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
        arrangement: {
          offset: clampOffset(arrangement.offset, sizes, size.cols),
          sizes,
          active: arrangement.active,
          // User-chosen widths are absolute for this viewport — stamp basis so
          // the next sidebar toggle scales from here rather than undoing the
          // resize against a stale basis.
          basisCols: Math.max(0, Math.floor(size.cols)),
        },
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

/** Move `delta` rows between adjacent panes of the stack in column `colIdx`. */
function resizeStackDivider(
  layout: Layout,
  size: LayoutSize,
  root: LayoutContainer,
  colIdx: number,
  index: number,
  delta: number,
): Layout {
  const column = root.children[colIdx];
  if (!column || column.type !== "split" || column.direction !== "column") return layout;
  if (index < 0 || index >= column.children.length - 1) return layout;
  if (!(size.rows > 0)) return layout;
  const available = Math.max(0, size.rows - (column.children.length - 1));
  const totalWeight = column.children.reduce((sum, child) => sum + child.weight, 0);
  if (!(totalWeight > 0) || available <= 0) return layout;
  const sizes = column.children.map((child) => (available * child.weight) / totalWeight);
  const left = sizes[index]!;
  const right = sizes[index + 1]!;
  const pair = left + right;
  if (pair < MIN_CELL_HEIGHT * 2) return layout;
  const nextLeft = Math.max(MIN_CELL_HEIGHT, Math.min(pair - MIN_CELL_HEIGHT, left + delta));
  if (nextLeft === left) return layout;
  sizes[index] = nextLeft;
  sizes[index + 1] = pair - nextLeft;
  return makeLayout({
    ...layout,
    root: {
      ...root,
      children: root.children.map((child, i) =>
        i === colIdx
          ? {
              ...column,
              children: column.children.map((entry, j) => ({
                ...entry,
                weight: Math.max(0.0001, sizes[j]!),
              })),
            }
          : child,
      ),
    },
  });
}

/** Move `delta` cells from column `index+1` onto `index` (or the reverse when
 *  negative), clamping so neither side drops below `MIN_COLUMN_WIDTH`. Shared
 *  by the daemon transform and the client's live drag echo. */
export function transferColumnCells(
  sizes: readonly number[],
  index: number,
  delta: number,
): number[] | null {
  if (delta === 0 || index < 0 || index >= sizes.length - 1) return null;
  const left = sizes[index]!;
  const right = sizes[index + 1]!;
  const total = left + right;
  if (total < MIN_COLUMN_WIDTH * 2) return null;
  const nextLeft = Math.max(MIN_COLUMN_WIDTH, Math.min(total - MIN_COLUMN_WIDTH, left + delta));
  if (nextLeft === left) return null;
  return sizes.map((s, i) => (i === index ? nextLeft : i === index + 1 ? total - nextLeft : s));
}

export const niriTilingMethods: TilingAlgorithmMethods & {
  hasNeighbour(
    layout: Layout,
    size: LayoutSize,
    paneId: string,
    axis: SplitDirection,
    side: -1 | 1,
  ): boolean;
} = {
  id: "niri",
  version: 1,

  init(panes, size) {
    if (panes.length === 0) return makeLayout({ root: null });
    // A niri window opens a new column by default: one pane per column.
    // A sole column fills the viewport (see fillSoleColumn); two or more open
    // at half-width so a neighbour can sit beside without overflowing.
    const width =
      panes.length === 1 && size.cols > 0 ? Math.floor(size.cols) : defaultColumnWidth(size);
    const children = panes.map((ref) => columnNode([ref]));
    const sizes = fillSoleColumn(
      panes.map(() => width),
      size.cols,
    );
    return makeLayout({
      root: scrollRoot(children, sizes, 0, undefined, size.cols),
      focus: panes[0]!.id,
    });
  },

  close(layout, size, paneId) {
    const root = layout.root;
    // A shape this algorithm did not build (a handover from the split-tree
    // algorithm, or an empty root with only floats/docks to close from) keeps
    // core's semantics: delegate rather than reinterpret it.
    if (!isScrollRoot(root)) return closeLayout(layout, paneId);
    return closeScroll(layout, size, root, paneId);
  },

  focusInDirection(layout, _size, from, direction) {
    // Visibility is folded into the focusDirection answer by
    // tilingAlgorithmFromMethods (via ensureVisible below).
    return neighbour(layout.root, from, direction);
  },

  split(layout, size, at, direction, pane) {
    return direction === "row"
      ? niriColumns.insertColumn(layout, size, pane, at)
      : niriColumns.insertIntoColumn(layout, size, at, pane);
  },

  resizeFocus(layout, size, paneId, direction, delta) {
    const adapted = adaptViewport(layout, size);
    const root = adapted.root;
    if (!isScrollRoot(root)) return adapted;
    return resizeColumnWidths(adapted, size, root, paneId, direction, delta);
  },

  // Drag handle between columns (path []) or between stacked panes inside a
  // column (path [columnIndex]). geometry.ts cannot see into a scroll
  // container, so both seams live here — returning unchanged for a nested
  // path used to swallow the drag (in-column borders looked dead).
  resizeDivider(layout, size, path, index, delta) {
    if (delta === 0) return layout;
    const root = layout.root;
    if (!isScrollRoot(root)) return layout;
    if (path.length === 0) {
      const arrangement = arrangementOf(root);
      const sizes = transferColumnCells(arrangement.sizes, index, delta);
      if (!sizes) return layout;
      return makeLayout({
        ...layout,
        root: {
          ...root,
          arrangement: {
            ...arrangement,
            sizes,
            offset: clampOffset(arrangement.offset, sizes, size.cols),
            basisCols: Math.max(0, Math.floor(size.cols)),
          },
        },
      });
    }
    if (path.length !== 1) return layout;
    return resizeStackDivider(layout, size, root, path[0]!, index, delta);
  },

  // Client-side render query — not a core layout operation. Kept on the
  // methods object so the scroll renderer can call it synchronously.
  hasNeighbour(layout, _size, paneId, axis, side) {
    const root = layout.root;
    if (!isScrollRoot(root)) return false;
    return columnHasNeighbour(root, paneId, axis, side);
  },

  ensureVisible: scrollIntoView,
};

export const niriTilingAlgorithm = tilingAlgorithmFromMethods(niriTilingMethods);

/** Insert `pane` into an existing column node (a lone pane or a vertical
 *  split), before/after `atPaneId`. Null when the column isn't a stackable
 *  shape (e.g. a nested scroll). */
function stackIntoColumn(
  column: LayoutNode,
  atPaneId: string,
  pane: PaneRef,
  position: "before" | "after",
): LayoutNode | null {
  const leaf: LayoutNode = { type: "pane", ...pane, weight: 1 };
  if (column.type === "pane") {
    return {
      type: "split",
      direction: "column",
      weight: column.weight,
      children:
        position === "after" ? [{ ...column, weight: 1 }, leaf] : [leaf, { ...column, weight: 1 }],
    };
  }
  if (column.type !== "split") return null;
  const index = column.children.findIndex(
    (child) => child.type === "pane" && child.id === atPaneId,
  );
  const children = [...column.children];
  children.splice(index === -1 ? children.length : index + (position === "after" ? 1 : 0), 0, leaf);
  return { ...column, children };
}

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

  /** Bring `paneId`'s column into view (and stamp it as that column's active
   *  pane). The same pure transform the algorithm's own `ensureVisible` runs. */
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
      return makeLayout({
        ...layout,
        root: scrollRoot(children, sizes, 0, undefined, size.cols),
        focus: pane.id,
      });
    }
    const anchor = afterPaneId ?? layout.focus;
    const at = anchor ? locate(root, anchor)?.column : undefined;
    const insertAt = at === undefined ? root.children.length : at + 1;
    const arrangement = arrangementOf(root);
    const children = [...root.children];
    children.splice(insertAt, 0, newChild);
    const sizes = [...arrangement.sizes];
    sizes.splice(insertAt, 0, width);
    const active = [...arrangement.active];
    active.splice(insertAt, 0, pane.id);
    const clamped = clampOffset(arrangement.offset, sizes, size.cols);
    const fresh = scrollRoot(children, sizes, clamped, active, size.cols);
    return scrollIntoView(makeLayout({ ...layout, root: fresh, focus: pane.id }), size, pane.id);
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
      const children = panes.map((ref) =>
        ref.id === atPaneId
          ? stackIntoColumn({ ...ref, weight: 1 }, atPaneId, pane, position)!
          : columnNode([ref]),
      );
      const sizes = panes.map(() => width);
      const active = panes.map((ref) => (ref.id === atPaneId ? pane.id : ref.id));
      return makeLayout({
        ...layout,
        root: scrollRoot(children, sizes, 0, active, size.cols),
        focus: pane.id,
      });
    }
    const at = locate(root, atPaneId);
    if (!at) return layout;
    const column = root.children[at.column];
    if (!column) return layout;
    const node = stackIntoColumn(column, atPaneId, pane, position);
    if (!node) return layout;
    const arrangement = arrangementOf(root);
    const active = arrangement.active.map((id, i) => (i === at.column ? pane.id : id));
    return makeLayout({
      ...layout,
      root: {
        ...root,
        children: root.children.map((child, i) => (i === at.column ? node : child)),
        arrangement: { ...arrangement, active },
      },
      focus: pane.id,
    });
  },
};
