import { BoxRenderable, type RenderContext, type Renderable } from "@opentui/core"
import { TerminalPane } from "./pane.ts"
import { Agent, type AgentOptions } from "./agent.ts"
import type { SpawnBackend } from "./backend.ts"
import { rollUp } from "./space.ts"
import { Divider, getWeight, setWeight, getDirection, setDirection, type JunctionFrame } from "./divider.ts"
import {
  collapse,
  makeLayout,
  presetLayout,
  prune,
  type Layout,
  type LayoutNode,
  type LayoutPreset,
} from "./layout.ts"

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
  /** The pane filling the window on its own, and everything needed to put the
   *  layout back exactly as it was. See #zoom. */
  #zoomed: TerminalPane | null = null
  #zoomSlot: { parent: BoxRenderable; index: number; weight: number } | null = null
  #zoomTree: Renderable[] = []
  /** Whether ordinary child input is replicated to every pane — tmux's
   *  synchronize-panes. Treated like zoom: a transient interactive mode, shown
   *  in the tab, never persisted or configured. */
  #sync = false
  /** The named layout this window currently matches, cleared by anything that
   *  reshapes or resizes the tree. See preset. */
  #preset: LayoutPreset | null = null
  onChange?: () => void
  /** Fired after an agent's process exits and its views have been closed. The
   *  app uses it to decide what to show next; it is deliberately not the same
   *  as "a pane closed", because closing a view by hand is a detach, not an end. */
  onAgentExit?: (agent: Agent) => void
  onCopy?: (text: string) => boolean | void
  onCopyError?: (error: Error) => void

  /**
   * Where agents started here get their processes. Undefined means a local PTY.
   *
   * Carried alongside #shell because it answers the same kind of question — not
   * "what does this window contain" but "what does starting something in it
   * mean" — and every path that creates an agent already goes through here.
   */
  #backend: SpawnBackend | undefined

  constructor(
    ctx: RenderContext,
    shell: string[],
    cwd: string | undefined,
    number: number,
    backend?: SpawnBackend,
  ) {
    this.#ctx = ctx
    this.#shell = shell
    this.#cwd = cwd
    this.#backend = backend
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

  /** How the window reads in the tab bar and the sidebar. Both show the same
   *  string, including the zoom marker, so neither can drift from the other. */
  get label(): string {
    return `${this.number}:${this.title}${this.#zoomed ? " Z" : ""}${this.#sync ? " Y" : ""}`
  }

  /** True while one pane is filling the window on its own. */
  get zoomed(): boolean {
    return this.#zoomed !== null
  }

  /** True while ordinary child input is broadcast to every pane in the window. */
  get sync(): boolean {
    return this.#sync
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

  /**
   * Wire an agent's lifecycle callbacks to this window.
   *
   * Shared by spawn and by break-pane, which hands a live agent and its hooks
   * to a new window rather than restarting it. The callbacks close panes and
   * fire onAgentExit against THIS window, so an agent that changes windows
   * must be re-bound or an exit would act on stale ownership.
   */
  #bind(agent: Agent) {
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
  }

  /** Start an agent without opening a view onto it. The name defaults to the
   *  command being run — "zsh", not a generic "shell". */
  spawn(name?: string, cmd = this.#shell, cwd = this.#cwd): Agent {
    return this.startAgent({ name, cmd, cwd })
  }

  /**
   * Bring up an agent from full options and take ownership of it.
   *
   * What spawn is in terms of: restore needs the options spawn's three
   * positional arguments cannot carry — a persisted id, a size, and the fact
   * that this one's process is already over and must not be run again.
   */
  startAgent(opts: AgentOptions): Agent {
    // The window's backend is a default, not an override: restore passes its
    // own per-agent choice, and a tombstone must keep having no backend at all.
    const agent = new Agent({ backend: this.#backend, ...opts })
    this.#bind(agent)
    this.#agents.push(agent)
    this.onChange?.()
    return agent
  }

  /** Stop owning an agent without stopping it — the moving half of a break.
   *  Its hooks are re-pointed at its new window by that window's #bind, so a
   *  lone agent answers to exactly one window at a time. */
  relinquishAgent(agent: Agent): boolean {
    const i = this.#agents.indexOf(agent)
    if (i === -1) return false
    this.#agents.splice(i, 1)
    this.onChange?.()
    return true
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

  /**
   * Send bytes to the focused pane — or to every pane when sync is on.
   *
   * The single child-input path. Everything the user aims at a child funnels
   * through here: unhandled keystrokes and the literal-prefix passthrough. herdr
   * controls (the keymap's own bindings), overlays, prompts and pane-local mouse
   * events never reach it, so sync mode can only ever replicate input that was
   * meant for a child in the first place.
   *
   * The broadcast target is the window's panes — exactly the set on screen — so
   * it follows the layout without bookkeeping: a new split joins the fan-out, a
   * closed pane leaves it, and a parked pane stays in it while the window is
   * zoomed, because zoom hides panes rather than detaching them. A *detached*
   * agent has no pane, so it receives nothing until a view is opened on it.
   *
   * Deduplicated by agent: a pane is a viewport, and two panes viewing one agent
   * are one process — writing twice would double the input into it. Different
   * sizes need no handling: every child owns a terminal of its own geometry, so
   * the same bytes are simply delivered to each.
   */
  write(bytes: string | Uint8Array) {
    if (this.#sync) {
      const seen = new Set<Agent>()
      for (const pane of this.#panes) {
        if (seen.has(pane.agent)) continue
        seen.add(pane.agent)
        pane.write(bytes)
      }
      return
    }
    this.#focused?.write(bytes)
  }

  /** Flip synchronize-panes for this window. */
  toggleSync() {
    this.#sync = !this.#sync
    this.onChange?.()
    this.#ctx.requestRender()
  }

  #makeDivider(direction: SplitDirection): Divider {
    const divider = new Divider(this.#ctx, { id: `divider-${nextId++}`, axis: direction })
    // It is a segment of the pane frame, so its ends finish as junctions.
    divider.tees = true
    // Every cell it draws is merged against the frame's geometry, so a seam
    // meeting a seam at one cell draws a ┼ rather than the last tee to land.
    divider.junction = () => this.#junctionFrame()
    // Dragging a seam moves the window off whatever preset built it, so the
    // next select-layout advances rather than rebuilding what is on screen.
    divider.onResized = () => {
      this.#preset = null
    }
    return divider
  }

  #makePane(agent: Agent): TerminalPane {
    const pane = new TerminalPane(this.#ctx, {
      id: `pane-${nextId++}`,
      agent,
    })
    setWeight(pane, 1)
    pane.onFocusRequest = (p) => this.focus(p)
    pane.onCopy = this.onCopy
    pane.onCopyError = this.onCopyError
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
    // Looking at another pane means you are done with the zoom, which is also
    // what tmux's select-pane does. Zoom survives switching *windows*, though:
    // that is navigation, not a change of mind about this layout.
    if (this.#zoomed && pane !== this.#zoomed) this.#unzoom()
    this.#focused = pane
    for (const p of this.#panes) p.active = p === pane
    this.#refreshChrome()
    this.onChange?.()
    this.#ctx.requestRender()
  }

  /**
   * Toggle the focused pane filling the whole window.
   *
   * The split tree is lifted off the root wholesale and the pane hung there in
   * its place, rather than the layout being rebuilt around a maximised pane.
   * Detached renderables cost nothing — they are out of yoga and out of the hit
   * grid — and every weight, divider and nesting level survives untouched, so
   * unzooming restores the layout exactly instead of approximately.
   *
   * Splitting, closing or swapping while zoomed drops the zoom first: those all
   * reshape the tree that is currently parked off to one side, and reasoning
   * about a layout you cannot see is how panes go missing.
   */
  zoom() {
    if (this.#zoomed) {
      this.#unzoom()
    } else {
      const pane = this.#focused
      // Zooming the only pane changes nothing but would still show a marker.
      if (!pane || this.#panes.length < 2) return
      const parent = pane.parent as BoxRenderable | null
      if (!parent) return

      this.#zoomSlot = {
        parent,
        index: parent.getChildren().indexOf(pane),
        weight: getWeight(pane),
      }
      // Everything the root holds *except* the pane being zoomed: when the pane
      // hangs straight off the root it is one of those children itself, and
      // parking it alongside the tree would restore it twice.
      this.#zoomTree = this.root.getChildren().filter((child) => child !== pane)
      parent.remove(pane)
      for (const child of this.#zoomTree) this.root.remove(child)
      setWeight(pane, 1)
      this.root.add(pane)
      this.#zoomed = pane
    }
    this.#refreshChrome()
    this.onChange?.()
    this.#ctx.requestRender()
  }

  #unzoom() {
    const pane = this.#zoomed
    const slot = this.#zoomSlot
    this.#zoomed = null
    this.#zoomSlot = null
    const tree = this.#zoomTree
    this.#zoomTree = []
    if (!pane || !slot) return

    this.root.remove(pane)
    for (const child of tree) this.root.add(child)
    setWeight(pane, slot.weight)
    slot.parent.add(pane, slot.index)
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

  /**
   * The window's frame, as a query for junction cells.
   *
   * Layout is final by the time anything draws, so a divider resolves every
   * cell it touches — its own line, its capped ends, and the tee one cell past
   * an uncapped end — against the frame lines that actually pass through it.
   * A frame cell is a divider's rect, a pane border it owns, or (with the
   * sidebar open) the handle column beside the pane area. Uncapped ends are
   * presence too: the tee one cell past a divider lands on a cell the line on
   * the far side also claims, and both sides must agree it is a junction.
   *
   * Two dividers never share a cell along their own axis (the split tree
   * alternates), so at most one line crosses another at a junction cell. What
   * *can* collide is a crossing seam meeting two collinear seams at one cell —
   * the ┼ case — and resolving the glyph from geometry instead of paint order
   * is what makes that cell right from either drawer.
   */
  #junctionFrame(): JunctionFrame {
    const dividers = this.#dividers()
    const panes = this.#panes
    // The sidebar handle is the left border of the pane area: one column out
    // from the leftmost pane, spanning the pane area's rows. Its cells count
    // as a vertical frame line so horizontal dividers tee into the seam
    // correctly without knowing the handle exists.
    const handleX = frame.externalLeft && panes.length > 0
      ? Math.min(...dividers.map((d) => d.x), ...panes.map((p) => p.x)) - 1
      : null
    const handleTop = panes.length > 0 ? Math.min(...panes.map((p) => p.y)) : 0
    const handleBottom = panes.length > 0 ? Math.max(...panes.map((p) => p.y + p.height)) : 0

    const vertical = (x: number, y: number): boolean => {
      if (handleX !== null && x === handleX && y >= handleTop && y < handleBottom) return true
      for (const d of dividers) {
        if (d.axis !== "row") continue
        if (d.x === x && y >= d.y && y < d.y + d.height) return true
        if (d.tees && !d.capStart && d.x === x && y === d.y - 1) return true
        if (d.tees && !d.capEnd && d.x === x && y === d.y + d.height) return true
      }
      for (const p of panes) {
        if (p.edges.left && p.x === x && y >= p.y && y < p.y + p.height) return true
        if (p.edges.right && p.x + p.width - 1 === x && y >= p.y && y < p.y + p.height) return true
      }
      return false
    }

    const horizontal = (x: number, y: number): boolean => {
      for (const d of dividers) {
        if (d.axis !== "column") continue
        if (d.y === y && x >= d.x && x < d.x + d.width) return true
        if (d.tees && !d.capStart && d.y === y && x === d.x - 1) return true
        if (d.tees && !d.capEnd && d.y === y && x === d.x + d.width) return true
      }
      for (const p of panes) {
        if (p.edges.top && p.y === y && x >= p.x && x < p.x + p.width) return true
        if (p.edges.bottom && p.y + p.height - 1 === y && x >= p.x && x < p.x + p.width) return true
      }
      return false
    }

    return { vertical, horizontal }
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
    if (this.#zoomed) this.#unzoom()
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
    // Splitting reshapes the parked tree; do it with the layout on screen.
    if (this.#zoomed) this.#unzoom()
    this.#preset = null
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

  /**
   * Remove a pane from the layout and hand it over, without destroying it or
   * touching its agent — the source half of a break-pane. The process keeps
   * running and its terminal keeps its state; only ownership moves.
   *
   * The same tree surgery as close(): the pane's divider goes with it, and any
   * split box left holding a single child is collapsed back into its parent.
   * Returns the pane, or null when this window does not hold it.
   */
  detachPane(pane: TerminalPane): TerminalPane | null {
    // Unzoom first, whichever pane is going: while zoomed the tree is off the
    // root, and unpicking a pane out of a detached tree is how you end up
    // restoring a layout that no longer contains anything.
    if (this.#zoomed) this.#unzoom()
    const i = this.#panes.indexOf(pane)
    if (i === -1) return null
    this.#panes.splice(i, 1)
    this.#preset = null

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

    // Redistribute the freed space the way tmux's layout_close_pane does: the
    // survivors keep their relative proportions but now share the whole window.
    // Re-writing the weights is also what forces yoga to re-lay them out —
    // OpenTUI treats flexGrow as a fraction of the container, so a lone
    // survivor left at its old 0.5 share would otherwise render half-width.
    const total = this.#panes.reduce((sum, p) => sum + getWeight(p), 0)
    for (const p of this.#panes) setWeight(p, total > 0 ? getWeight(p) / total : 1)

    if (this.#focused === pane) {
      this.#focused = null
      if (this.#panes.length) this.focus(this.#panes[Math.min(i, this.#panes.length - 1)]!)
    }
    // Survivors have gained edges the removed pane's divider used to cover,
    // and a collapsed split box changes what is adjacent to what.
    this.#refreshChrome()
    this.#ctx.requestRender()
    return pane
  }

  /** Adopt a pane and its agent, detached from another window — break-pane's
   *  destination half. The process and its terminal state are untouched; only
   *  ownership moves, so the agent's hooks are re-pointed here and an exit
   *  closes the pane in the window it now lives in. The caller detaches first,
   *  so the pane arrives unmounted and with no other owner. */
  adopt(agent: Agent, pane: TerminalPane) {
    this.#agents.push(agent)
    this.#bind(agent)
    this.#panes.push(pane)
    setWeight(pane, 1)
    pane.onFocusRequest = (p) => this.focus(p)
    this.root.add(pane)
    this.focus(pane)
  }

  /** Close a pane and collapse any split box left holding a single child. */
  close(pane: TerminalPane) {
    if (!this.detachPane(pane)) return
    pane.destroyRecursively()
    // detachPane refocused a survivor (which notified) or left the window
    // empty — and an empty window needs the app told, so it can close it or
    // decide what to show next.
    if (this.#panes.length === 0) this.onChange?.()
  }

  /**
   * This window's arrangement, as data that can be stored and rebuilt.
   *
   * Reads *through* a zoom rather than capturing it. Zoom parks the real tree
   * off the root and hangs one pane there instead, so exporting the live root
   * while zoomed would record a single-pane window and quietly destroy the
   * layout on the next restore. Zoom is a transient view of a layout, not a
   * layout, and is deliberately not persisted — the same reason it is absent
   * from Space's persisted form.
   *
   * Dividers are skipped: one sits between every adjacent sibling pair, so the
   * rebuild derives them rather than reading them back.
   */
  exportLayout(): Layout {
    const slot = this.#zoomSlot
    const zoomed = this.#zoomed

    // The children a node *would* have with no zoom in effect: the root's real
    // children are parked in #zoomTree, and the zoomed pane belongs back in the
    // slot it was lifted out of.
    const childrenOf = (node: BoxRenderable): Renderable[] => {
      const base = zoomed && node === this.root ? [...this.#zoomTree] : [...node.getChildren()]
      if (zoomed && slot && node === slot.parent) base.splice(slot.index, 0, zoomed)
      return base
    }

    const weightOf = (node: Renderable): number =>
      zoomed && slot && node === zoomed ? slot.weight : getWeight(node)

    const walk = (node: Renderable): LayoutNode | null => {
      if (node instanceof TerminalPane) {
        return { type: "pane", agent: node.agent.id, weight: weightOf(node) }
      }
      if (!(node instanceof BoxRenderable)) return null
      const children = childrenOf(node)
        .map(walk)
        .filter((child): child is LayoutNode => child !== null)
      if (children.length === 0) return null
      return { type: "split", direction: getDirection(node), weight: weightOf(node), children }
    }

    // collapse() does the rest: a single-pane window walks to a one-child split,
    // and closing a pane can leave husks that the live tree renders identically.
    // makeLayout drops a focus whose pane did not survive that collapse.
    return makeLayout(collapse(walk(this.root)), this.#focused?.agent.id)
  }

  /**
   * Rebuild the window's arrangement from a layout.
   *
   * Panes are viewports, so an apply rearranges them rather than recreating
   * them: a pane already showing an agent is reused, keeping its terminal,
   * scrollback and scroll position across the move. Only slots the current
   * panes cannot fill get new ones, and panes the layout has no slot for are
   * closed — their agents survive as detached, exactly as pane.close leaves
   * them.
   *
   * Panes naming an agent this window does not own are pruned first, because a
   * layout routinely outlives its processes (a session restored a day later,
   * a layout string pasted from another window). Pruning to nothing is a
   * refusal rather than a way to empty the window: it returns false with the
   * layout untouched, so a stale string cannot silently destroy what is here.
   */
  applyLayout(layout: Layout): boolean {
    const byId = new Map(this.#agents.map((agent) => [agent.id, agent]))
    const wanted = prune(layout, (id) => byId.has(id))
    if (!wanted.root) return false

    // The tree about to be dismantled is the parked one while zoomed.
    if (this.#zoomed) this.#unzoom()
    // An arbitrary layout matches no preset; selectLayout re-stamps it after.
    this.#preset = null

    // Reuse by agent, in pane order, so two panes on one agent stay two panes
    // and each keeps its own scroll position.
    const spare = new Map<string, TerminalPane[]>()
    for (const pane of this.#dismantle()) {
      const list = spare.get(pane.agent.id)
      if (list) list.push(pane)
      else spare.set(pane.agent.id, [pane])
    }
    this.#panes.length = 0

    const take = (id: string): TerminalPane => {
      const reused = spare.get(id)?.shift()
      if (!reused) return this.#makePane(byId.get(id)!)
      this.#panes.push(reused)
      return reused
    }

    const build = (node: LayoutNode): Renderable => {
      if (node.type === "pane") {
        const pane = take(node.agent)
        setWeight(pane, node.weight)
        return pane
      }
      const box = new BoxRenderable(this.#ctx, { id: `split-${nextId++}` })
      setDirection(box, node.direction)
      setWeight(box, node.weight)
      fill(box, node)
      return box
    }

    // Dividers are derived, never serialized: one sits between every adjacent
    // pair, which is the invariant split() maintains and refreshChrome reads.
    const fill = (box: BoxRenderable, node: Extract<LayoutNode, { type: "split" }>) => {
      node.children.forEach((child, i) => {
        if (i > 0) box.add(this.#makeDivider(node.direction))
        box.add(build(child))
      })
    }

    // A split at the root goes *into* the root box rather than under a fresh
    // one: the root carries the outermost axis itself (see split), and an extra
    // level here would be a shape exportLayout immediately collapses away.
    if (wanted.root.type === "split") {
      setDirection(this.root, wanted.root.direction)
      fill(this.root, wanted.root)
    } else {
      this.root.add(build(wanted.root))
    }

    // Whatever the layout had no slot for is a closed view, not a killed agent.
    for (const leftover of spare.values()) for (const pane of leftover) pane.destroyRecursively()

    this.#focused = null
    const focus = wanted.focus ? this.#panes.find((p) => p.agent.id === wanted.focus) : undefined
    this.focus(focus ?? this.#panes[0]!)
    this.#refreshChrome()
    this.onChange?.()
    this.#ctx.requestRender()
    return true
  }

  /**
   * Strip the window back to bare panes, returning them.
   *
   * Boxes and dividers are the derived half of the tree, so they are destroyed
   * rather than reused; the panes are the part that owns state worth keeping.
   * Children are copied before removal — removing while iterating the live
   * child list skips every other one.
   */
  #dismantle(): TerminalPane[] {
    const panes: TerminalPane[] = []
    const walk = (box: BoxRenderable) => {
      for (const child of [...box.getChildren()]) {
        box.remove(child)
        if (child instanceof TerminalPane) panes.push(child)
        else if (child instanceof Divider) child.destroy()
        else if (child instanceof BoxRenderable) {
          walk(child)
          child.destroy()
        }
      }
    }
    walk(this.root)
    return panes
  }

  /**
   * Rearrange the current panes into one of the named layouts, tmux's
   * select-layout. The pane order is kept, so cycling walks through
   * arrangements of the same panes instead of shuffling them, and focus stays
   * on the pane the user was in.
   */
  selectLayout(preset: LayoutPreset): boolean {
    if (this.#panes.length === 0) return false
    const agents = this.#panes.map((pane) => pane.agent.id)
    const applied = this.applyLayout(presetLayout(agents, preset, this.#focused?.agent.id))
    if (applied) this.#preset = preset
    return applied
  }

  /** The preset this window was last arranged by, or null once a split, close
   *  or drag has moved it off that arrangement. Drives next-layout's cycle. */
  get preset(): LayoutPreset | null {
    return this.#preset
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
