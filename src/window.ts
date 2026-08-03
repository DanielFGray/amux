import { BoxRenderable, type RenderContext, type Renderable } from "@opentui/core"
import { TerminalPane } from "./pane.ts"
import { Agent, type AgentOptions } from "./agent.ts"
import type { SpawnBackend } from "./backend.ts"
import { Context, Effect, Exit, Scope } from "effect"
import { RenderCtx, Shell, Backend, type WorkspaceEnv } from "./env.ts"
import { rollUp } from "./space.ts"
import { Divider, setWeight, setDirection, type JunctionFrame } from "./divider.ts"
import { runtime } from "./options.ts"
import {
  appendPane,
  closeLayout,
  layoutPanes,
  makeLayout,
  newPaneId,
  presetLayout,
  prune,
  splitLayout,
  swapLayout,
  windowState,
  type Layout,
  type LayoutNode,
  type LayoutPane,
  type LayoutPreset,
  type WindowState,
} from "./layout.ts"
import {
  dividerHasNeighbour,
  dividerTouchesPane,
  paneHasNeighbour,
  paneInDirection,
  resizeDivider,
  resizePane,
  type LayoutPath,
  type LayoutSize,
} from "./geometry.ts"

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
  /** The arrangement is authoritative here; renderables are only its projection. */
  #layout: Layout = makeLayout(null)
  #dividerRefs = new WeakMap<Divider, { path: LayoutPath; index: number }>()
  /**
   * Everything about this window that is not its arrangement: focus,
   * last-pane, zoom, sync and preset, all as pane ids and flags.
   *
   * A plain record rather than five private fields, and ids rather than
   * renderable references, so that the state a headless window would hold is
   * separable from the tree that draws it. See WindowState in layout.ts.
   */
  #state: WindowState = windowState()
  #shell: string[]
  /** Handed on to the panes and dividers this window builds. */
  #env: Context.Context<WorkspaceEnv>
  /** Directory agents spawn in — the owning space's attached directory. */
  #cwd: string | undefined
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
    const agent = this.focused?.agent ?? this.#agents[0]
    return agent?.title ?? "window"
  }

  /** How the window reads in the tab bar and the sidebar. Both show the same
   *  string, including the zoom marker, so neither can drift from the other. */
  get label(): string {
    return `${this.number}:${this.title}${this.#state.zoom ? " Z" : ""}${this.#state.sync ? " Y" : ""}`
  }

  /** True while one pane is filling the window on its own. */
  get zoomed(): boolean {
    return this.#state.zoom !== null
  }

  /** True while ordinary child input is broadcast to every pane in the window. */
  get sync(): boolean {
    return this.#state.sync
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
      () => agent.release(),
    )
  }

  /**
   * The focused pane, resolved from the id the state holds.
   *
   * Derived rather than stored, which is what makes a dangling focus
   * impossible: a pane that has left the window answers to no id, so this
   * simply comes back null instead of handing out a destroyed renderable.
   * Pane ids are minted monotonically and never reused, so a stale id cannot
   * come back to life as some later pane either.
   */
  get focused(): TerminalPane | null {
    return this.#pane(this.#state.focus)
  }

  #pane(id: string | null): TerminalPane | null {
    return id === null ? null : (this.#panes.find((pane) => pane.id === id) ?? null)
  }

  /**
   * Where a pane sits in the arrangement — the index splitLayout, swapLayout
   * and closeLayout all address panes by.
   *
   * Read out of the layout rather than by walking the tree, because under a
   * zoom the tree is down to one pane while the arrangement still has all of
   * them. The layout is the thing those transforms index into anyway, so
   * asking it directly is both more correct and answerable in more states.
   */
  #slotOf(layout: Layout, pane: TerminalPane): number {
    return layoutPanes(layout.root).findIndex((slot) => slot.id === pane.id)
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
    if (this.#state.sync) {
      const seen = new Set<Agent>()
      for (const pane of this.#panes) {
        if (seen.has(pane.agent)) continue
        seen.add(pane.agent)
        pane.write(bytes)
      }
      return
    }
    this.focused?.write(bytes)
  }

  /** Flip synchronize-panes for this window. */
  toggleSync() {
    this.#state.sync = !this.#state.sync
    this.onChange?.()
    this.#ctx.requestRender()
  }

  #makeDivider(direction: SplitDirection, path: LayoutPath, index: number): Divider {
    const divider = new Divider(this.#ctx, {
      id: `divider-${nextId++}`,
      axis: direction,
      onDrag: (delta) => this.#resizeDivider(path, index, delta),
    })
    this.#dividerRefs.set(divider, { path, index })
    // It is a segment of the pane frame, so its ends finish as junctions.
    divider.tees = true
    // Every cell it draws is merged against the frame's geometry, so a seam
    // meeting a seam at one cell draws a ┼ rather than the last tee to land.
    divider.junction = () => this.#junctionFrame()
    return divider
  }

  /** `id` is the pane's model identity (layout.ts newPaneId), used as the
   *  renderable's tree id too so a pane has one identifier rather than two.
   *  The caller adds it to `#panes`, because where a pane lands in that list is
   *  layout order and only the projection knows it. */
  #makePane(agent: Agent, id = newPaneId()): TerminalPane {
    const pane = new TerminalPane(this.#ctx, { id, agent })
    setWeight(pane, 1)
    pane.onFocusRequest = (p) => this.focus(p)
    pane.onCopy = this.onCopy
    pane.onCopyError = this.onCopyError
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
    const id = newPaneId()
    this.#mount(makeLayout({ type: "pane", id, agent: agent.id, weight: 1 }, id), null)
    return this.#pane(id)!
  }

  focus(pane: TerminalPane) {
    // Looking at another pane means you are done with the zoom, which is also
    // what tmux's select-pane does. Zoom survives switching *windows*, though:
    // that is navigation, not a change of mind about this layout.
    if (this.#state.zoom && pane.id !== this.#state.zoom.pane) this.#unzoom()
    // The pane being left becomes last-pane's other endpoint, the way tmux's
    // window_set_active_pane records a last pane on every select. Re-focusing
    // the pane already on screen — a window switch landing back on its own
    // focus — is not a change of mind, so it leaves the pair alone.
    if (pane.id !== this.#state.focus) {
      this.#state.last = this.#state.focus
      this.#state.focus = pane.id
      this.#layout = makeLayout(this.#layout.root, pane.id)
    }
    for (const p of this.#panes) p.active = p === pane
    this.#refreshChrome()
    this.onChange?.()
    this.#ctx.requestRender()
  }

  /**
   * Switch focus to the previously focused pane — tmux's last-pane.
   *
   * Repeated presses toggle between the two most recent panes: every focus
   * move records the pane being left, so selecting it then selects the pane
   * that was left, and so on back. A pane closed since it was last simply no
   * longer answers to that id, so the lookup comes back empty and the press
   * does nothing — there is no destroyed renderable to guard against, which is
   * the point of holding an id rather than a reference.
   */
  lastPane() {
    const last = this.#pane(this.#state.last)
    if (last) this.focus(last)
  }

  /**
   * Toggle the focused pane filling the whole window.
   *
   * The arrangement is captured as a Layout and the window re-projected with
   * just the one pane mounted; unzooming projects the capture back. The panes
   * that leave the screen are not destroyed and not parked in a detached tree —
   * they stay in `#panes`, unmounted, keeping their terminals and their place
   * in the sync fan-out, and the projection puts them back in the slots the
   * captured layout names.
   *
   * That the capture stays exact is not luck. A zoomed window mounts no
   * dividers, and a drag is the only thing that can reshape a tree without
   * going through a layout, so nothing is able to change the arrangement while
   * the zoom is on. Weights, nesting and divider placement all come back
   * exactly, as they did when the tree itself was parked.
   *
   * Splitting, closing or swapping while zoomed drops the zoom: they reshape
   * the arrangement the zoom was going to return to, so the capture is stale by
   * definition and the new layout wins.
   */
  zoom() {
    if (this.#state.zoom) {
      this.#unzoom()
    } else {
      const pane = this.focused
      // Zooming the only pane changes nothing but would still show a marker.
      if (!pane || this.#panes.length < 2) return
      const from = this.exportLayout()
      if (this.#slotOf(from, pane) === -1) return
      this.#state.zoom = { pane: pane.id, from }
      this.#mount(from, this.#state.preset)
    }
    this.#refreshChrome()
    this.onChange?.()
    this.#ctx.requestRender()
  }

  #unzoom() {
    const zoom = this.#state.zoom
    if (!zoom) return
    this.#state.zoom = null
    this.#mount(zoom.from, this.#state.preset)
  }

  /** Model-derived neighbour query shared by pane borders and divider caps. */
  #hasNeighbour(node: TerminalPane | Divider, axis: SplitDirection, direction: -1 | 1): boolean {
    if (node instanceof TerminalPane) {
      return paneHasNeighbour(this.#layout, node.id, axis, direction)
    }
    const ref = this.#dividerRefs.get(node)
    return ref ? dividerHasNeighbour(this.#layout, ref.path, axis, direction) : false
  }

  /**
   * Recompute who draws which border, and which divider is next to the focus.
   *
   * Every pane draws the sides that face the window's outer edge; a side facing
   * another pane belongs to the divider between them, so the frame stays one
   * cell thick at every seam.
   */
  #refreshChrome() {
    const gap = runtime["appearance.paneGap"] > 0
    const showOuterBorder = runtime["appearance.singlePaneBorder"] || this.#panes.length > 1
    const focused = this.focused
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
      divider.setPaneGap(runtime["appearance.paneGap"])
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
      divider.adjacentToFocus = focused ? this.#touches(divider, focused) : false
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
    const focused = this.focused
    return focused ? !this.#hasNeighbour(focused, "row", -1) : false
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
    const ref = this.#dividerRefs.get(divider)
    return ref ? dividerTouchesPane(this.#layout, ref.path, ref.index, pane.id) : false
  }

  focusNext(step = 1) {
    if (!this.#panes.length) return
    const focused = this.focused
    const i = focused ? this.#panes.indexOf(focused) : -1
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
    const from = this.focused
    if (!from || this.#panes.length < 2) return
    const best = this.#pane(paneInDirection(this.#layout, this.#layoutSize(), from.id, direction))
    if (best) this.focus(best)
  }

  /**
   * Nudge the divider on the given side of the focused pane.
   *
   * tmux's resize-pane: the seam between the focused pane and whatever is on
   * that side is moved one cell, growing the focused pane at its neighbour's
   * expense. The divider's own resize clamps to MIN_CELLS, so a pane already
   * squeezed to its minimum simply refuses to move rather than being stranded
   * at zero cells. The walk up the tree makes a nested pane move the divider
   * that actually borders it: in left | (top-right over bottom-right), resizing
   * the top-right pane left moves the OUTER divider, exactly as dragging it
   * would.
   */
  resizeFocus(direction: Direction) {
    const pane = this.focused
    if (!pane || this.#panes.length < 2 || this.#state.zoom) return
    this.#setResizedLayout(resizePane(this.#layout, this.#layoutSize(), pane.id, direction))
  }

  #layoutSize(): LayoutSize {
    return { cols: this.root.width, rows: this.root.height }
  }

  #resizeDivider(path: LayoutPath, index: number, delta: number) {
    if (this.#state.zoom) return
    this.#setResizedLayout(resizeDivider(this.#layout, this.#layoutSize(), path, index, delta))
  }

  #setResizedLayout(layout: Layout) {
    if (layout === this.#layout) return
    this.#layout = layout
    this.#state.preset = null
    this.#projectWeights()
    this.onChange?.()
    this.#ctx.requestRender()
  }

  /** Project model weights without rebuilding dividers during pointer capture. */
  #projectWeights() {
    const project = (box: BoxRenderable, split: Extract<LayoutNode, { type: "split" }>) => {
      const renderables = box.getChildren().filter((child) => !(child instanceof Divider))
      split.children.forEach((child, index) => {
        const renderable = renderables[index]
        if (!renderable) return
        setWeight(renderable, child.weight)
        if (child.type === "split" && renderable instanceof BoxRenderable) project(renderable, child)
      })
    }
    if (this.#layout.root?.type === "split") project(this.root, this.#layout.root)
  }

  /**
   * Exchange the focused pane with its neighbour in pane order, tmux's `{`/`}`.
   *
   * The panes trade places in the tree while each *slot* keeps its size, so a
   * swap rearranges the layout's contents without reshaping it. Focus travels
   * with the pane, which is what makes repeated presses walk it along.
   */
  swap(step: 1 | -1) {
    const from = this.focused
    if (!from) return
    const layout = this.exportLayout()
    const count = layoutPanes(layout.root).length
    if (count < 2) return
    const i = this.#slotOf(layout, from)
    if (i === -1) return
    const j = (i + step + count) % count
    // Swapping panes inside a preset arrangement leaves it that arrangement:
    // even-horizontal with two panes exchanged is still even-horizontal.
    this.applyLayout(swapLayout(layout, i, j), this.#state.preset)
  }

  /**
   * Split the focused pane, reusing its slot.
   *
   * If the parent already runs along the requested axis the new pane is just
   * inserted as a sibling; otherwise the pane is swapped for a nested Box so
   * the tree stays a proper h/v alternation instead of a flat list.
   */
  split(direction: SplitDirection, agent: Agent): TerminalPane | null {
    const target = this.focused
    if (!target) return this.mount(agent)

    // A focused pane the arrangement does not contain has no slot to split.
    // The layout is what answers that — not whether the pane is mounted, which
    // a zoom makes false for panes that do have slots.
    const layout = this.exportLayout()
    const at = this.#slotOf(layout, target)
    if (at === -1) return null

    // The newcomer is named before it exists, so the layout can say which pane
    // to focus even when it shows an agent this window is already showing. The
    // apply builds it under that id and focuses it, which is why nothing here
    // has to find the new pane by position afterwards.
    const id = newPaneId()
    const next = splitLayout(layout, at, direction, { id, agent: agent.id })
    if (!this.applyLayout(next)) return null
    return this.#panes.find((pane) => pane.id === id) ?? null
  }

  /**
   * Split, starting a new agent to fill the new pane.
   *
   * The acquiring half of split, kept separate from it deliberately. `split`
   * itself is a synchronous Layout transform and projection, covered by
   * geometry tests that have no business awaiting anything. Only the spawn
   * needs a lifetime, so only the spawn is an Effect, and the two compose.
   *
   * The unsplittable case is checked BEFORE spawning, so a window that cannot
   * take a split does not leave a live process behind with no pane on it.
   */
  splitSpawn(direction: SplitDirection, name?: string): Effect.Effect<TerminalPane | null> {
    const focused = this.focused
    if (focused && this.#slotOf(this.exportLayout(), focused) === -1) {
      return Effect.succeed(null)
    }
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
    // Works zoomed or not: the arrangement is read from the layout, which under
    // a zoom is the one the zoom captured, and projecting the result is what
    // drops the zoom. Closing the zoomed pane itself is the same path.
    const layout = this.exportLayout()
    const at = this.#slotOf(layout, pane)
    if (at === -1) return null
    // Losing a pane moves the window off whatever preset it matched: the
    // arrangement now has one fewer pane than the preset describes.
    const [evicted] = this.#project(closeLayout(layout, at), null)
    return evicted ?? null
  }

  /** Adopt a pane and its agent, detached from another window — break-pane's
   *  destination half. The process and its terminal state are untouched; only
   *  ownership moves, so the agent's hooks are re-pointed here and an exit
   *  closes the pane in the window it now lives in. The caller detaches first,
   *  so the pane arrives unmounted and with no other owner. */
  adopt(agent: Agent, pane: TerminalPane, scope: Scope.CloseableScope) {
    // The newcomer is hung straight off the root rather than projected, so the
    // zoom has to come down first: a zoomed window has its other panes
    // unmounted, and adding a second pane beside the zoomed one would leave
    // them stranded there with no arrangement on screen to rejoin.
    this.#unzoom()
    this.#agents.push(agent)
    // The scope comes from the window that relinquished it — see the note on
    // #scopes for why it travels rather than being re-forked here. Required,
    // not optional: an agent in a window without a scope is one nothing will
    // ever release, and making that unrepresentable is cheaper than detecting it.
    this.#scopes.set(agent, scope)
    this.#bind(agent)
    this.#panes.push(pane)
    pane.onFocusRequest = (p) => this.focus(p)
    this.#mount(appendPane(this.#layout, { id: pane.id, agent: agent.id }), null)
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
   * The model remains resident while zoom merely changes its projection to one
   * pane, so export never has to infer an arrangement from mounted renderables.
   * Dividers are absent from the model because one is derivable between every
   * adjacent sibling pair.
   */
  exportLayout(): Layout {
    return this.#layout
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
   * Rebuild the window from a new arrangement, returning the panes it had no
   * slot for.
   *
   * The projection half of applyLayout, split out because eviction is a
   * decision rather than a fact: applying a layout means the pane it dropped
   * was closed, while break-pane means that same pane is being handed to
   * another window alive. One rebuild, and the caller says what becomes of what
   * falls out of it.
   *
   * A reshape always drops the zoom. The layout a zoom would return to is the
   * one being replaced, so keeping it would mean unzooming later into an
   * arrangement that no longer describes this window.
   */
  #project(wanted: Layout, preset: LayoutPreset | null): TerminalPane[] {
    this.#state.zoom = null
    return this.#mount(wanted, preset)
  }

  /**
   * Put the window on screen as `wanted` says, under whatever zoom is in force.
   *
   * Two passes, because "which panes exist" and "how they are arranged" are
   * different questions and only the first is settled by the layout alone.
   * Separating them is what lets a zoom mount one pane without the others being
   * destroyed or parked somewhere off the tree: they are still panes of this
   * window, still in `#panes`, still fed by the sync fan-out — just not shown.
   */
  #mount(wanted: Layout, preset: LayoutPreset | null): TerminalPane[] {
    const byId = new Map(this.#agents.map((agent) => [agent.id, agent]))
    // An arbitrary layout matches no preset, so that is the default. A caller
    // that knows better says so: select-layout builds its arrangement FROM a
    // preset, and swapping two panes inside one leaves it that preset.
    this.#state.preset = preset

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

    // PASS ONE — which panes exist. Every slot ends up with a pane, reused or
    // freshly made, and `#panes` comes out in layout order whether or not the
    // pane is going to be mounted.
    for (const slot of slots) {
      const pane = filled.get(slot.id) ?? this.#makePane(byId.get(slot.agent)!, slot.id)
      filled.set(slot.id, pane)
      this.#panes.push(pane)
    }

    // An imported layout may name foreign pane IDs. The live pane keeps its own
    // identity, and the resident model records that resolved identity once,
    // before any renderables are built from it.
    const requestedFocus = wanted.focus ? filled.get(wanted.focus) : undefined
    const next = requestedFocus ?? this.#panes[0]
    const panesById = new Map<string, TerminalPane>()
    const materialize = (node: LayoutNode): LayoutNode => {
      if (node.type === "pane") {
        const pane = filled.get(node.id)!
        panesById.set(pane.id, pane)
        return { ...node, id: pane.id, agent: pane.agent.id }
      }
      return { ...node, children: node.children.map(materialize) }
    }
    this.#layout = makeLayout(wanted.root ? materialize(wanted.root) : null, next?.id)

    const build = (node: LayoutNode, path: LayoutPath): Renderable => {
      if (node.type === "pane") {
        const pane = panesById.get(node.id)!
        setWeight(pane, node.weight)
        return pane
      }
      const box = new BoxRenderable(this.#ctx, { id: `split-${nextId++}` })
      setDirection(box, node.direction)
      setWeight(box, node.weight)
      fill(box, node, path)
      return box
    }

    // Dividers are derived, never serialized: one sits between every adjacent
    // pair, which is the invariant split() maintains and refreshChrome reads.
    const fill = (box: BoxRenderable, node: Extract<LayoutNode, { type: "split" }>, path: LayoutPath) => {
      node.children.forEach((child, i) => {
        if (i > 0) box.add(this.#makeDivider(node.direction, path, i - 1))
        box.add(build(child, [...path, i]))
      })
    }

    // PASS TWO — how they are arranged. A split at the root goes *into* the
    // root box rather than under a fresh one: the root carries the outermost
    // axis itself (see split), and an extra level here would be a shape
    // exportLayout immediately collapses away.
    const zoom = this.#state.zoom
    if (zoom) {
      // One pane, no dividers, and every other pane left unmounted. Nothing
      // else has to be remembered for the way back: `zoom.from` is the whole
      // arrangement, and projecting it again is what restores it.
      const pane = panesById.get(zoom.pane)
      if (pane) {
        setWeight(pane, 1)
        this.root.add(pane)
      }
    } else if (this.#layout.root === null) {
      // Nothing to build: closing the last pane empties the window, which is a
      // state it really has until the app decides to close it.
    } else if (this.#layout.root.type === "split") {
      setDirection(this.root, this.#layout.root.direction)
      fill(this.root, this.#layout.root, [])
    } else {
      this.root.add(build(this.#layout.root, []))
    }

    if (next) {
      // Deliberately NOT clearing the focus first, the way this used to:
      // focus() records the pane being left as last-pane, and a rebuild that
      // moves focus is a change of mind exactly like a selection — tmux's
      // window_set_active_pane does this bookkeeping after a split, a close or
      // an arrange too. The one exception is a rebuild that keeps the same pane
      // focused, which focus() sees as no change and leaves the pair alone.
      this.focus(next)
    } else {
      // An empty window has no focus and nothing for last-pane to toggle to.
      this.#state.focus = null
      this.#layout = makeLayout(this.#layout.root)
    }
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
   *
   * The panes come from `#panes` rather than from walking the tree, because a
   * zoom leaves most of them unmounted and a walk would miss exactly those —
   * reporting the window as having lost the panes it is merely not showing.
   * Taking them off their parents first also leaves the walk with nothing but
   * derived nodes to destroy.
   */
  #dismantle(): TerminalPane[] {
    const panes = [...this.#panes]
    for (const pane of panes) (pane.parent as BoxRenderable | null)?.remove(pane)
    const walk = (box: BoxRenderable) => {
      // Children are copied before removal — removing while iterating the live
      // child list skips every other one.
      for (const child of [...box.getChildren()]) {
        box.remove(child)
        if (child instanceof Divider) child.destroy()
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
    return this.applyLayout(presetLayout(panes, preset, this.#state.focus ?? undefined), preset)
  }

  /** The preset this window was last arranged by, or null once a split, close
   *  or drag has moved it off that arrangement. Drives next-layout's cycle. */
  get preset(): LayoutPreset | null {
    return this.#state.preset
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
