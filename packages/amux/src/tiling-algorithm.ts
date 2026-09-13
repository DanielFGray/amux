/**
 * The pane-host slot's occupant contract.
 *
 * A tiling algorithm owns the arrangement of tiled panes: what `#mount()`
 * renders is exactly what the elected algorithm hands back from `Layout`,
 * and every arrangement command (split, close, swap, preset, resize,
 * directional focus) is routed to whichever algorithm currently holds the
 * pane-host slot. Election works like root-slot frame election (ADR 0002):
 * live-context selectors, first match wins, re-evaluated every render.
 *
 * The boundary is one layout operation → one answer, as an Effect, so a
 * future plugin-host process can carry the same Schemas over a socket.
 * Visibility of the focused pane is folded into answers that move focus;
 * core never calls a second ensureVisible step. An unsupported answer
 * tells core to fall through to layout.ts free functions.
 *
 * Authors may still write a method-shaped object and pass it through
 * {@link tilingAlgorithmFromMethods}; client-side render queries such as
 * hasNeighbour stay outside this contract.
 */

import { Duration, Effect, Match, Schema as S } from "effect";
import { makeLayout, type Layout, type LayoutPreset, type PaneRef } from "./layout.ts";
import type { LayoutPath, LayoutSize } from "./geometry.ts";
import type { Direction, SplitDirection } from "./window.ts";
import { errorMessage } from "./error-message.ts";
import { PLUGIN_TILING_TIMEOUT_MS } from "./workspace-changes.ts";
import type { TilingAnswer, TilingOperation } from "./tiling-operation.ts";

export class TilingAlgorithmError extends S.TaggedError<TilingAlgorithmError>()(
  "TilingAlgorithmError",
  {
    algorithm: S.String,
    message: S.String,
  },
) {}

export interface TilingAlgorithm {
  readonly id: string;
  readonly version: number;
  readonly run: (operation: TilingOperation) => Effect.Effect<TilingAnswer, TilingAlgorithmError>;
}

/**
 * Sync method bag authors write against. Optional methods become
 * `unsupported` answers; capability is no longer modeled as missing methods
 * on {@link TilingAlgorithm} itself.
 *
 * Only `close` and `focusInDirection` are required on this bag — the one
 * operation every algorithm must support to stay usable (a pane can always
 * be closed, and focus can always move) and the one query Window's
 * directional keys always need. Everything else is a capability an author
 * may omit; omitted methods answer `unsupported` and core falls through to
 * layout.ts.
 *
 * `ensureVisible` is the scroll-into-view transform folded into `close`,
 * `focusDirection`, and `reveal` answers. A split-tree algorithm omits it
 * (every pane is already on screen). A viewport-based algorithm (niri-style
 * scroll) supplies it so focus moves revise the layout's scroll position
 * in the same answer.
 */
export interface TilingAlgorithmMethods {
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
   *  directional-focus keys always need an answer, even a trivial one.
   *  Scroll/visibility changes travel via `ensureVisible` in the answer. */
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

  /**
   * Bring `paneId` fully into view, as a pure transform of `layout`.
   *
   * Folded into `close` / `focusDirection` / `reveal` answers by
   * {@link tilingAlgorithmFromMethods}. A split-tree algorithm has nothing
   * to do here: every pane it places is already on screen. A viewport-based
   * algorithm (a niri-style scroll strip) includes scroll position in its
   * layout, and moving focus onto a pane outside the current viewport
   * requires changing that position too.
   */
  ensureVisible?(layout: Layout, size: LayoutSize, paneId: string): Layout;
}

const reveal = (
  methods: TilingAlgorithmMethods,
  layout: Layout,
  size: LayoutSize,
  paneId: string,
): Layout => methods.ensureVisible?.(layout, size, paneId) ?? layout;

const dispatch = (methods: TilingAlgorithmMethods, operation: TilingOperation): TilingAnswer =>
  Match.valueTags(operation, {
    init: (op): TilingAnswer => ({ _tag: "ok", layout: methods.init(op.panes, op.size) }),
    close: (op): TilingAnswer => {
      let layout = methods.close(op.layout, op.size, op.pane);
      const focus = layout.focus;
      if (focus) layout = reveal(methods, layout, op.size, focus);
      return { _tag: "ok", layout, focus: layout.focus ?? null };
    },
    focusDirection: (op): TilingAnswer => {
      const focus = methods.focusInDirection(op.layout, op.size, op.from, op.direction);
      if (!focus) return { _tag: "ok", layout: op.layout, focus: null };
      const shown = reveal(methods, makeLayout({ ...op.layout, focus }), op.size, focus);
      return { _tag: "ok", layout: shown, focus };
    },
    reveal: (op): TilingAnswer => ({
      _tag: "ok",
      layout: reveal(methods, op.layout, op.size, op.pane),
    }),
    split: (op): TilingAnswer => {
      if (!methods.split) return { _tag: "unsupported" };
      return {
        _tag: "ok",
        layout: methods.split(op.layout, op.size, op.at, op.direction, op.pane),
      };
    },
    swap: (op): TilingAnswer => {
      if (!methods.swap) return { _tag: "unsupported" };
      return { _tag: "ok", layout: methods.swap(op.layout, op.size, op.from, op.step) };
    },
    preset: (op): TilingAnswer => {
      if (!methods.applyPreset) return { _tag: "unsupported" };
      return { _tag: "ok", layout: methods.applyPreset(op.layout, op.size, op.preset) };
    },
    resizeFocus: (op): TilingAnswer => {
      if (!methods.resizeFocus) return { _tag: "unsupported" };
      return {
        _tag: "ok",
        layout: methods.resizeFocus(op.layout, op.size, op.pane, op.direction, op.delta),
      };
    },
    resizeDivider: (op): TilingAnswer => {
      if (!methods.resizeDivider) return { _tag: "unsupported" };
      return {
        _tag: "ok",
        layout: methods.resizeDivider(op.layout, op.size, op.path, op.index, op.delta),
      };
    },
  });

/** Build a {@link TilingAlgorithm} from a method-shaped object.
 *  `Effect.try` only guards genuine bugs in author methods — never as a
 *  channel for declared refusals. */
export const tilingAlgorithmFromMethods = (methods: TilingAlgorithmMethods): TilingAlgorithm => ({
  id: methods.id,
  version: methods.version,
  run: (operation) =>
    Effect.try({
      try: () => dispatch(methods, operation),
      catch: (error) =>
        new TilingAlgorithmError({
          algorithm: methods.id,
          message: errorMessage(error) || "algorithm threw",
        }),
    }),
});

/**
 * Run one operation on an elected algorithm under {@link PLUGIN_TILING_TIMEOUT_MS}.
 * In-process algorithms (including default) answer immediately; the budget
 * only bites a hung plugin-host call.
 */
export const invokeTilingAlgorithm = (
  algorithm: TilingAlgorithm,
  operation: TilingOperation,
): Effect.Effect<TilingAnswer, TilingAlgorithmError> =>
  algorithm.run(operation).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(PLUGIN_TILING_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new TilingAlgorithmError({
            algorithm: algorithm.id,
            message: `timed out after ${PLUGIN_TILING_TIMEOUT_MS}ms`,
          }),
        ),
    }),
  );
