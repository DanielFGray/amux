/**
 * The pane-host slot's occupant contract.
 *
 * A tiling algorithm owns the arrangement of tiled panes: what `#mount()`
 * renders is exactly what the elected algorithm hands back from `Layout`,
 * and every arrangement command (split, close, swap, preset, resize,
 * directional focus) is routed to whichever algorithm currently holds the
 * pane-host slot rather than called on `layout.ts`'s free functions
 * directly. Election works like root-slot frame election (ADR 0002):
 * live-context selectors, first match wins, re-evaluated every render.
 *
 * Only `close` and `focusInDirection` are required — the one operation
 * every algorithm must support to stay usable (a pane can always be
 * closed, and focus can always move) and the one query Window's directional
 * keys always need. Everything else is a capability an algorithm may omit;
 * Window hides or no-ops the corresponding command rather than assuming
 * universal support. See docs/adr/0002-tiling-algorithm-as-slot-occupant.md
 * and docs/adr/0003-tiling-materialization-is-tree-shaped.md.
 *
 * An algorithm's own decision state may be anything it likes — this
 * interface only fixes what crosses the boundary with Window, which is
 * always a `Layout` (always tree-shaped, per ADR 0003) plus the pane it
 * acted on. `Layout` carries the elected algorithm's id/version alongside
 * the tree purely as a record of provenance (ts-b3df09) — ADR 0003's tree
 * shape (including niri's "scroll" node) already round-trips full
 * arrangement fidelity through the ordinary tree, so nothing needs to
 * persist or restore an algorithm's state separately from it.
 */

import type { Layout, LayoutPreset, PaneRef } from "./layout.ts";
import type { LayoutPath, LayoutSize } from "./geometry.ts";
import type { Direction, SplitDirection } from "./window.ts";

export interface TilingAlgorithm {
  readonly id: string;
  readonly version: number;

  /** Build a fresh arrangement from the flat list of currently-open real
   *  panes — how an algorithm starts, whether that is a window's first
   *  pane or a hand-off from the algorithm that held the slot before it. */
  init(panes: readonly PaneRef[], size: LayoutSize): Layout;

  /** Remove a pane, wherever the algorithm placed it. Required: a pane can
   *  always be closed regardless of which algorithm is elected. */
  close(layout: Layout, size: LayoutSize, paneId: string): Layout;

  /** The pane tmux-style directional focus reaches from `from`, or null at
   *  an edge the algorithm has nothing beyond. Required: Window's
   *  directional-focus keys always need an answer, even a trivial one. */
  focusInDirection(
    layout: Layout,
    size: LayoutSize,
    from: string,
    direction: Direction,
  ): string | null;

  /** Split `at` into two panes along `direction`, putting `pane` in the new
   *  half. Omit when the algorithm has no notion of splitting a slot in
   *  two (a niri-style column strip inserts a new column instead — see
   *  `insertColumn` on a scroll-based algorithm's own extended vocabulary). */
  split?(
    layout: Layout,
    size: LayoutSize,
    at: string,
    direction: SplitDirection,
    pane: PaneRef,
  ): Layout;

  /** Exchange two panes' positions, keeping each slot's own size. */
  swap?(layout: Layout, size: LayoutSize, from: string, step: number): Layout;

  /** Discard the current shape and rebuild from the pane list under a named
   *  preset. Omit when the algorithm has no preset vocabulary of its own. */
  applyPreset?(layout: Layout, size: LayoutSize, preset: LayoutPreset): Layout;

  /** Grow the focused pane's slot toward `direction` by `delta` cells. */
  resizeFocus?(
    layout: Layout,
    size: LayoutSize,
    paneId: string,
    direction: Direction,
    delta: number,
  ): Layout;

  /** Move one divider directly, identified by the path to its parent split
   *  and the child index immediately before it — a drag gesture's target.
   *  Only meaningful for a split-tree algorithm; a scroll-based algorithm's
   *  own resize vocabulary (column width) has no divider path to name. */
  resizeDivider?(
    layout: Layout,
    size: LayoutSize,
    path: LayoutPath,
    index: number,
    delta: number,
  ): Layout;

  /** Whether a pane has a neighbour on `side` along `axis` — whether a
   *  resize or directional move in that direction has anywhere to go. */
  hasNeighbour?(
    layout: Layout,
    size: LayoutSize,
    paneId: string,
    axis: SplitDirection,
    side: -1 | 1,
  ): boolean;

  /**
   * Bring `paneId` fully into view, as a pure transform of `layout`.
   *
   * A split-tree algorithm has nothing to do here: every pane it places is
   * already on screen. A viewport-based algorithm (a niri-style scroll strip)
   * is different — its own decision state includes a scroll position, and
   * moving focus onto a pane outside the current viewport requires changing
   * that position too. `focusInDirection` cannot carry that change itself:
   * its return type is only the focused pane's id, with no channel back to a
   * revised `Layout`. Window calls `ensureVisible` right after any operation
   * that moves focus (`focusInDirection`, `close`, `swap`, …), passing the
   * pane that ended up focused; an algorithm with no viewport concept omits
   * it, which Window treats as "already visible."
   */
  ensureVisible?(layout: Layout, size: LayoutSize, paneId: string): Layout;
}
