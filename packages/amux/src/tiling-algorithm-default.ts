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
  paneHasNeighbour,
  paneInDirection,
  resizeDivider as resizeLayoutDivider,
  resizePane,
  type LayoutPath,
  type LayoutSize,
} from "./geometry.ts";
import type { Direction, SplitDirection } from "./window.ts";
import type { TilingAlgorithm } from "./tiling-algorithm.ts";

const defaultInit = (panes: readonly PaneRef[], _size: LayoutSize): Layout => {
  return panes.reduce((current, pane) => appendPane(current, pane), makeLayout({ root: null }));
};

export const defaultTilingAlgorithm: TilingAlgorithm = {
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

  hasNeighbour(
    layout: Layout,
    _size: LayoutSize,
    paneId: string,
    axis: SplitDirection,
    side: -1 | 1,
  ): boolean {
    return paneHasNeighbour(layout, paneId, axis, side);
  },
};
