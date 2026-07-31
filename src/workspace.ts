import { BoxRenderable, type RenderContext, type Renderable } from "@opentui/core"
import { TerminalPane } from "./pane.ts"
import { Agent } from "./agent.ts"

export type SplitDirection = "row" | "column"

let nextId = 0

/**
 * A tmux-style split tree.
 *
 * Layout itself is delegated to opentui: every split is a flex Box, so yoga
 * computes the geometry and — because hit-testing is a byproduct of rendering —
 * clicking and hovering keep working through arbitrary nesting with no
 * coordinate math of our own.
 */
export class Workspace {
  readonly root: BoxRenderable
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

  constructor(ctx: RenderContext, shell: string[], cwd?: string) {
    this.#ctx = ctx
    this.#shell = shell
    this.#cwd = cwd
    this.root = new BoxRenderable(ctx, {
      id: "workspace",
      flexDirection: "row",
      flexGrow: 1,
    })
  }

  get panes(): readonly TerminalPane[] {
    return this.#panes
  }

  /** Every agent, including ones no pane is currently showing. This is what
   *  the sidebar lists. */
  get agents(): readonly Agent[] {
    return this.#agents
  }

  /** Agents with no viewport open — running, but off-screen. */
  get detached(): Agent[] {
    return this.#agents.filter((a) => a.viewers === 0)
  }

  /** Start an agent without opening a view onto it. */
  spawn(name: string, cmd = this.#shell, cwd = this.#cwd): Agent {
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

  #makePane(agent: Agent): TerminalPane {
    const pane = new TerminalPane(this.#ctx, {
      id: `pane-${nextId++}`,
      agent,
      flexGrow: 1,
      flexBasis: 0,
    })
    pane.onFocusRequest = (p) => this.focus(p)
    this.#panes.push(pane)
    return pane
  }

  /** Seed the workspace with a single agent and a view onto it. */
  init(name = "shell"): TerminalPane {
    const pane = this.#makePane(this.spawn(name))
    this.root.add(pane)
    this.focus(pane)
    return pane
  }

  focus(pane: TerminalPane) {
    this.#focused = pane
    for (const p of this.#panes) p.active = p === pane
    this.onChange?.()
    this.#ctx.requestRender()
  }

  focusNext(step = 1) {
    if (!this.#panes.length) return
    const i = this.#focused ? this.#panes.indexOf(this.#focused) : -1
    const next = (i + step + this.#panes.length) % this.#panes.length
    this.focus(this.#panes[next]!)
  }

  /**
   * Split the focused pane, reusing its slot.
   *
   * If the parent already runs along the requested axis the new pane is just
   * inserted as a sibling; otherwise the pane is swapped for a nested Box so
   * the tree stays a proper h/v alternation instead of a flat list.
   */
  split(direction: SplitDirection, agent?: Agent, name = "shell"): TerminalPane | null {
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

    if (parent.flexDirection === direction && parent !== this.root) {
      parent.add(pane, parent.getChildren().indexOf(target) + 1)
    } else if (parent === this.root && parent.getChildrenCount() === 1) {
      // Root still holds a single pane, so it can simply adopt the axis.
      parent.flexDirection = direction
      parent.add(pane)
    } else {
      const index = parent.getChildren().indexOf(target)
      const box = new BoxRenderable(this.#ctx, {
        id: `split-${nextId++}`,
        flexDirection: direction,
        flexGrow: 1,
        flexBasis: 0,
      })
      parent.remove(target)
      box.add(target)
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
    parent?.remove(pane)
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
