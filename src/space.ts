import { BoxRenderable, type RenderContext } from "@opentui/core"
import { Context, Effect, Exit, Scope } from "effect"
import { Window } from "./window.ts"
import type { Agent, AgentState } from "./agent.ts"
import type { TerminalPane } from "./pane.ts"
import { RenderCtx, type WorkspaceEnv } from "./env.ts"

let nextSpaceId = 0

/** Keep the generator ahead of every id restore brought back, so a space
 *  created after a restore cannot collide with one that came out of the file. */
function reserveSpaceId(id: string) {
  const n = /^space-(\d+)$/.exec(id)
  if (n) nextSpaceId = Math.max(nextSpaceId, Number(n[1]) + 1)
}

/**
 * A named working context with a directory attached.
 *
 * The top of the tmux hierarchy: a space holds windows, a window holds panes.
 * A space owns its own container, and only its active window's split tree is
 * mounted inside it — so every other window keeps its layout and its running
 * agents while contributing nothing to yoga or the hit grid.
 */
export class Space {
  readonly id: string
  readonly root: BoxRenderable
  name: string
  dir: string

  /** Git branch of `dir`, refreshed by the app. "" when not a checkout. */
  branch = ""
  /** Commits ahead/behind the upstream, for the sidebar's second row. */
  ahead = 0
  behind = 0

  /** Passed down to every window this space opens, unread here beyond the
   *  renderer — a space is a container, not a thing that starts processes. */
  #env: Context.Context<WorkspaceEnv>
  #ctx: RenderContext
  #windows: Window[] = []
  /** One scope per window, for the same reason Window keeps one per agent:
   *  closeWindow must end exactly one window, and a window will eventually be
   *  movable between spaces (ts-e10c3a), which a forked child scope forbids. */
  #scopes = new Map<Window, Scope.CloseableScope>()
  #active: Window | null = null
  /** The window that was active before the current one, for last-window. See
   *  selectWindow() for how it moves, and closeWindow() for the rule that
   *  keeps it from ever naming a window that no longer exists. */
  #last: Window | null = null
  #nextNumber = 1

  onChange?: () => void
  onAgentExit?: (agent: Agent, window: Window, space: Space) => void
  onCopy?: (text: string) => boolean | void
  onCopyError?: (error: Error) => void

