import { Terminal } from "./ghostty.ts"
import { spawnPty, readPty, type Pty } from "./pty.ts"
import { scrollViewport, ScrollTo } from "./shim.ts"

export type AgentStatus = "working" | "idle" | "done"

export interface AgentOptions {
  name: string
  cmd: string[]
  cwd?: string
  cols?: number
  rows?: number
}

let nextAgentId = 0

/**
 * A running process and its terminal state.
 *
 * Agents are the real entities: they own the PTY and the emulator, they keep
 * running whether or not anything is displaying them, and they outlive the
 * panes that view them. A TerminalPane is only a viewport.
 */
export class Agent {
  readonly id = `agent-${nextAgentId++}`
  readonly name: string
  readonly cmd: string[]
  readonly term: Terminal
  readonly startedAt = Date.now()

  #pty: Pty
  #exited = false
  #exitCode: number | null = null
  #lastOutputAt = 0
  #viewers = 0
  #unseen = false
  #scrolled = false

  /** Bumped whenever output arrives, so views can invalidate caches. */
  onOutput?: (agent: Agent) => void
  onExit?: (agent: Agent) => void
  /** Fired when scrolled state changes (scrollback entered or exited), so the
   *  sidebar's ▲ indicator stays accurate. */
  onScroll?: (agent: Agent) => void

  constructor(opts: AgentOptions) {
    this.name = opts.name
    this.cmd = opts.cmd
    const cols = opts.cols ?? 80
    const rows = opts.rows ?? 24
    this.term = new Terminal(cols, rows)
    this.#pty = spawnPty(opts.cmd, { cols, rows, cwd: opts.cwd })
    this.#pump()
  }

  async #pump() {
    for await (const chunk of readPty(this.#pty)) {
      this.term.write(chunk)
      this.#lastOutputAt = Date.now()
      if (this.#viewers === 0) this.#unseen = true
      this.onOutput?.(this)
    }
    this.#exited = true
    this.#exitCode = this.#pty.proc.exitCode ?? 0
    this.onExit?.(this)
  }

  /** Title reported by the child via OSC 0/2, falling back to the given name. */
  get title(): string {
    return this.term.title || this.name
  }

  get pwd(): string {
    return this.term.pwd
  }

  get exited() {
    return this.#exited
  }

  get exitCode() {
    return this.#exitCode
  }

  /** True when output has arrived that no pane was displaying. */
  get unseen() {
    return this.#unseen
  }

  get scrolled() {
    return this.#scrolled
  }

  /**
   * What the agent is doing right now.
   *
   * Uses the terminal's foreground process group rather than output activity:
   * a pgid different from the child's own means a command is in the foreground,
   * which is a far better "working" signal than "produced bytes recently" — an
   * agent thinking silently for a minute is still working.
   */
  get status(): AgentStatus {
    if (this.#exited) return "done"
    const fg = this.#pty.foregroundPgid()
    const shell = this.#pty.sessionId()
    if (fg > 0 && shell > 0 && fg !== shell) return "working"
    return "idle"
  }

  /** Command name of the foreground process, e.g. "vim" — "" when at a prompt. */
  get foregroundCommand(): string {
    if (this.#exited) return ""
    const fg = this.#pty.foregroundPgid()
    if (fg <= 0 || fg === this.#pty.sessionId()) return ""
    try {
      return require("node:fs").readFileSync(`/proc/${fg}/comm`, "utf8").trim()
    } catch {
      return ""
    }
  }

  get msSinceOutput() {
    return this.#lastOutputAt === 0 ? Infinity : Date.now() - this.#lastOutputAt
  }

  addViewer() {
    this.#viewers++
    this.#unseen = false
  }

  removeViewer() {
    this.#viewers = Math.max(0, this.#viewers - 1)
  }

  get viewers() {
    return this.#viewers
  }

  write(data: string | Uint8Array) {
    this.scrollToBottom()
    this.#pty.write(data)
  }

  /** Views share one terminal, so resize is last-writer-wins. See notes in
   *  workspace: two panes on one agent at different sizes will fight. */
  resize(cols: number, rows: number) {
    if (cols === this.term.cols && rows === this.term.rows) return
    this.term.resize(cols, rows)
    this.#pty.resize(cols, rows)
  }

  scrollBy(rows: number) {
    scrollViewport(this.term.handle, ScrollTo.delta, rows)
    this.#scrolled = true
    this.onScroll?.(this)
  }

  scrollToBottom() {
    if (!this.#scrolled) return
    this.#scrolled = false
    scrollViewport(this.term.handle, ScrollTo.bottom)
    this.onScroll?.(this)
  }

  kill() {
    this.#pty.kill()
  }

  dispose() {
    this.kill()
    this.term.free()
  }
}
