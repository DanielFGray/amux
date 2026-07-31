import { Terminal, RenderState } from "./ghostty.ts"
import { spawnPty, readPty, type Pty } from "./pty.ts"
import { scrollViewport, ScrollTo } from "./shim.ts"
import { splitActivity, looksBlocked, type AgentState } from "./detect.ts"

export type { AgentState }
/** @deprecated use AgentState — kept so older call sites keep compiling. */
export type AgentStatus = AgentState

/** How often the screen is re-scanned for a "waiting on you" prompt. Blocked
 *  state changes are human-paced, so a few times a second is ample and keeps
 *  the scan off the render path for busy agents. */
const BLOCKED_POLL_MS = 250

/** How many of the last written rows are searched for a prompt. A confirmation
 *  UI is the most recent thing on screen by definition, so a short tail is
 *  enough and scanning the whole grid would cost several times more. */
const BLOCKED_SCAN_ROWS = 20

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
  /** Lazily created: only agents actually asked for their state pay for it. */
  #detect: RenderState | null = null
  #blockedCache = false
  #blockedAt = 0
  #blockedSeenOutput = -1

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

  /** Title reported by the child via OSC 0/2, falling back to the given name.
   *  The leading activity glyph is stripped: it is state, not a name, and we
   *  render it ourselves as an animated state icon. */
  get title(): string {
    const raw = this.term.title
    if (!raw) return this.name
    return splitActivity(raw).text || this.name
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

  /** True when the viewport is parked in history rather than following output.
   *  Asked of ghostty rather than tracked locally: it clamps scrolls at both
   *  edges, so a counter of our own drifts out of sync the first time the user
   *  scrolls past the top or the bottom. */
  get scrolled(): boolean {
    return !this.#exited && !this.term.atBottom
  }

  /**
   * What the agent is doing right now.
   *
   * Three signals, most specific first:
   *
   * 1. An activity spinner in the OSC title — the agent CLI telling us outright
   *    that it is thinking. This is the only signal that works for `claude` or
   *    `codex`, which never leave the foreground and so look permanently busy
   *    to any process-based check.
   * 2. A recognised confirmation prompt on screen, meaning it has stopped and
   *    is waiting on a human. Polled, not computed per read: see the note on
   *    BLOCKED_POLL_MS.
   * 3. Foreground process group vs session leader, which is the right answer
   *    for a plain shell running an ordinary command.
   */
  get state(): AgentState {
    if (this.#exited) return "done"
    if (splitActivity(this.term.title).spinning) return "working"
    if (this.#blocked()) return "blocked"
    const fg = this.#pty.foregroundPgid()
    const shell = this.#pty.sessionId()
    if (fg > 0 && shell > 0 && fg !== shell) return "working"
    return "idle"
  }

  /** @deprecated use `state`. */
  get status(): AgentState {
    return this.state
  }

  /** Cached screen scan. Recomputed at most every BLOCKED_POLL_MS, and only
   *  when output has actually arrived since the last scan. */
  #blocked(): boolean {
    const now = Date.now()
    if (now - this.#blockedAt < BLOCKED_POLL_MS) return this.#blockedCache
    if (this.#blockedAt > 0 && this.#lastOutputAt <= this.#blockedSeenOutput) {
      this.#blockedAt = now
      return this.#blockedCache
    }
    this.#blockedAt = now
    this.#blockedSeenOutput = this.#lastOutputAt
    this.#detect ??= new RenderState()
    this.#detect.update(this.term)
    this.#blockedCache = looksBlocked(this.#detect.tailText(BLOCKED_SCAN_ROWS))
    return this.#blockedCache
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
    const before = this.scrolled
    scrollViewport(this.term.handle, ScrollTo.delta, rows)
    if (this.scrolled !== before) this.onScroll?.(this)
  }

  scrollToBottom() {
    if (!this.scrolled) return
    scrollViewport(this.term.handle, ScrollTo.bottom)
    this.onScroll?.(this)
  }

  kill() {
    this.#pty.kill()
  }

  dispose() {
    this.kill()
    this.#detect?.free()
    this.#detect = null
    this.term.free()
  }
}
