import { BoxRenderable, type RenderContext } from "@opentui/core"
import { Window } from "./window.ts"
import type { Agent, AgentState } from "./agent.ts"

let nextSpaceId = 0

/**
 * A named working context with a directory attached.
 *
 * The top of the tmux hierarchy: a space holds windows, a window holds panes.
 * A space owns its own container, and only its active window's split tree is
 * mounted inside it — so every other window keeps its layout and its running
 * agents while contributing nothing to yoga or the hit grid.
 */
export class Space {
  readonly id = `space-${nextSpaceId++}`
  readonly root: BoxRenderable
  name: string
  dir: string

  /** Git branch of `dir`, refreshed by the app. "" when not a checkout. */
  branch = ""
  /** Commits ahead/behind the upstream, for the sidebar's second row. */
  ahead = 0
  behind = 0

  #ctx: RenderContext
  #shell: string[]
  #windows: Window[] = []
  #active: Window | null = null
  #nextNumber = 1

  onChange?: () => void
  onAgentExit?: (agent: Agent, window: Window, space: Space) => void

  constructor(ctx: RenderContext, opts: { name: string; dir: string; shell: string[] }) {
    this.#ctx = ctx
    this.#shell = opts.shell
    this.name = opts.name
    this.dir = opts.dir
    this.root = new BoxRenderable(ctx, {
      id: `space-root-${this.id}`,
      flexDirection: "row",
      flexGrow: 1,
    })
  }

  get windows(): readonly Window[] {
    return this.#windows
  }

  get active(): Window | null {
    return this.#active
  }

  /** Every agent across every window in this space. */
  get agents(): Agent[] {
    return this.#windows.flatMap((w) => [...w.agents])
  }

  /**
   * The space's state icon is the most urgent state among its agents: an agent
   * waiting on you matters more than one that is merely busy, which matters
   * more than an idle prompt. "done" is last, so a space with one live idle
   * agent and one finished agent reads as idle, not finished.
   */
  get state(): AgentState {
    return rollUp(this.agents)
  }

