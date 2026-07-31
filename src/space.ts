import { BoxRenderable, type RenderContext } from "@opentui/core"
import { Workspace } from "./workspace.ts"
import type { Agent } from "./agent.ts"
import type { AgentState } from "./agent.ts"

let nextSpaceId = 0

/**
 * A named working context with a directory attached.
 *
 * A space owns its agents *and* its own split tree, tmux-session style:
 * selecting a space swaps the whole pane area over to that space's layout, and
 * a pane only ever shows agents belonging to its space. That is why Workspace
 * is one-per-space rather than a singleton — the layout is part of the context
 * you switch between, not a global.
 */
export class Space {
  readonly id = `space-${nextSpaceId++}`
  readonly workspace: Workspace
  name: string
  dir: string

  /** Git branch of `dir`, refreshed by the app. "" when not a checkout. */
  branch = ""
  /** Commits ahead/behind the upstream, for the sidebar's second row. */
  ahead = 0
  behind = 0

  constructor(ctx: RenderContext, opts: { name: string; dir: string; shell: string[] }) {
    this.name = opts.name
    this.dir = opts.dir
    this.workspace = new Workspace(ctx, opts.shell, opts.dir)
  }

  get agents(): readonly Agent[] {
    return this.workspace.agents
  }

  get root(): BoxRenderable {
    return this.workspace.root
  }

  /**
   * The space's state icon is the most urgent state among its agents: an agent
   * waiting on you matters more than one that is merely busy, which matters
   * more than an idle prompt.
   */
  get state(): AgentState {
    // Ranked by how much it wants your attention. "done" is last: a space with
    // one live idle agent and one finished agent is idle, not finished.
    const RANK: Record<AgentState, number> = { blocked: 3, working: 2, idle: 1, done: 0 }
    let best: AgentState = "done"
    for (const a of this.agents) {
      const s = a.state
      if (s === "blocked") return "blocked"
      if (RANK[s] > RANK[best]) best = s
    }
    return best
  }

  dispose() {
    this.workspace.disposeAll()
  }
}

/**
 * The set of spaces and which one is on screen.
 *
 * Only the active space's layout is mounted, so inactive spaces keep their
 * split trees intact (and their agents running) while contributing nothing to
 * yoga or the hit grid.
 */
export class SpaceSet {
  #ctx: RenderContext
  #host: BoxRenderable
  #shell: string[]
  #spaces: Space[] = []
  #active: Space | null = null
  onChange?: () => void
  /** Forwarded from every space's workspace. */
  onAgentExit?: (agent: Agent, space: Space) => void

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

  /** Every agent across every space — what a global "N agents" count means. */
  get allAgents(): Agent[] {
    return this.#spaces.flatMap((s) => [...s.agents])
  }

  create(name: string, dir = process.cwd()): Space {
    const space = new Space(this.#ctx, { name, dir, shell: this.#shell })
    space.workspace.onChange = () => this.onChange?.()
    space.workspace.onAgentExit = (agent) => this.onAgentExit?.(agent, space)
    this.#spaces.push(space)
    if (!this.#active) this.activate(space)
    else this.onChange?.()
    return space
  }

  activate(space: Space) {
    if (this.#active === space) return
    // Detach rather than destroy: the inactive space keeps its split tree and
    // its agents, so switching back restores the exact layout.
    if (this.#active) this.#host.remove(this.#active.root)
    this.#active = space
    this.#host.add(space.root)
    // Re-focus so keystrokes land in this space's pane, not the old one's.
    const pane = space.workspace.focused ?? space.workspace.panes[0]
    if (pane) space.workspace.focus(pane)
    this.onChange?.()
    this.#ctx.requestRender()
  }

  /** Move to the next/previous space in order. */
  cycle(step = 1) {
    if (this.#spaces.length < 2) return
    const i = this.#active ? this.#spaces.indexOf(this.#active) : -1
    this.activate(this.#spaces[(i + step + this.#spaces.length) % this.#spaces.length]!)
  }

  find(agent: Agent): Space | null {
    return this.#spaces.find((s) => s.agents.includes(agent)) ?? null
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
    // Unmount before disposing: the active space's panes are still in the
    // render tree and would draw from terminals that are being freed.
    if (this.#active) this.#host.remove(this.#active.root)
    for (const s of [...this.#spaces]) s.dispose()
    this.#spaces.length = 0
    this.#active = null
  }
}
