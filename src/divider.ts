import { Renderable, RGBA, type MouseEvent, type OptimizedBuffer, type RenderContext } from "@opentui/core"
import { runtime } from "./config.ts"

const IDLE = RGBA.fromInts(69, 71, 90, 255) // surface1
const FOCUS = RGBA.fromInts(137, 180, 250, 255) // blue
const HOVER = RGBA.fromInts(203, 166, 247, 255) // mauve
const BG = RGBA.fromInts(30, 30, 46, 255) // base

/** Smallest a pane may be squeezed to, so a divider can never be dragged past
 *  its neighbour and strand it at zero cells. */
const MIN_CELLS = 3

/**
 * Flex weights, tracked alongside the renderable.
 *
 * OpenTUI exposes `flexGrow` as a setter with no getter, so a weight cannot be
 * read back off a renderable once set. Splitting has to know the weight of the
 * pane it is dividing — otherwise a pane resized to a weight of 69 gets split
 * against a new pane weighted 1, and the newcomer renders as a sliver.
 */
const WEIGHTS = new WeakMap<object, number>()

export function getWeight(r: object): number {
  return WEIGHTS.get(r) ?? 1
}

/**
 * Flex direction, tracked the same way and for the same reason.
 *
 * `flexDirection` is another setter with no getter. Reading it back gives
 * `undefined`, so any `parent.flexDirection === "row"` test is silently always
 * false — which is how a pane came to draw its own border right next to the
 * divider that was already drawing one.
 */
const DIRECTIONS = new WeakMap<object, "row" | "column">()

export function getDirection(r: object): "row" | "column" {
  // Boxes are created row-wise unless told otherwise, matching yoga's default.
  return DIRECTIONS.get(r) ?? "row"
}

export function setDirection(r: object, direction: "row" | "column"): void {
  DIRECTIONS.set(r, direction)
  ;(r as { flexDirection: string }).flexDirection = direction
}

export function setWeight(r: object, weight: number): void {
  const w = Math.max(0.0001, weight)
  WEIGHTS.set(r, w)
  ;(r as { flexGrow: number; flexBasis: number }).flexGrow = w
  ;(r as { flexGrow: number; flexBasis: number }).flexBasis = 0
}

/**
 * The window's frame, as a query a divider can merge its own line against.
 *
 * A divider draws its line, its capped ends, and the tee one cell past an
 * uncapped end — and it asks the frame which lines run through each of those
 * cells before it picks a glyph. The answer is pure geometry, so a cell that
 * two dividers both claim gets the same glyph from either of them no matter
 * which draws last.
 */
export interface JunctionFrame {
  /** Whether a vertical frame line runs through or ends at the cell. */
  vertical(x: number, y: number): boolean
  /** Whether a horizontal frame line runs through or ends at the cell. */
  horizontal(x: number, y: number): boolean
}

const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8

/** Junction glyphs by which arms reach the cell: up, down, left, right. */
const JUNCTION: Record<number, string> = {
  [UP | DOWN]: "│",
  [LEFT | RIGHT]: "─",
  [DOWN | LEFT | RIGHT]: "┬",
  [UP | LEFT | RIGHT]: "┴",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [UP | DOWN | LEFT | RIGHT]: "┼",
  [UP | RIGHT]: "└",
  [UP | LEFT]: "┘",
  [DOWN | RIGHT]: "┌",
  [DOWN | LEFT]: "┐",
}

/**
 * The glyph a cell wants, given the arms that reach it.
 *
 * The arms come from the divider's own continuation along its axis plus the
 * frame's lines on the perpendicular sides. A cell on a divider's line always
 * keeps its own axis (the line runs through it); an end cell loses the arm
 * pointing past the cap, so the perpendicular frame line turns it into a tee.
 * A cell no arms explain (a lone line ending in nothing) falls back to a plain
 * dash so the frame can never show a hole where a border belongs.
 */
