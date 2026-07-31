import { BoxRenderable, type RenderContext, type Renderable } from "@opentui/core"
import { TerminalPane } from "./pane.ts"
import { Agent } from "./agent.ts"
import { rollUp } from "./space.ts"
import { Divider, getWeight, setWeight, getDirection, setDirection } from "./divider.ts"

export type SplitDirection = "row" | "column"

/** Which way `focusDirection` looks. Screen directions, not tree axes. */
export type Direction = "left" | "right" | "up" | "down"

let nextId = 0

/**
 * Chrome the window does not draw itself.
 *
 * With the sidebar open, the sidebar's drag handle *is* the pane frame's left
 * border — one line between the tree and the panes rather than two adjacent
 * ones. The panes and their dividers then have to leave that column alone, and
 * they need telling, because nothing inside a window can see the sidebar.
 */
export const frame = { externalLeft: false }

/**
 * A window: one split tree of panes, and the agents behind them.
 *
 * The middle level of the tmux hierarchy — a space holds windows, a window
 * holds panes. Agents belong to the window they were started in, so closing a
 * window is what ends its agents rather than merely hiding them.
 *
 * Layout itself is delegated to opentui: every split is a flex Box, so yoga
 * computes the geometry and — because hit-testing is a byproduct of rendering —
 * clicking and hovering keep working through arbitrary nesting with no
 * coordinate math of our own.
 */
export class Window {
  readonly root: BoxRenderable
  /** Stable 1-based number for ^a 1..9, kept even as siblings come and go. */
  readonly number: number
  /** Set by rename; otherwise the window shows what it is running. */
  customName: string | null = null
  #ctx: RenderContext
  #panes: TerminalPane[] = []
  #agents: Agent[] = []
  #focused: TerminalPane | null = null
  #shell: string[]
  /** Directory agents spawn in — the owning space's attached directory. */
  #cwd: string | undefined
  onChange?: () => void
  /** Fired after an agent's process exits and its views have been closed. The
   *  app uses it to decide what to show next; it is deliberately not the same
   *  as "a pane closed", because closing a view by hand is a detach, not an end. */
  onAgentExit?: (agent: Agent) => void

  constructor(ctx: RenderContext, shell: string[], cwd: string | undefined, number: number) {
    this.#ctx = ctx
    this.#shell = shell
    this.#cwd = cwd
    this.number = number
    this.root = new BoxRenderable(ctx, {
      id: `window-${number}-${nextId++}`,
      flexDirection: "row",
      flexGrow: 1,
    })
  }

  get panes(): readonly TerminalPane[] {
    return this.#panes
  }

  /** Tab label: the given name, else whatever the focused pane is showing —
   *  the same "what is this actually running" cue tmux gives a window. */
  get title(): string {
    if (this.customName) return this.customName
    const agent = this.#focused?.agent ?? this.#agents[0]
    return agent?.title ?? "window"
  }

  /** Every agent, including ones no pane is currently showing. This is what
   *  the sidebar lists. */
  get agents(): readonly Agent[] {
    return this.#agents
  }