  constructor(env: Context.Context<WorkspaceEnv>, opts: { name: string; dir: string; id?: string }) {
    this.#env = env
    this.#ctx = Context.get(env, RenderCtx)
    this.id = opts.id ?? `space-${nextSpaceId++}`
    if (opts.id) reserveSpaceId(opts.id)
    this.name = opts.name
    this.dir = opts.dir
    this.root = new BoxRenderable(this.#ctx, {
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
   * more than an idle prompt. A detached agent is surfaced above idle because
   * the UI cannot know whether it is waiting or still working without an
   * attachment. "done" is last, so a space with one live idle agent and one
   * finished agent reads as idle, not finished.
   */
  get state(): AgentState {
    return rollUp(this.agents)
  }

  /**
   * Create a window and switch to it.
   *
   * `number` is only passed by restore, which must bring a window back under
   * the number the user knows it by — `^a 3` has to keep meaning the same
   * window across a restart. The counter is pushed past any number claimed that
   * way, so a window created afterwards still gets a free one.
   */
  newWindow(name?: string, number?: number): Effect.Effect<Window> {
    return Effect.gen(this, function* () {
      if (number !== undefined) this.#nextNumber = Math.max(this.#nextNumber, number + 1)
      const scope = yield* Scope.make()
      const window = yield* Window.make(this.#env, this.dir, number ?? this.#nextNumber++).pipe(
        Scope.extend(scope),
      )
      this.#scopes.set(window, scope)
      if (name) window.customName = name
      window.onChange = () => this.onChange?.()
      window.onAgentExit = (agent) => this.onAgentExit?.(agent, window, this)
      window.onCopy = this.onCopy
      window.onCopyError = this.onCopyError
      this.#windows.push(window)
      this.selectWindow(window)
      return window
    })
  }

  selectWindow(window: Window) {
    if (this.#active === window) return
    // Detach rather than destroy, so the window keeps its split tree.
    if (this.#active) this.root.remove(this.#active.root)
    // The window being left becomes last-window's other endpoint, the way
    // tmux's session_set_current records a last window on every select.
    this.#last = this.#active
    this.#active = window
    this.root.add(window.root)
    const pane = window.focused ?? window.panes[0]
    if (pane) window.focus(pane)
    this.onChange?.()
    this.#ctx.requestRender()
  }

  /**
   * Select the previously active window — tmux's last-window.
   *
   * Repeated presses toggle between the two most recent windows, the way
   * last-pane toggles between panes. A window closed since it was last is
   * skipped rather than selected: closeWindow() clears it, and this check
   * keeps the promise even if something else left a stale reference behind.
   */
  selectLastWindow() {
    const last = this.#last
    if (!last || !this.#windows.includes(last)) return
    this.selectWindow(last)
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

  /**
   * Break a pane out of its window into a new one — tmux's break-pane.
   *
   * The pane and its agent are MOVED, not restarted: the process keeps its
   * PTY, its terminal, its scrollback and its title. Only ownership changes,
   * which is why the agent's lifecycle hooks are re-pointed at the destination
   * window — an exit must close the pane in the window it now lives in and
   * fire that window's onAgentExit, or the app-level cascade would act on
   * stale ownership.
   *
   * The source window collapses to its remaining panes (the same tree surgery
   * close() does, minus the destruction). A window left with no panes is
   * closed, the way tmux closes a window it just emptied — unless it still
   * holds running agents, which are never discarded silently (the rule
   * afterAgentExit uses).
   *
   * The destination window takes the next number and becomes active, which is
   * tmux's session_select after a break. Returns the new window, or null when
   * the pane is not in this space.
   */
  breakPane(pane: TerminalPane): Effect.Effect<Window | null> {
    return Effect.gen(this, function* () {
      const source = this.#windows.find((w) => w.panes.includes(pane))
      if (!source) return null
      const agent = pane.agent
      // Ownership is checked BEFORE anything is mutated. The agent's scope has
      // to travel with it — the source window may be closed below, and closing
      // it must not end a process that now lives elsewhere — so a break that
      // could not hand the scope over has to be refused while it is still a
      // no-op, rather than half-done with a detached pane nothing will release.
      if (!source.agents.includes(agent)) return null
      if (!source.detachPane(pane)) return null
      const scope = source.relinquishAgent(agent)!

      const window = yield* this.newWindow()
      window.adopt(agent, pane, scope)

      if (source.panes.length === 0 && !source.agents.some((a) => a.state !== "done")) {
        yield* this.closeWindow(source)
      }
      return window
    })
  }

  /** Redraw every window's borders after `frame.externalLeft` changed. */
  refreshChrome() {
    for (const w of this.#windows) w.refreshChrome()
  }

  /** Close a window and everything running in it. */
  closeWindow(window: Window): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const i = this.#windows.indexOf(window)
      if (i === -1) return
      this.#windows.splice(i, 1)
      if (this.#active === window) {
        this.root.remove(window.root)
        this.#active = null
        // Land on the window that was active before this one — the way tmux's
        // session_detach prefers last over a neighbour when the current window
        // dies — falling back to a neighbour when there was none. #active is
        // already null here, so selectWindow records an empty #last rather
        // than letting the pair's other endpoint be a window that is gone.
        const next =
          (this.#last && this.#windows.includes(this.#last) ? this.#last : null) ??
          this.#windows[Math.min(i, this.#windows.length - 1)] ??
          null
        if (next) {
          this.selectWindow(next)
        } else {
          this.#last = null
        }
      } else if (this.#last === window) {
        // The toggle's other endpoint is gone: no closed window may stay
        // reachable from last-window.
        this.#last = null
      }
      yield* this.#releaseWindow(window)
      this.onChange?.()
      this.#ctx.requestRender()
    })
  }

  #releaseWindow(window: Window): Effect.Effect<void> {
    const scope = this.#scopes.get(window)
    this.#scopes.delete(window)
    return scope ? Scope.close(scope, Exit.void) : window.release
  }

  /**
   * A space whose windows are released when the surrounding scope closes.
   */
  static make(
    env: Context.Context<WorkspaceEnv>,
    opts: { name: string; dir: string; id?: string },
  ): Effect.Effect<Space, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new Space(env, opts)),
      (space) => space.release,
    )
  }

  get release(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      // Unmount before disposing: the active window's panes are still in the
      // render tree and would draw from terminals that are being freed.
      if (this.#active) this.root.remove(this.#active.root)
      for (const w of [...this.#windows]) yield* this.#releaseWindow(w)
      this.#windows.length = 0
      this.#active = null
    })
  }
}

/** Ranked by how much it wants your attention. Shared by spaces and windows. */
export function rollUp(agents: readonly Agent[]): AgentState {
  const RANK: Record<AgentState, number> = { blocked: 4, working: 3, detached: 2, idle: 1, done: 0 }
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
  #env: Context.Context<WorkspaceEnv>
  #ctx: RenderContext
  #host: BoxRenderable
  #spaces: Space[] = []
  #scopes = new Map<Space, Scope.CloseableScope>()
  #active: Space | null = null
  onChange?: () => void
  onAgentExit?: (agent: Agent, window: Window, space: Space) => void
  onCopy?: (text: string) => boolean | void
  onCopyError?: (error: Error) => void

  constructor(env: Context.Context<WorkspaceEnv>, host: BoxRenderable) {
    this.#env = env
    this.#ctx = Context.get(env, RenderCtx)
    this.#host = host
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

  create(name: string, dir = process.cwd(), id?: string): Effect.Effect<Space> {
    return Effect.gen(this, function* () {
      const scope = yield* Scope.make()
      const space = yield* Space.make(this.#env, { name, dir, id }).pipe(Scope.extend(scope))
      this.#scopes.set(space, scope)
      space.onChange = () => this.onChange?.()
      space.onAgentExit = (agent, window) => this.onAgentExit?.(agent, window, space)
      space.onCopy = this.onCopy
      space.onCopyError = this.onCopyError
      this.#spaces.push(space)
      if (!this.#active) this.activate(space)
      else this.onChange?.()
      return space
    })
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

  remove(space: Space): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const i = this.#spaces.indexOf(space)
      if (i === -1) return
      this.#spaces.splice(i, 1)
      if (this.#active === space) {
        this.#host.remove(space.root)
        this.#active = null
        const next = this.#spaces[Math.min(i, this.#spaces.length - 1)]
        if (next) this.activate(next)
      }
      yield* this.#releaseSpace(space)
      this.onChange?.()
      this.#ctx.requestRender()
    })
  }

  #releaseSpace(space: Space): Effect.Effect<void> {
    const scope = this.#scopes.get(space)
    this.#scopes.delete(space)
    return scope ? Scope.close(scope, Exit.void) : space.release
  }

  /**
   * A workspace whose spaces — and so every window, agent and PTY under them —
   * are released when the surrounding scope closes.
   *
   * This is the root of the lifetime chain: one scope at the top of the app
   * ends every child process, in the right order, on any exit path.
   */
  static make(
    env: Context.Context<WorkspaceEnv>,
    host: BoxRenderable,
  ): Effect.Effect<SpaceSet, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new SpaceSet(env, host)),
      (spaces) => spaces.release,
    )
  }

  get release(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (this.#active) this.#host.remove(this.#active.root)
      for (const s of [...this.#spaces]) yield* this.#releaseSpace(s)
      this.#spaces.length = 0
      this.#active = null
    })
  }
}