  /** Create a window and switch to it. */
  newWindow(name?: string): Window {
    const window = new Window(this.#ctx, this.#shell, this.dir, this.#nextNumber++)
    if (name) window.customName = name
    window.onChange = () => this.onChange?.()
    window.onAgentExit = (agent) => this.onAgentExit?.(agent, window, this)
    this.#windows.push(window)
    this.selectWindow(window)
    return window
  }

  selectWindow(window: Window) {
    if (this.#active === window) return
    // Detach rather than destroy, so the window keeps its split tree.
    if (this.#active) this.root.remove(this.#active.root)
    this.#active = window
    this.root.add(window.root)
    const pane = window.focused ?? window.panes[0]
    if (pane) window.focus(pane)
    this.onChange?.()
    this.#ctx.requestRender()
  }

  /** Select by 1-based number, the way `^a 1..9` does. */
  selectNumber(number: number): boolean {
    const window = this.#windows.find((w) => w.number === number)
    if (!window) return false
    this.selectWindow(window)
    return true
  }

  cycleWindow(step = 1) {
    if (this.#windows.length < 2) return
    const i = this.#active ? this.#windows.indexOf(this.#active) : -1
    this.selectWindow(this.#windows[(i + step + this.#windows.length) % this.#windows.length]!)
  }

  /** Redraw every window's borders after `frame.externalLeft` changed. */
  refreshChrome() {
    for (const w of this.#windows) w.refreshChrome()
  }

  /** Close a window and everything running in it. */
  closeWindow(window: Window) {
    const i = this.#windows.indexOf(window)
    if (i === -1) return
    this.#windows.splice(i, 1)
    if (this.#active === window) {
      this.root.remove(window.root)
      this.#active = null
      const next = this.#windows[Math.min(i, this.#windows.length - 1)]
      if (next) this.selectWindow(next)
    }
    window.disposeAll()
    this.onChange?.()
    this.#ctx.requestRender()
  }

  dispose() {
    // Unmount before disposing: the active window's panes are still in the
    // render tree and would draw from terminals that are being freed.
    if (this.#active) this.root.remove(this.#active.root)
    for (const w of this.#windows) w.disposeAll()
    this.#windows.length = 0
    this.#active = null
  }
}

/** Ranked by how much it wants your attention. Shared by spaces and windows. */
export function rollUp(agents: readonly Agent[]): AgentState {
  const RANK: Record<AgentState, number> = { blocked: 3, working: 2, idle: 1, done: 0 }
  let best: AgentState = "done"
  for (const a of agents) {
    const s = a.state
    if (s === "blocked") return "blocked"
    if (RANK[s] > RANK[best]) best = s
  }
  return best
}

/**
 * The next blocked agent after `from` in a stable order, or the first one when
 * nothing is focused — scanning forward and wrapping around.
 *
 * Starting *after* `from` is what makes repeated presses walk the set: the
 * agent you are looking at is already on screen, so it is not the one the next
 * press is looking for. The full wrap keeps a lone blocked agent reachable,
 * where landing on it again is a no-op rather than a jump.
 *
 * Returns null when no agent is blocked.
 */
export function nextBlockedAfter(order: readonly Agent[], from: Agent | null): Agent | null {
  const n = order.length
  if (!n) return null
  const start = from ? order.indexOf(from) + 1 : 0
  for (let step = 0; step < n; step++) {
    const agent = order[(start + step) % n]!
    if (agent.state === "blocked") return agent
  }
  return null
}

/**
 * The set of spaces and which one is on screen.
 *
 * Only the active space's container is mounted, so an inactive space keeps its
 * windows, their layouts and their agents entirely off the layout tree.
 */
export class SpaceSet {
  #ctx: RenderContext
  #host: BoxRenderable
  #shell: string[]
  #spaces: Space[] = []
  #active: Space | null = null
  onChange?: () => void
  onAgentExit?: (agent: Agent, window: Window, space: Space) => void

  constructor(ctx: RenderContext, host: BoxRenderable, shell: string[]) {
    this.#ctx = ctx
    this.#host = host
    this.#shell = shell
  }

  get spaces(): readonly Space[] {
    return this.#spaces
  }

  get active(): Space | null {
    return this.#active
  }

  /** The window keystrokes currently land in. */
  get activeWindow(): Window | null {
    return this.#active?.active ?? null
  }

  /** Every agent across every space — what a global "N agents" count means. */
  get allAgents(): Agent[] {
    return this.#spaces.flatMap((s) => s.agents)
  }

  create(name: string, dir = process.cwd()): Space {
    const space = new Space(this.#ctx, { name, dir, shell: this.#shell })
    space.onChange = () => this.onChange?.()
    space.onAgentExit = (agent, window) => this.onAgentExit?.(agent, window, space)
    this.#spaces.push(space)
    if (!this.#active) this.activate(space)
    else this.onChange?.()
    return space
  }

  activate(space: Space) {
    if (this.#active === space) return
    if (this.#active) this.#host.remove(this.#active.root)
    this.#active = space
    this.#host.add(space.root)
    // Re-focus so keystrokes land in this space's pane, not the old one's.
    const window = space.active
    const pane = window?.focused ?? window?.panes[0]
    if (window && pane) window.focus(pane)
    this.onChange?.()
    this.#ctx.requestRender()
  }

  /** Redraw every pane frame everywhere — an inactive space's windows too, so
   *  switching back to one does not reveal a stale border. */
  refreshChrome() {
    for (const s of this.#spaces) s.refreshChrome()
  }

  cycle(step = 1) {
    if (this.#spaces.length < 2) return
    const i = this.#active ? this.#spaces.indexOf(this.#active) : -1
    this.activate(this.#spaces[(i + step + this.#spaces.length) % this.#spaces.length]!)
  }

  find(agent: Agent): Space | null {
    return this.#spaces.find((s) => s.agents.includes(agent)) ?? null
  }

  /**
   * Jump to the next blocked agent and bring it on screen — the herding loop.
   *
   * The agent worth your attention is the one waiting on a human, so a single
   * press walks the blocked set across every space instead of tabbing through
   * panes. Order is stable: spaces in creation order, then windows, then spawn
   * order within a window, so repeated presses advance rather than bouncing
   * between two. Navigation is the same as clicking the sidebar row — the
   * agent's space is activated, its window selected, and it is revealed (or
   * focused) even when no pane shows it. Returns the agent, or null when
   * nothing is blocked.
   */
  nextBlocked(from: Agent | null = this.activeWindow?.focused?.agent ?? null): Agent | null {
    const target = nextBlockedAfter(this.allAgents, from)
    if (!target) return null
    const space = this.find(target)
    const window = space?.windows.find((w) => w.agents.includes(target))
    if (!space || !window) return null
    this.activate(space)
    space.selectWindow(window)
    window.reveal(target)
    return target
  }

  remove(space: Space) {
    const i = this.#spaces.indexOf(space)
    if (i === -1) return
    this.#spaces.splice(i, 1)
    if (this.#active === space) {
      this.#host.remove(space.root)
      this.#active = null
      const next = this.#spaces[Math.min(i, this.#spaces.length - 1)]
      if (next) this.activate(next)
    }
    space.dispose()
    this.onChange?.()
    this.#ctx.requestRender()
  }

  disposeAll() {
    if (this.#active) this.#host.remove(this.#active.root)
    for (const s of [...this.#spaces]) s.dispose()
    this.#spaces.length = 0
    this.#active = null
  }
}