function junctionGlyph(
  vertical: boolean,
  index: number | null,
  length: number,
  frame: JunctionFrame,
  x: number,
  y: number,
): string {
  let arms: number
  if (vertical) {
    const up = (index !== null && index > 0) || frame.vertical(x, y - 1)
    const down = (index !== null && index < length - 1) || frame.vertical(x, y + 1)
    const left = frame.horizontal(x - 1, y)
    const right = frame.horizontal(x + 1, y)
    arms = (up ? UP : 0) | (down ? DOWN : 0) | (left ? LEFT : 0) | (right ? RIGHT : 0)
  } else {
    const left = (index !== null && index > 0) || frame.horizontal(x - 1, y)
    const right = (index !== null && index < length - 1) || frame.horizontal(x + 1, y)
    const up = frame.vertical(x, y - 1)
    const down = frame.vertical(x, y + 1)
    arms = (up ? UP : 0) | (down ? DOWN : 0) | (left ? LEFT : 0) | (right ? RIGHT : 0)
  }
  return JUNCTION[arms] ?? (arms & (UP | DOWN) ? "│" : "─")
}

/**
 * The draggable border between two panes.
 *
 * A real renderable rather than a hit-tested edge of a pane: OpenTUI resolves
 * the drag target from its own hit grid, so "am I on the divider" needs no rect
 * math of ours and cannot drift from what was drawn — the same property that
 * makes clicking panes reliable through arbitrary nesting.
 *
 * Resizing works on the neighbours' flex weights. Panes are laid out with
 * flexBasis 0 and a flexGrow weight, so setting the two weights to the desired
 * cell counts gives exactly that split of their shared space.
 */
export class Divider extends Renderable {
  /** Axis of the parent split: "row" means a vertical bar between left/right
   *  neighbours, "column" a horizontal one between top/bottom. */
  readonly axis: "row" | "column"
  /** Whether this divider is part of a pane frame and should finish its ends
   *  with a junction. The sidebar handle is a bare line and sets this false. */
  tees = false
  /** Whether each end meets the window's outer border rather than another
   *  divider. Set by Window, which is the only thing that knows the tree. */
  capStart = false
  capEnd = false
  /** True when the divider is the frame's outer edge — the sidebar handle,
   *  which is the left border of the panes beside it. Nothing is drawn on its
   *  far side, so its ends are corners rather than tees. */
  outer = false
  /** True when the focused pane is on one side of this divider — the shared
   *  border is the focused pane's border too, so it highlights with it. */
  adjacentToFocus = false
  /**
   * The frame this divider is a segment of, asked once per frame for every
   * cell it draws. Set by Window, which is the only thing that knows the tree;
   * a bare divider (the sidebar handle) leaves it unset and falls back to
   * drawing a plain line with corner ends.
   */
  junction?: () => JunctionFrame
  #hovered = false
  #dragging = false
  #paneGap = 0

  /**
   * Where the drag goes instead of the neighbours' flex weights.
   *
   * The sidebar edge is the same gesture with a different destination: the
   * sidebar has an explicit width rather than a weight, and its neighbour is the
   * whole pane area. Handing that case a callback reuses the capture-on-press
   * handling, which is the part that is actually fiddly.
   */
  onDrag?: (delta: number) => void

  /** Fired after a drag has actually moved the neighbours' weights. Distinct
   *  from onDrag, which *replaces* that resize; this only reports it, so a
   *  window can notice its layout no longer matches the preset it was built
   *  from without reimplementing the resize. */
  onResized?: () => void

  constructor(
    ctx: RenderContext,
    options: { id: string; axis: "row" | "column"; onDrag?: (delta: number) => void },
  ) {
    super(ctx, {
      ...options,
      flexShrink: 0,
      flexGrow: 0,
      ...(options.axis === "row" ? { width: 1 } : { height: 1 }),
    })
    this.axis = options.axis
    this.onDrag = options.onDrag
    this.setPaneGap(runtime.paneGap)
  }

  /** Update the target's width when the appearance setting changes. */
  setPaneGap(gap: number): void {
    this.#paneGap = Math.max(0, Math.floor(gap))
    if (this.axis === "row") this.width = this.#paneGap || 1
    else this.height = this.#paneGap || 1
  }

