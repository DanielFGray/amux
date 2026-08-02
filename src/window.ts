import { BoxRenderable, type RenderContext, type Renderable } from "@opentui/core"
import { TerminalPane } from "./pane.ts"
import { Agent, type AgentOptions } from "./agent.ts"
import type { SpawnBackend } from "./backend.ts"
import { Context, Effect, Exit, Scope } from "effect"
import { RenderCtx, Shell, Backend, type WorkspaceEnv } from "./env.ts"
import { rollUp } from "./space.ts"
import { Divider, getWeight, setWeight, getDirection, setDirection, type JunctionFrame } from "./divider.ts"
import { runtime } from "./config.ts"
import {
  closeLayout,
  collapse,
  layoutPanes,
  makeLayout,
  newPaneId,
  presetLayout,
  prune,
  splitLayout,
  swapLayout,
  type Layout,
  type LayoutNode,
  type LayoutPane,
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
  /** Handed on to the panes and dividers this window builds. */
  #env: Context.Context<WorkspaceEnv>
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
   * Where agents started here get their processes.
   *
   * Read from context alongside #shell because it answers the same kind of
   * question — not "what does this window contain" but "what does starting
   * something in it mean" — and every path that creates an agent goes through
   * here. It is always a real backend now: "run it locally" is the Backend
   * reference's default rather than the absence of an answer.
   */
  #backend: SpawnBackend

  /**
   * One scope per agent, rather than one scope for the window.
   *
   * The obvious arrangement — fork every agent's scope from the window's — is
   * wrong here, because break-pane MOVES an agent to another window and Effect
   * scopes cannot be re-parented. An agent forked from its old window's scope
   * would be killed when that window closed, despite now living somewhere else.
   * Independent scopes held in a map make the transfer a map entry moving
   * between two windows (see relinquishAgent/adopt), and make killAgent the
   * closing of exactly one of them.
   */
  #scopes = new Map<Agent, Scope.CloseableScope>()

  constructor(env: Context.Context<WorkspaceEnv>, cwd: string | undefined, number: number) {
    this.#env = env
    this.#ctx = Context.get(env, RenderCtx)
    this.#shell = Context.get(env, Shell)
    this.#backend = Context.get(env, Backend)
    this.#cwd = cwd
    this.number = number
    this.root = new BoxRenderable(this.#ctx, {
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

  /**
   * A window whose agents are released when the surrounding scope closes.
   *
   * The lifetime-correct way to make one: nothing has to remember to call
   * disposeAll, because closing the scope that made the window is what ends the
   * processes in it.
   */
  static make(
    env: Context.Context<WorkspaceEnv>,
    cwd: string | undefined,
    number: number,
  ): Effect.Effect<Window, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new Window(env, cwd, number)),
      (window) => window.release,
    )
  }

  /** Start an agent without opening a view onto it. The name defaults to the
   *  command being run — "zsh", not a generic "shell". */
  spawn(name?: string, cmd = this.#shell, cwd = this.#cwd): Effect.Effect<Agent> {
    return this.startAgent({ name, cmd, cwd })
  }

  /**
   * Bring up an agent from full options and take ownership of it.
   *
   * What spawn is in terms of: restore needs the options spawn's three
   * positional arguments cannot carry — a persisted id, a size, and the fact
   * that this one's process is already over and must not be run again.
   */
  startAgent(opts: AgentOptions): Effect.Effect<Agent> {
    return Effect.gen(this, function* () {
      const scope = yield* Scope.make()
      // The window's backend is a default, not an override: restore passes its
      // own per-agent choice, and a tombstone must keep having no backend at all.
      // Spread order is what encodes that — opts wins where it says anything.
      const agent = yield* Agent.make({ backend: this.#backend, ...opts }).pipe(
        Scope.extend(scope),
      )
      this.#scopes.set(agent, scope)
      this.#bind(agent)
      this.#agents.push(agent)
      this.onChange?.()
      return agent
    })
  }

  /**
   * Stop owning an agent without stopping it — the moving half of a break.
   *
   * Its hooks are re-pointed at its new window by that window's #bind, so a
   * lone agent answers to exactly one window at a time. The agent's scope
   * leaves with it and is handed to `adopt`; keeping it here would kill a
   * running agent the moment this window closed.
   *
   * Returns the scope to transfer, or null when the agent is not ours.
   */
  relinquishAgent(agent: Agent): Scope.CloseableScope | null {
    const i = this.#agents.indexOf(agent)
    if (i === -1) return null
    this.#agents.splice(i, 1)
    const scope = this.#scopes.get(agent) ?? null
    this.#scopes.delete(agent)
    this.onChange?.()
    return scope
  }

  /**
   * Permanently stop an agent and close any views of it.
   *
   * Reports the agent as gone, exactly as a process ending does. A kill and an
   * exit differ only in who started it: either way the agent is finished, its
   * panes are shut, and the window may now be empty — so both have to reach the
   * same cascade, or the app closes a window when the shell exits and keeps an
   * identical empty one when you kill it (ts-8d06b3, where ^a K left a tab you
   * could still cycle to that showed nothing).
   *
   * Fired last, so the handler reads a tree with the agent already out of it —
   * the "is anything still running here" question it asks has to see the answer
   * after this kill, not before.
   */
  killAgent(agent: Agent): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      for (const p of [...this.#panes]) if (p.agent === agent) this.close(p)
      const i = this.#agents.indexOf(agent)
      if (i !== -1) this.#agents.splice(i, 1)
      yield* this.#releaseAgent(agent)
      this.onChange?.()
      this.#ctx.requestRender()
      this.onAgentExit?.(agent)
    })
  }

  /**
   * Close an agent's scope, which is what frees its PTY and terminal.
   *
   * Every agent this window owns has one — `startAgent` makes it and `adopt`
   * requires it — so a miss here means the agent was never really ours. It is
   * released anyway rather than left running, but the two cases stay distinct:
   * a fallback that quietly does the same work would make a lost scope
   * invisible, and a leaked scope is exactly the bug worth seeing.
   */
  #releaseAgent(agent: Agent): Effect.Effect<void> {
    const scope = this.#scopes.get(agent)
    this.#scopes.delete(agent)
    if (scope) return Scope.close(scope, Exit.void)
    return Effect.andThen(
      Effect.logWarning(`agent ${agent.id} released without a scope`),
      agent.release,
    )
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

  /** `id` is the pane's model identity (layout.ts newPaneId), used as the
   *  renderable's tree id too so a pane has one identifier rather than two. */
  #makePane(agent: Agent, id = newPaneId()): TerminalPane {
    const pane = new TerminalPane(this.#ctx, { id, agent })
    setWeight(pane, 1)
    pane.onFocusRequest = (p) => this.focus(p)
    pane.onCopy = this.onCopy
    pane.onCopyError = this.onCopyError
    this.#panes.push(pane)
    return pane
  }

  /** Seed the workspace with a single agent and a view onto it. */
  init(name?: string): Effect.Effect<TerminalPane> {
    return this.spawn(name).pipe(Effect.map((agent) => this.mount(agent)))
  }

  /** Put a pane for an existing agent at the root of an empty window. The
   *  synchronous half of init, and what split falls back to when there is no
   *  pane to split. */
  mount(agent: Agent): TerminalPane {
    const pane = this.#makePane(agent)
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
    const gap = runtime.paneGap > 0
    const showOuterBorder = runtime.singlePaneBorder || this.#panes.length > 1
    for (const pane of this.#panes) {
      pane.edges = {
        // frame.externalLeft: the sidebar handle owns that column, so no pane
        // draws a left border while the sidebar is open.
        left: showOuterBorder && (gap ? !frame.externalLeft : !frame.externalLeft && !this.#hasNeighbour(pane, "row", -1)),
        right: showOuterBorder && (gap || !this.#hasNeighbour(pane, "row", 1)),
        top: showOuterBorder && (gap || !this.#hasNeighbour(pane, "column", -1)),
        bottom: showOuterBorder && (gap || !this.#hasNeighbour(pane, "column", 1)),
      }
    }
    for (const divider of this.#dividers()) {
      divider.setPaneGap(runtime.paneGap)
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

  /**
   * The panes in tree order — left to right, depth first.
   *
   * The order a Layout lists them in, which is what makes a position in one the
   * same position in the other. NOT the same as `#panes`: that is creation
   * order, and a split used to insert into the middle of the tree while pushing
   * onto the end of the list. Every arrangement now goes through applyLayout,
   * which rebuilds `#panes` in this order, so the two agree — but the tree is
   * the one that defines it.
   */
  #paneOrder(root: Renderable = this.root, out: TerminalPane[] = []): TerminalPane[] {
    for (const child of root.getChildren()) {
      if (child instanceof TerminalPane) out.push(child)
      else if (child instanceof BoxRenderable) this.#paneOrder(child, out)
    }
    return out
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
    const order = this.#paneOrder()
    if (!from || order.length < 2) return
    const i = order.indexOf(from)
    if (i === -1) return
    const j = (i + step + order.length) % order.length
    // Swapping panes inside a preset arrangement leaves it that arrangement:
    // even-horizontal with two panes exchanged is still even-horizontal.
    this.applyLayout(swapLayout(this.exportLayout(), i, j), this.#preset)
  }

  /**
   * Split the focused pane, reusing its slot.
   *
   * If the parent already runs along the requested axis the new pane is just
   * inserted as a sibling; otherwise the pane is swapped for a nested Box so
   * the tree stays a proper h/v alternation instead of a flat list.
   */
  split(direction: SplitDirection, agent: Agent): TerminalPane | null {
    // Splitting reshapes the parked tree; do it with the layout on screen.
    if (this.#zoomed) this.#unzoom()
    const target = this.#focused
    if (!target) return this.mount(agent)
    // A focused pane that is not in the tree has no slot to split. The tree is
    // the only thing that can say so — the layout below is derived from it, and
    // a pane it never walked is simply absent rather than reported.
    if (!target.parent) return null

    const at = this.#paneOrder().indexOf(target)
    if (at === -1) return null

    // The newcomer is named before it exists, so the layout can say which pane
    // to focus even when it shows an agent this window is already showing. The
    // apply builds it under that id and focuses it, which is why nothing here
    // has to find the new pane by position afterwards.
    const id = newPaneId()
    const next = splitLayout(this.exportLayout(), at, direction, { id, agent: agent.id })
    if (!this.applyLayout(next)) return null
    return this.#panes.find((pane) => pane.id === id) ?? null
  }

  /**
   * Split, starting a new agent to fill the new pane.
   *
   * The acquiring half of split, kept separate from it deliberately. `split`
   * itself is tree surgery over renderables — total, synchronous, and covered
   * by geometry tests that have no business awaiting anything. Only the spawn
   * needs a lifetime, so only the spawn is an Effect, and the two compose.
   *
   * The unsplittable case is checked BEFORE spawning, so a window that cannot
   * take a split does not leave a live process behind with no pane on it.
   */
  splitSpawn(direction: SplitDirection, name?: string): Effect.Effect<TerminalPane | null> {
    if (this.#focused && !this.#focused.parent) return Effect.succeed(null)
    return this.spawn(name).pipe(Effect.map((agent) => this.split(direction, agent)))
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
   * Take a pane out of the layout and hand it over, alive — the source half of
   * a break-pane. The process keeps running and its terminal keeps its state;
   * only ownership moves.
   *
   * The same eviction `close` performs, stopping one step earlier. Both take
   * the pane out of the arrangement and let the survivors grow into the space;
   * they differ only in what happens to the pane that fell out, which is why
   * #project hands it back rather than deciding.
   *
   * Returns the pane, or null when this window does not hold it.
   */
  detachPane(pane: TerminalPane): TerminalPane | null {
    // Unzoom first, whichever pane is going: while zoomed the tree is off the
    // root, and unpicking a pane out of a detached tree is how you end up
    // restoring a layout that no longer contains anything.
    if (this.#zoomed) this.#unzoom()
    const at = this.#paneOrder().indexOf(pane)
    if (at === -1) return null
    // Losing a pane moves the window off whatever preset it matched: the
    // arrangement now has one fewer pane than the preset describes.
    const [evicted] = this.#project(closeLayout(this.exportLayout(), at), null)
    return evicted ?? null
  }

  /** Adopt a pane and its agent, detached from another window — break-pane's
   *  destination half. The process and its terminal state are untouched; only
   *  ownership moves, so the agent's hooks are re-pointed here and an exit
   *  closes the pane in the window it now lives in. The caller detaches first,
   *  so the pane arrives unmounted and with no other owner. */
  adopt(agent: Agent, pane: TerminalPane, scope: Scope.CloseableScope) {
    this.#agents.push(agent)
    // The scope comes from the window that relinquished it — see the note on
    // #scopes for why it travels rather than being re-forked here. Required,
    // not optional: an agent in a window without a scope is one nothing will
    // ever release, and making that unrepresentable is cheaper than detecting it.
    this.#scopes.set(agent, scope)
    this.#bind(agent)
    this.#panes.push(pane)
    setWeight(pane, 1)
    pane.onFocusRequest = (p) => this.focus(p)
    this.root.add(pane)
    this.focus(pane)
  }

  /** Close a pane: take it out of the layout, then destroy the view. The agent
   *  survives as detached, which is what makes this a close and not a kill. */
  close(pane: TerminalPane) {
    if (!this.detachPane(pane)) return
    pane.destroyRecursively()
    // #project refocused a survivor (which notified) or left the window
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
        return { type: "pane", id: node.id, agent: node.agent.id, weight: weightOf(node) }
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
    return makeLayout(collapse(walk(this.root)), this.#focused?.id)
  }

  /**
   * Rebuild the window's arrangement from a layout.
   *
   * Panes are viewports, so an apply rearranges them rather than recreating
   * them: a pane the layout names is put in the slot that names it, keeping its
   * terminal, scrollback and scroll position across the move. Only slots the
   * current panes cannot fill get new ones, and panes the layout has no slot
   * for are closed — their agents survive as detached, exactly as pane.close
   * leaves them.
   *
   * A slot naming a pane this window does not have is a layout from somewhere
   * else — a string pasted from another window, or a session restored into a
   * fresh process. Those slots fall back to matching on the agent, and the pane
   * that fills one keeps its OWN id rather than taking the layout's: a pane id
   * names a live viewport that other things may already be holding, so it is
   * not something an incoming layout gets to reassign. tmux draws the same
   * line — a layout string it did not write is an arrangement, not a set of
   * pane identities.
   *
   * Panes naming an agent this window does not own are pruned first, because a
   * layout routinely outlives its processes (a session restored a day later,
   * a layout string pasted from another window). Pruning to nothing is a
   * refusal rather than a way to empty the window: it returns false with the
   * layout untouched, so a stale string cannot silently destroy what is here.
   *
   * That refusal is about INPUT, which is why it lives here and not in
   * #project. A layout arriving from outside can be stale or hand-edited and
   * has to earn its way in; one this window derived from itself a moment ago
   * (a split, a close) has nothing to validate and may legitimately be empty.
   */
  applyLayout(layout: Layout, preset: LayoutPreset | null = null): boolean {
    const wanted = prune(layout, (id) => this.#agents.some((agent) => agent.id === id))
    if (!wanted.root) return false
    // Whatever the layout had no slot for is a closed view, not a killed agent.
    for (const evicted of this.#project(wanted, preset)) evicted.destroyRecursively()
    return true
  }

  /**
   * Rebuild the tree from a layout that is already known good, returning the
   * panes it had no slot for.
   *
   * The projection half of applyLayout, split out because eviction is a
   * decision rather than a fact: applying a layout means the pane it dropped
   * was closed, while break-pane means that same pane is being handed to
   * another window alive. One rebuild, and the caller says what becomes of what
   * falls out of it.
   */
  #project(wanted: Layout, preset: LayoutPreset | null): TerminalPane[] {
    const byId = new Map(this.#agents.map((agent) => [agent.id, agent]))
    // The tree about to be dismantled is the parked one while zoomed.
    if (this.#zoomed) this.#unzoom()
    // An arbitrary layout matches no preset, so that is the default. A caller
    // that knows better says so: select-layout builds its arrangement FROM a
    // preset, and swapping two panes inside one leaves it that preset.
    this.#preset = preset

    // Who fills which slot is decided before anything is built, in two passes.
    // A slot naming a pane that exists must get that pane, so those are claimed
    // first — one interleaved pass would let an earlier slot take, on agent
    // alone, the very pane a later slot named outright.
    const spare = new Set(this.#dismantle())
    this.#panes.length = 0
    const filled = new Map<string, TerminalPane>()

    const claim = (slot: LayoutPane, match: (pane: TerminalPane) => boolean) => {
      if (filled.has(slot.id)) return
      for (const pane of spare) {
        if (!match(pane)) continue
        filled.set(slot.id, pane)
        spare.delete(pane)
        return
      }
    }
    const slots = wanted.root ? layoutPanes(wanted.root) : []
    for (const slot of slots) claim(slot, (pane) => pane.id === slot.id)
    for (const slot of slots) claim(slot, (pane) => pane.agent.id === slot.agent)

    const take = (slot: LayoutPane): TerminalPane => {
      const reused = filled.get(slot.id)
      if (!reused) {
        const made = this.#makePane(byId.get(slot.agent)!, slot.id)
        filled.set(slot.id, made)
        return made
      }
      this.#panes.push(reused)
      return reused
    }

    const build = (node: LayoutNode): Renderable => {
      if (node.type === "pane") {
        const pane = take(node)
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
    if (wanted.root === null) {
      // Nothing to build: closing the last pane empties the window, which is a
      // state it really has until the app decides to close it.
    } else if (wanted.root.type === "split") {
      setDirection(this.root, wanted.root.direction)
      fill(this.root, wanted.root)
    } else {
      this.root.add(build(wanted.root))
    }

    this.#focused = null
    // Through the slot, not by searching for the id: focus names a slot, and
    // the pane filling it may have kept an id of its own.
    const focus = wanted.focus ? filled.get(wanted.focus) : undefined
    const next = focus ?? this.#panes[0]
    if (next) this.focus(next)
    this.#refreshChrome()
    this.onChange?.()
    this.#ctx.requestRender()
    return [...spare]
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
    const panes = this.#panes.map((pane) => ({ id: pane.id, agent: pane.agent.id }))
    return this.applyLayout(presetLayout(panes, preset, this.#focused?.id), preset)
  }

  /** The preset this window was last arranged by, or null once a split, close
   *  or drag has moved it off that arrangement. Drives next-layout's cycle. */
  get preset(): LayoutPreset | null {
    return this.#preset
  }

  /** Kill every agent and free its terminal. The finalizer `Window.make`
   *  installs, so nothing calls it by hand; idempotent, safe on an exit path.
   *
   *  Panes come down FIRST. A pane renders straight out of its agent's
   *  terminal, so freeing the terminal under a still-mounted pane is a
   *  use-after-free into ghostty — a segfault on the next frame, not an
   *  exception. */
  get release(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      for (const pane of [...this.#panes]) this.close(pane)
      for (const agent of [...this.#agents]) yield* this.#releaseAgent(agent)
      this.#agents.length = 0
    })
  }
}
