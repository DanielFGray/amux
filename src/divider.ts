import { Renderable, RGBA, type MouseEvent, type OptimizedBuffer, type RenderContext } from "@opentui/core"

const IDLE = RGBA.fromInts(69, 71, 90, 255) // surface1
const HOVER = RGBA.fromInts(137, 180, 250, 255) // blue
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

export function setWeight(r: object, weight: number): void {
  const w = Math.max(0.0001, weight)
  WEIGHTS.set(r, w)
  ;(r as { flexGrow: number; flexBasis: number }).flexGrow = w
  ;(r as { flexGrow: number; flexBasis: number }).flexBasis = 0
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
  #hovered = false
  #dragging = false

  constructor(ctx: RenderContext, options: { id: string; axis: "row" | "column" }) {
    super(ctx, {
      ...options,
      flexShrink: 0,
      flexGrow: 0,
      ...(options.axis === "row" ? { width: 1 } : { height: 1 }),
    })
    this.axis = options.axis
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
        if (delta !== 0) this.#resize(delta)
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
    this.requestRender()
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const fg = this.#hovered || this.#dragging ? HOVER : IDLE
    const glyph = this.axis === "row" ? "│" : "─"
    if (this.axis === "row") {
      for (let y = 0; y < this.height; y++) buffer.setCell(this.x, this.y + y, glyph, fg, BG)
    } else {
      for (let x = 0; x < this.width; x++) buffer.setCell(this.x + x, this.y, glyph, fg, BG)
    }
  }
}