  protected override onMouseEvent(event: MouseEvent): void {
    switch (event.type) {
      case "over":
        this.#hovered = true
        this.requestRender()
        return
      case "out":
        this.#hovered = false
        this.requestRender()
        return
      case "down":
        this.#dragging = true
        // Claim the pointer now, rather than letting OpenTUI decide on the
        // first drag event. It captures whatever the pointer is over at that
        // moment, and a divider is one cell wide — move quickly and the first
        // drag already resolves to the pane next door, which then swallows the
        // rest of the gesture. Capturing on the press makes the drag work at
        // any speed. Routing to a captured renderable happens before OpenTUI's
        // own capture bookkeeping, so this survives the rest of the dispatch.
        ;(this._ctx as unknown as { setCapturedRenderable?: (r: unknown) => void })
          .setCapturedRenderable?.(this)
        event.stopPropagation()
        return
      case "up":
      case "drag-end":
        this.#dragging = false
        event.stopPropagation()
        return
      case "drag": {
        // Where the pointer is relative to where the divider currently sits.
        // Self-correcting, so a dropped event cannot accumulate drift the way
        // a running total of per-event deltas would.
        const delta = this.axis === "row" ? event.x - this.x : event.y - this.y
        if (delta !== 0) {
          if (this.onDrag) this.onDrag(delta)
          else this.#resize(delta)
          this.requestRender()
        }
        event.stopPropagation()
        return
      }
    }
  }

  #resize(delta: number) {
    const parent = this.parent
    if (!parent) return
    const siblings = parent.getChildren()
    const index = siblings.indexOf(this)
    const before = siblings[index - 1]
    const after = siblings[index + 1]
    if (!before || !after) return

    const size = (r: any) => (this.axis === "row" ? r.width : r.height)
    const total = size(before) + size(after)
    const next = Math.max(MIN_CELLS, Math.min(total - MIN_CELLS, size(before) + delta))
    if (next === size(before)) return

    // Weights are proportional, so using cell counts directly gives the split
    // we want without needing to know the container's size.
    setWeight(before, next)
    setWeight(after, total - next)
    this.onResized?.()
    this.requestRender()
  }

  /**
   * A line, plus a junction at each end.
   *
   * Every cell is resolved against the window's frame geometry, not painted
   * from a hardcoded tee. The arms of a junction cell are the frame lines that
   * reach it: the divider's own continuation along its axis, and whatever the
   * frame has on the perpendicular sides. So the glyph a cell shows is what
   * the geometry demands — a tee where one seam meets another, a ┼ where two
   * seams meet a crossing seam at the same cell — regardless of which divider
   * draws last. Draw order is exactly what made the old hardcoded tees wrong:
   * a perpendicular divider's plain line would overwrite one of the two tees
   * that land on the same cell, leaving whichever came last instead of the ┼.
   *
   * A capped end's junction is its own first/last cell. An uncapped end tees
   * one cell *outside* the divider, into the perpendicular line that runs
   * there (another divider, a pane border, or the sidebar seam) — that cell
   * belongs to that other line, and it draws the same merged glyph from the
   * same geometry, so the correction survives whichever wrote first.
   *
   * The sidebar handle is a bare line with corner ends: nothing shares its
   * cells, so it keeps the simple path.
   */
  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.#paneGap > 0) {
      for (let y = this.y; y < this.y + this.height; y++) {
        for (let x = this.x; x < this.x + this.width; x++) {
          buffer.setCell(x, y, " ", IDLE, BG)
        }
      }
      return
    }
    const fg = this.#hovered || this.#dragging ? HOVER : this.adjacentToFocus ? FOCUS : IDLE
    const vertical = this.axis === "row"
    const length = vertical ? this.height : this.width
    const at = (i: number) =>
      vertical
        ? ([this.x, this.y + i] as const)
        : ([this.x + i, this.y] as const)

    const frame = this.junction?.()
    if (!frame || this.outer) {
      for (let i = 0; i < length; i++) buffer.setCell(...at(i), vertical ? "│" : "─", fg, BG)
      if (!this.tees) return
      const [sx, sy] = at(this.capStart ? 0 : -1)
      buffer.setCell(sx, sy, this.outer ? "┌" : vertical ? "┬" : "├", fg, BG)
      const [ex, ey] = at(this.capEnd ? length - 1 : length)
      buffer.setCell(ex, ey, this.outer ? (vertical ? "└" : "┐") : vertical ? "┴" : "┤", fg, BG)
      return
    }

    for (let i = 0; i < length; i++) {
      const [x, y] = at(i)
      buffer.setCell(x, y, junctionGlyph(vertical, i, length, frame, x, y), fg, BG)
    }
    if (!this.tees) return
    if (!this.capStart) {
      const [x, y] = at(-1)
      buffer.setCell(x, y, junctionGlyph(vertical, null, length, frame, x, y), fg, BG)
    }
    if (!this.capEnd) {
      const [x, y] = at(length)
      buffer.setCell(x, y, junctionGlyph(vertical, null, length, frame, x, y), fg, BG)
    }
  }
}
