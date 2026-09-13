import { BoxRenderable, createTimeline, type Timeline, type Renderable } from "@opentui/core";
import {
  definePlugin,
  OptionsTag,
  makeLayout,
  registerEnumValue,
  registerLayoutKindRenderer,
  type LayoutKindRenderer,
  type PluginDefinition,
} from "@danielfgray/amux";
import { Effect } from "effect";
import {
  COLUMN_GAP,
  niriTilingAlgorithm,
  niriTilingMethods,
  transferColumnCells,
  type NiriArrangement,
} from "./niri.ts";

let nextId = 0;

/** Spike: client-side view-offset tween. The model jumps instantly; this is
 *  only the painted translate. Survives Window#mount remounts by keeping
 *  `displayOffset` in module state and re-binding `liveContent` each build.
 *  Cite: opentui ScrollBox (`translateX`) + niri `animate_view_offset_*`. */
const SCROLL_MS = 220;
const SNAP_CELLS = 1;

let displayOffset = 0;
let targetOffset = 0;
let scrollTimeline: Timeline | null = null;
let liveContent: BoxRenderable | null = null;
let requestPaint: (() => void) | null = null;

/** The one live scroll strip — niri only roots one. Module state (not a
 *  WeakMap keyed by layout node) so divider echo and project-time patches
 *  still find it after Window replaces `#layout.root` with a fresh object. */
type LiveStrip = {
  sizes: number[];
  columns: Renderable[];
  content: BoxRenderable;
};
let liveStrip: LiveStrip | null = null;

function applyOffset(content: BoxRenderable, offset: number): void {
  // translateX, not `left`: Yoga left forces a layout pass and can desync the
  // hit grid from what is painted while the strip is mid-tween. OpenTUI's own
  // ScrollBox scrolls the same way.
  content.left = 0;
  content.translateX = -Math.round(offset);
}

function startTween(requestRender: () => void, next: number): void {
  targetOffset = next;
  const from = displayOffset;
  if (Math.abs(next - from) <= SNAP_CELLS) {
    displayOffset = next;
    if (liveContent) applyOffset(liveContent, next);
    return;
  }

  const proxy = { offset: from };
  const tl = createTimeline({ duration: SCROLL_MS, autoplay: true });
  scrollTimeline = tl;
  tl.once(proxy, {
    offset: next,
    duration: SCROLL_MS,
    ease: "inOutQuad",
    onUpdate: () => {
      if (scrollTimeline !== tl) return;
      displayOffset = proxy.offset;
      if (!liveContent) return;
      applyOffset(liveContent, displayOffset);
      requestRender();
    },
    onComplete: () => {
      if (scrollTimeline !== tl) return;
      displayOffset = next;
      if (liveContent) applyOffset(liveContent, next);
      scrollTimeline = null;
    },
  });
}

function paintStripWidths(strip: LiveStrip): void {
  const total =
    strip.sizes.reduce((sum, size) => sum + size, 0) +
    COLUMN_GAP * Math.max(0, strip.sizes.length - 1);
  strip.content.width = total;
  strip.columns.forEach((child, i) => {
    const width = strip.sizes[i] ?? 0;
    child.width = width;
    child.flexBasis = width;
  });
  requestPaint?.();
}

// A scroll container materializes as opentui's own clip-plus-absolute-offset
// pattern rather than a divided flex row: its children carry an intrinsic
// size along the scroll axis (arrangement.sizes) instead of a
// sibling-relative weight, so there is nothing for core's divider bookkeeping
// to do here — see docs/adr/0004-arrangement-kind-is-an-open-registry.md.
//
// Column children arrive from Window#mount already weight-flexed (tile() sets
// flexGrow). Pin them to their intrinsic width with flexGrow/Shrink 0 so Yoga
// doesn't redistribute leftover viewport space and fight the scroll offset —
// that redistribution was the main visual "jank" against niri's strip, where
// opening a window never resizes its neighbours.
const scrollRenderer: LayoutKindRenderer = {
  render(ctx, node, children, chrome) {
    const { offset, sizes } = node.arrangement as NiriArrangement;
    const viewport = new BoxRenderable(ctx, { id: `scroll-${nextId++}` });
    viewport.flexGrow = Math.max(0.0001, node.weight);
    viewport.flexBasis = 0;
    viewport.overflow = "hidden";
    const content = new BoxRenderable(ctx, { id: `scroll-content-${nextId++}` });
    content.flexDirection = "row";
    content.position = "absolute";
    // Dividers occupy the seam cell (same as a split's fill()); Yoga gap would
    // double-count against COLUMN_GAP in the model.
    content.gap = 0;
    const total =
      sizes.reduce((sum, size) => sum + size, 0) + COLUMN_GAP * Math.max(0, sizes.length - 1);
    requestPaint = () => ctx.requestRender();
    liveContent = content;
    applyOffset(content, displayOffset);
    content.top = 0;
    content.width = total;
    content.height = "100%";
    if (offset !== targetOffset) {
      startTween(() => ctx.requestRender(), offset);
    } else if (Math.abs(displayOffset - offset) <= SNAP_CELLS) {
      displayOffset = offset;
      applyOffset(content, offset);
    }
    const columns: Renderable[] = [];
    children.forEach((child, i) => {
      if (i > 0 && chrome) content.add(chrome.makeDivider(i - 1));
      const width = sizes[i] ?? 0;
      child.width = width;
      child.height = "100%";
      child.flexGrow = 0;
      child.flexShrink = 0;
      child.flexBasis = width;
      content.add(child);
      columns.push(child);
    });
    liveStrip = { sizes: [...sizes], columns, content };
    viewport.add(content);
    return viewport;
  },

  patchDivider(_node, index, delta) {
    if (!liveStrip) return false;
    const next = transferColumnCells(liveStrip.sizes, index, delta);
    if (!next) return true;
    liveStrip.sizes = next;
    paintStripWidths(liveStrip);
    return true;
  },

  applyArrangement(node) {
    if (!liveStrip) return false;
    const { sizes, offset } = node.arrangement as NiriArrangement;
    if (sizes.length !== liveStrip.columns.length) return false;
    liveStrip.sizes = [...sizes];
    paintStripWidths(liveStrip);
    liveContent = liveStrip.content;
    if (offset !== targetOffset) {
      startTween(() => requestPaint?.(), offset);
    } else if (Math.abs(displayOffset - offset) <= SNAP_CELLS) {
      displayOffset = offset;
      applyOffset(liveStrip.content, offset);
    }
    return true;
  },

  hasNeighbour(node, paneId, axis, side) {
    return niriTilingMethods.hasNeighbour(
      makeLayout({ root: node }),
      { cols: 1, rows: 1 },
      paneId,
      axis,
      side,
    );
  },
};

export const niriPlugin: PluginDefinition = definePlugin({
  id: "amux.tiling.niri",
  inject: [OptionsTag],
  effect: () =>
    Effect.gen(function* () {
      yield* registerEnumValue({
        option: "behaviour.tilingAlgorithm",
        value: niriTilingAlgorithm.id,
      });
      yield* registerLayoutKindRenderer("scroll", scrollRenderer);
    }),
});

export default niriPlugin;
