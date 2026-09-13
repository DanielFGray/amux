import {
  appendPane,
  closeLayout,
  layoutPanes,
  makeLayout,
  presetLayout,
  splitLayout,
  swapLayout,
  type Layout,
  type LayoutPreset,
  type PaneRef,
} from "./layout.ts";
import {
  paneInDirection,
  resizeDivider as resizeLayoutDivider,
  resizePane,
  type LayoutPath,
  type LayoutSize,
} from "./geometry.ts";
import type { Direction, SplitDirection } from "./window.ts";
import {
  TilingAlgorithmError,
  tilingAlgorithmFromMethods,
  type TilingAlgorithm,
  type TilingAlgorithmMethods,
} from "./tiling-algorithm.ts";
import { Effect } from "effect";

const defaultInit = (panes: readonly PaneRef[], _size: LayoutSize): Layout => {
  return panes.reduce((current, pane) => appendPane(current, pane), makeLayout({ root: null }));
};

export const defaultTilingMethods: TilingAlgorithmMethods = {
  id: "default",
  version: 1,

  init: defaultInit,

  close(layout: Layout, _size: LayoutSize, paneId: string): Layout {
    return closeLayout(layout, paneId);
  },

  focusInDirection(
    layout: Layout,
    size: LayoutSize,
    from: string,
    direction: Direction,
  ): string | null {
    return paneInDirection(layout, size, from, direction);
  },

  split(
    layout: Layout,
    _size: LayoutSize,
    at: string,
    direction: SplitDirection,
    pane: PaneRef,
  ): Layout {
    const index = layoutPanes(layout.root).findIndex((candidate) => candidate.id === at);
    return splitLayout(layout, index, direction, pane);
  },

  swap(layout: Layout, _size: LayoutSize, from: string, step: number): Layout {
    const panes = layoutPanes(layout.root);
    const index = panes.findIndex((pane) => pane.id === from);
    if (index === -1 || panes.length === 0) return layout;
    const target = (index + step + panes.length) % panes.length;
    return swapLayout(layout, index, target);
  },

  applyPreset(layout: Layout, _size: LayoutSize, preset: LayoutPreset): Layout {
    const result = presetLayout(layoutPanes(layout.root), preset, layout.focus);
    return makeLayout({
      ...result,
      floats: layout.floats,
      docks: layout.docks,
      dockSizes: layout.dockSizes,
    });
  },

  resizeFocus(
    layout: Layout,
    size: LayoutSize,
    paneId: string,
    direction: Direction,
    delta: number,
  ): Layout {
    return resizePane(layout, size, paneId, direction, delta);
  },

  resizeDivider(
    layout: Layout,
    size: LayoutSize,
    path: LayoutPath,
    index: number,
    delta: number,
  ): Layout {
    return resizeLayoutDivider(layout, size, path, index, delta);
  },
};

const fromMethods = tilingAlgorithmFromMethods(defaultTilingMethods);

/**
 * Default algorithm. `close` on a foreign container that would drop a column
 * refuses via {@link TilingAlgorithmError} — closeLayout would leave the
 * opaque arrangement (e.g. niri sizes/active) index-misaligned with children.
 */
export const defaultTilingAlgorithm: TilingAlgorithm = {
  id: defaultTilingMethods.id,
  version: defaultTilingMethods.version,
  run: (operation) => {
    if (operation._tag !== "close") return fromMethods.run(operation);
    return Effect.gen(function* () {
      const root = operation.layout.root;
      if (root?.type === "container") {
        const before = root.children.length;
        const next = closeLayout(operation.layout, operation.pane);
        const after =
          next.root?.type === "container"
            ? next.root.children.length
            : next.root === null
              ? 0
              : before;
        if (after !== before) {
          return yield* new TilingAlgorithmError({
            algorithm: defaultTilingMethods.id,
            message: `default tiling cannot close a column of foreign layout kind '${root.kind}'`,
          });
        }
      }
      return yield* fromMethods.run(operation);
    });
  },
};