  /** Most urgent state among this window's agents, for its sidebar row. */
  get state() {
    return rollUp(this.#agents)
  }

  /** Agents with no viewport open — running, but off-screen. */
  get detached(): Agent[] {
    return this.#agents.filter((a) => a.viewers === 0)
  }

  /** Start an agent without opening a view onto it. The name defaults to the
   *  command being run — "zsh", not a generic "shell". */
  spawn(name?: string, cmd = this.#shell, cwd = this.#cwd): Agent {
    const agent = new Agent({ name, cmd, cwd })
    agent.onOutput = () => {
      for (const p of this.#panes) if (p.agent === agent) p.invalidate()
      this.onChange?.()
    }
    agent.onExit = () => {
      // The process is gone, so its viewports are dead weight — close them and
      // give the space back to the surviving panes, the way tmux does.
      // The agent itself stays: it keeps its terminal, so it remains in the
      // sidebar as "done" and revealing it again still shows its final output.
      for (const pane of [...this.#panes]) if (pane.agent === agent) this.close(pane)
      this.onChange?.()
      this.onAgentExit?.(agent)
      this.#ctx.requestRender()
    }
    agent.onScroll = () => {
      // Scrollback state (scrollBy/scrollToBottom) is user-driven, so it has
      // no output to invalidate panes — but the sidebar's ▲ must repaint.
      this.onChange?.()
    }
    this.#agents.push(agent)
    this.onChange?.()
    return agent
  }

  /** Permanently stop an agent and close any views of it. */
  killAgent(agent: Agent) {
    for (const p of [...this.#panes]) if (p.agent === agent) this.close(p)
    const i = this.#agents.indexOf(agent)
    if (i !== -1) this.#agents.splice(i, 1)
    agent.dispose()
    this.onChange?.()
    this.#ctx.requestRender()
  }

  get focused() {
    return this.#focused
  }

  #makeDivider(direction: SplitDirection): Divider {
    const divider = new Divider(this.#ctx, { id: `divider-${nextId++}`, axis: direction })
    // It is a segment of the pane frame, so its ends finish as junctions.
    divider.tees = true
    return divider
  }

  #makePane(agent: Agent): TerminalPane {
    const pane = new TerminalPane(this.#ctx, {
      id: `pane-${nextId++}`,
      agent,
    })
    setWeight(pane, 1)
    pane.onFocusRequest = (p) => this.focus(p)
    this.#panes.push(pane)
    return pane
  }

  /** Seed the workspace with a single agent and a view onto it. */
  init(name?: string): TerminalPane {
    const pane = this.#makePane(this.spawn(name))
    this.root.add(pane)
    this.focus(pane)
    return pane
  }

  focus(pane: TerminalPane) {
    this.#focused = pane
    for (const p of this.#panes) p.active = p === pane
    this.#refreshChrome()
    this.onChange?.()
    this.#ctx.requestRender()
  }

  /**
   * Is there anything on the given side of this node, anywhere up the tree?
   *
   * Siblings are always separated by a divider, so "a sibling precedes me on
   * this axis" is the same question as "is a divider drawn on that side of me".
   * Walking up matters: a pane can be flush against the left of its own split
   * box while that box sits to the right of a divider two levels up.
   */
  #hasNeighbour(node: Renderable, axis: SplitDirection, direction: -1 | 1): boolean {
    let current: Renderable = node
    while (current !== this.root) {
      const parent = current.parent as BoxRenderable | null
      if (!parent) return false
      if (getDirection(parent) === axis) {
        const siblings = parent.getChildren()
        const i = siblings.indexOf(current)
        if (direction < 0 ? i > 0 : i < siblings.length - 1) return true
      }
      current = parent
    }
    return false
  }

  /**
   * Recompute who draws which border, and which divider is next to the focus.
   *
   * Every pane draws the sides that face the window's outer edge; a side facing
   * another pane belongs to the divider between them, so the frame stays one
   * cell thick at every seam.
   */
  #refreshChrome() {
    for (const pane of this.#panes) {
      pane.edges = {
        // frame.externalLeft: the sidebar handle owns that column, so no pane
        // draws a left border while the sidebar is open.
        left: !frame.externalLeft && !this.#hasNeighbour(pane, "row", -1),
        right: !this.#hasNeighbour(pane, "row", 1),
        top: !this.#hasNeighbour(pane, "column", -1),
        bottom: !this.#hasNeighbour(pane, "column", 1),
      }
    }
    for (const divider of this.#dividers()) {
      // A divider's ends meet the window's outer border exactly where it has no
      // neighbour of its own across the perpendicular axis.
      const cross: SplitDirection = divider.axis === "row" ? "column" : "row"
      // A horizontal divider running to the window's left edge no longer ends
      // there: the sidebar handle is one column further out, and an uncapped end
      // is exactly the "draw the tee one cell outside me" case, which lands the
      // junction in that handle's column.
      divider.capStart =
        !this.#hasNeighbour(divider, cross, -1) && !(frame.externalLeft && cross === "row")
      divider.capEnd = !this.#hasNeighbour(divider, cross, 1)
      divider.adjacentToFocus = this.#focused ? this.#touches(divider, this.#focused) : false
    }
  }

  /** Recompute borders after something outside the window changed — the only
   *  case being the sidebar opening or closing. */
  refreshChrome() {
    this.#refreshChrome()
    this.#ctx.requestRender()
  }

  /** True when the focused pane sits against the window's left edge, so the
   *  sidebar handle is that pane's border and should highlight with it. */
  get focusAtLeftEdge(): boolean {
    return this.#focused ? !this.#hasNeighbour(this.#focused, "row", -1) : false
  }

  #dividers(root: Renderable = this.root, out: Divider[] = []): Divider[] {
    for (const child of root.getChildren()) {
      if (child instanceof Divider) out.push(child)
      else if (!(child instanceof TerminalPane)) this.#dividers(child, out)
    }
    return out
  }

  /** True when the pane sits immediately on either side of the divider — the
   *  shared border is that pane's border too, so it highlights with it. */
  #touches(divider: Divider, pane: TerminalPane): boolean {
    const parent = divider.parent as BoxRenderable | null
    if (!parent) return false
    const siblings = parent.getChildren()
    const i = siblings.indexOf(divider)
    const contains = (node: Renderable | undefined): boolean => {
      if (!node) return false
      if (node === pane) return true
      if (node instanceof TerminalPane) return false
      return node.getChildren().some(contains)
    }
    return contains(siblings[i - 1]) || contains(siblings[i + 1])
  }

  focusNext(step = 1) {
    if (!this.#panes.length) return
    const i = this.#focused ? this.#panes.indexOf(this.#focused) : -1
    const next = (i + step + this.#panes.length) % this.#panes.length
    this.focus(this.#panes[next]!)
  }

  /**
   * Move focus to the nearest pane in a screen direction.
   *
   * Geometric rather than structural, the way tmux's select-pane -LDUR is: the
   * split tree says a pane's *sibling* is to the right, but with nesting the
   * pane visually to the right is often two levels away, and walking the tree
   * gets that wrong in exactly the layouts where it matters.
   *
   * Candidates are panes wholly on the requested side that overlap this pane on
   * the perpendicular axis; the nearest wins, and the widest overlap breaks a
   * tie — so leaving a tall pane for a column of short ones lands on the one you
   * are actually looking at rather than the first in the list.
   */
  focusDirection(direction: Direction) {
    const from = this.#focused
    if (!from || this.#panes.length < 2) return
    const horizontal = direction === "left" || direction === "right"
    const backwards = direction === "left" || direction === "up"

    const start = (p: TerminalPane) => (horizontal ? p.x : p.y)
    const end = (p: TerminalPane) => (horizontal ? p.x + p.width : p.y + p.height)
    const crossStart = (p: TerminalPane) => (horizontal ? p.y : p.x)
    const crossEnd = (p: TerminalPane) => (horizontal ? p.y + p.height : p.x + p.width)

    let best: TerminalPane | null = null
    let bestGap = Infinity
    let bestOverlap = 0
    for (const pane of this.#panes) {
      if (pane === from) continue
      const gap = backwards ? start(from) - end(pane) : start(pane) - end(from)
      // Negative means the two overlap on this axis: not on that side at all.
      if (gap < 0 || gap > bestGap) continue
      const overlap =
        Math.min(crossEnd(from), crossEnd(pane)) - Math.max(crossStart(from), crossStart(pane))
      if (overlap <= 0) continue
      if (gap < bestGap || overlap > bestOverlap) {
        best = pane
        bestGap = gap
        bestOverlap = overlap
      }
    }
    if (best) this.focus(best)
  }

  /**
   * Exchange the focused pane with its neighbour in pane order, tmux's `{`/`}`.
   *
   * The panes trade places in the tree while each *slot* keeps its size, so a
   * swap rearranges the layout's contents without reshaping it. Focus travels
   * with the pane, which is what makes repeated presses walk it along.
   */
  swap(step: 1 | -1) {
    const from = this.#focused
    if (!from || this.#panes.length < 2) return
    const i = this.#panes.indexOf(from)
    const j = (i + step + this.#panes.length) % this.#panes.length
    const to = this.#panes[j]!

    const parentA = from.parent as BoxRenderable | null
    const parentB = to.parent as BoxRenderable | null
    if (!parentA || !parentB) return

    const weightA = getWeight(from)
    const weightB = getWeight(to)

    if (parentA === parentB) {
      const children = parentA.getChildren()
      const [firstAt, secondAt] = [children.indexOf(from), children.indexOf(to)].sort((a, b) => a - b)
      const first = children[firstAt!] as Renderable
      const second = children[secondAt!] as Renderable
      // Remove the later one first: taking the earlier one out would shift the
      // index we still need.
      parentA.remove(second)
      parentA.remove(first)
      parentA.add(second, firstAt!)
      parentA.add(first, secondAt!)
    } else {
      const atA = parentA.getChildren().indexOf(from)
      const atB = parentB.getChildren().indexOf(to)
      parentA.remove(from)
      parentB.remove(to)
      parentA.add(to, atA)
      parentB.add(from, atB)
    }

    setWeight(from, weightB)
    setWeight(to, weightA)
    // Keep pane order matching the layout, so another press keeps going the
    // same way instead of swapping back.
    this.#panes[i] = to
    this.#panes[j] = from
    this.#refreshChrome()
    this.focus(from)
  }

  /**
   * Split the focused pane, reusing its slot.
   *
   * If the parent already runs along the requested axis the new pane is just
   * inserted as a sibling; otherwise the pane is swapped for a nested Box so
   * the tree stays a proper h/v alternation instead of a flat list.
   */
  split(direction: SplitDirection, agent?: Agent, name?: string): TerminalPane | null {
    const target = this.#focused
    if (!target) {
      if (!agent) return this.init(name)
      const pane = this.#makePane(agent)
      this.root.add(pane)
      this.focus(pane)
      return pane
    }

    const parent = target.parent as BoxRenderable | null
    if (!parent) return null

    const pane = this.#makePane(agent ?? this.spawn(name))

    // Every sibling pair is separated by a draggable divider, which is also
    // the visible border between panes.
    // The newcomer takes half of what it is splitting, tmux-style. Splitting a
    // pane that was resized to a weight of 69 against a fresh weight of 1 would
    // otherwise leave the new pane a sliver a cell or two wide.
    const share = getWeight(target) / 2

    if (getDirection(parent) === direction && parent !== this.root) {
      const at = parent.getChildren().indexOf(target) + 1
      setWeight(target, share)
      setWeight(pane, share)
      parent.add(this.#makeDivider(direction), at)
      parent.add(pane, at + 1)
    } else if (parent === this.root && parent.getChildrenCount() === 1) {
      // Root still holds a single pane, so it can simply adopt the axis.
      setDirection(parent, direction)
      setWeight(target, share)
      setWeight(pane, share)
      parent.add(this.#makeDivider(direction))
      parent.add(pane)
    } else {
      const index = parent.getChildren().indexOf(target)
      const box = new BoxRenderable(this.#ctx, { id: `split-${nextId++}` })
      setDirection(box, direction)
      // The box stands in for the pane it replaces, so it inherits its weight;
      // inside it, the two panes start even.
      setWeight(box, getWeight(target))
      parent.remove(target)
      setWeight(target, 1)
      setWeight(pane, 1)
      box.add(target)
      box.add(this.#makeDivider(direction))
      box.add(pane)
      parent.add(box, index)
    }

    this.focus(pane)
    return pane
  }

  /** Open an existing agent in a new split — the way a detached agent gets a
   *  viewport back. */
  reveal(agent: Agent): TerminalPane | null {
    const existing = this.#panes.find((p) => p.agent === agent)
    if (existing) {
      this.focus(existing)
      return existing
    }
    return this.split("row", agent)
  }

  /** Close a pane and collapse any split box left holding a single child. */
  close(pane: TerminalPane) {
    const i = this.#panes.indexOf(pane)
    if (i === -1) return
    this.#panes.splice(i, 1)

    const parent = pane.parent as BoxRenderable | null
    if (parent) {
      // Take the divider that separated this pane from a neighbour with it,
      // or the tree is left with a border floating against nothing.
      const siblings = parent.getChildren()
      const at = siblings.indexOf(pane)
      const divider = (siblings[at + 1] ?? siblings[at - 1]) as Renderable | undefined
      if (divider instanceof Divider) {
        parent.remove(divider)
        divider.destroy()
      }
      parent.remove(pane)
    }
    pane.destroyRecursively()

    if (parent && parent !== this.root && parent.getChildrenCount() === 1) {
      const [only] = parent.getChildren()
      const grand = parent.parent as BoxRenderable | null
      if (grand && only) {
        const index = grand.getChildren().indexOf(parent)
        parent.remove(only)
        grand.remove(parent)
        grand.add(only as Renderable, index)
        parent.destroy()
      }
    }

    if (this.#focused === pane) {
      this.#focused = null
      if (this.#panes.length) this.focus(this.#panes[Math.min(i, this.#panes.length - 1)]!)
      else this.onChange?.()
    }
    // Survivors have gained edges the closed pane's divider used to cover, and
    // a collapsed split box changes what is adjacent to what.
    this.#refreshChrome()
    this.#ctx.requestRender()
  }

  /** Kill every agent and free its terminal. Used by app shutdown so no child
   *  process is orphaned; idempotent, safe to call from an exit path.
   *
   *  Panes come down FIRST. A pane renders straight out of its agent's
   *  terminal, so freeing the terminal under a still-mounted pane is a
   *  use-after-free into ghostty — a segfault on the next frame, not an
   *  exception. */
  disposeAll() {
    for (const pane of [...this.#panes]) this.close(pane)
    for (const agent of [...this.#agents]) agent.dispose()
    this.#agents.length = 0
  }
}
