import {
  Renderable,
  RGBA,
  type MouseEvent,
  type OptimizedBuffer,
  type RenderContext,
} from "@opentui/core"
import { STATUS_DOT } from "./pane.ts"
import type { Agent } from "./agent.ts"
import type { Workspace } from "./workspace.ts"

export const SIDEBAR_WIDTH = 30

const HEADER_H = 1
const FOOTER_H = 1
const SCROLL_ROWS = 3

// Catppuccin Mocha — same palette family as pane.ts
const BG = RGBA.fromInts(24, 24, 37, 255) // mantle
const HEADER_BG = RGBA.fromInts(49, 50, 68, 255) // surface0
const HEADER_FG = RGBA.fromInts(166, 173, 200, 255) // subtext0
const ROW_FG = RGBA.fromInts(205, 214, 244, 255) // text
const ROW_DIM = RGBA.fromInts(127, 132, 151, 255) // subtext0
const SELECT_BG = RGBA.fromInts(69, 71, 90, 255) // surface1
const HOVER_BG = RGBA.fromInts(88, 91, 112, 255) // overlay0
const WORKING_FG = RGBA.fromInts(166, 227, 161, 255) // green
const UNSEEN_FG = RGBA.fromInts(249, 226, 175, 255) // peach
const ACTIVE_FG = RGBA.fromInts(137, 180, 250, 255) // blue
const FOOTER_FG = RGBA.fromInts(127, 132, 151, 255) // subtext0

interface Row {
  marker: string
  dot: string
  dotFg: RGBA
  label: string
  labelFg: RGBA
  bg: RGBA
  indicators: string
}

/** Rough CJK/fullwidth detection for width-aware truncation. */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/

/** Truncate to `max` display columns, never overflowing. */
function truncate(text: string, max: number): string {
  if (max <= 0) return ""
  let w = 0
  let out = ""
  for (const ch of text) {
    const cw = WIDE.test(ch) ? 2 : 1
    if (w + cw > max) {
      if (w < max) out += "…"
      break
    }
    out += ch
    w += cw
  }
  return out
}

/**
 * A fixed-width agent list beside the workspace.
 *
 * Agents are first-class (they outlive panes), so this lists *every* agent —
 * including detached ones with no viewport — with status, OSC title, and the
 * foreground command, plus markers for detached / unseen / scrolled
 * (⇠, asterisk, ▲).
 * Rendering is manual into the shared buffer (like TerminalPane), so OpenTUI's
 * hit grid covers the whole sidebar for free: clicks resolve rows, and wheel
 * events scroll the list without any geometry math of our own.
 */
export class Sidebar extends Renderable {
  readonly workspace: Workspace

  /** Keyboard focus is held by the sidebar while this is true. */
  active = false
  onReveal?: () => void

  #selected = 0
  #scroll = 0
  #hover: number | null = null
  #dirty = true
  #rows: Row[] = []

  constructor(ctx: RenderContext, workspace: Workspace, width = SIDEBAR_WIDTH) {
    super(ctx, { id: "sidebar", width, flexShrink: 0 })
    this.workspace = workspace
  }

  get open(): boolean {
    return this.visible
  }

  get selected(): Agent | null {
    return this.workspace.agents[this.#selected] ?? null
  }

  /** Flip visibility. Yoga display:none hands the width back to the panes. */
  toggle(): boolean {
    this.visible = !this.visible
    this.#dirty = true
    this.requestRender()
    return this.visible
  }

  /** Repaint on workspace changes (output, exit, focus). Called from the
   *  workspace's onChange, which all three funnel through. */
  invalidate() {
    if (!this.visible) return
    this.#dirty = true
    this.requestRender()
  }

  /** Point the selection at the agent behind the focused pane. */
  selectFocused() {
    const agent = this.workspace.focused?.agent
    if (!agent) return
    const i = this.workspace.agents.indexOf(agent)
    if (i === -1) return
    this.#selected = i
    this.#ensureVisible()
    this.#dirty = true
    this.requestRender()
  }

  move(delta: number) {
    const len = this.workspace.agents.length
    if (!len) return
    this.#selected = Math.max(0, Math.min(len - 1, this.#selected + delta))
    this.#ensureVisible()
    this.#dirty = true
    this.requestRender()
  }

  /** Focus an existing view of the selected agent, or split one open. */
  reveal(): boolean {
    const agent = this.selected
    if (!agent) return false
    this.workspace.reveal(agent)
    this.onReveal?.()
    return true
  }

  /** Permanently stop the selected agent, closing any views of it. */
  killSelected(): boolean {
    const agent = this.selected
    if (!agent) return false
    this.workspace.killAgent(agent)
    return true
  }

  /** Keyboard handling while the sidebar holds focus. Returns false when the
   *  caller should hand focus back to the panes. */
  handleKey(bytes: string): boolean {
    switch (bytes) {
      case "j":
      case "\x1b[B":
        this.move(1)
        return true
      case "k":
      case "\x1b[A":
        this.move(-1)
        return true
      case "g":
      case "\x1b[H":
      case "\x1b[1~":
        this.move(-Infinity)
        return true
      case "G":
      case "\x1b[F":
      case "\x1b[4~":
        this.move(Infinity)
        return true
      case "\r":
      case "\n":
        return !this.reveal()
      case "x":
        this.killSelected()
        return true
      default:
        // Escape drops focus; everything else is swallowed while active.
        return bytes !== "\x1b"
    }
  }

  protected override onResize(width: number, height: number): void {
    this.#dirty = true
    super.onResize(width, height)
  }

  protected override onMouseEvent(event: MouseEvent): void {
    const ly = event.y - this.y
    switch (event.type) {
      case "over":
        this.#hover = this.#rowAt(ly)
        this.#dirty = true
        this.requestRender()
        return
      case "out":
        this.#hover = null
        this.#dirty = true
        this.requestRender()
        return
      case "scroll": {
        const dir = event.scroll?.direction
        if (dir === "up") this.#scrollBy(-SCROLL_ROWS)
        else if (dir === "down") this.#scrollBy(SCROLL_ROWS)
        event.stopPropagation()
        return
      }
      case "down": {
        if (event.button !== 0) return
        const i = this.#rowAt(ly)
        if (i !== null) {
          this.#selected = i
          this.#ensureVisible()
          this.#dirty = true
          this.reveal()
        }
        event.stopPropagation()
        return
      }
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.#dirty) {
      this.#rows = this.#buildRows()
      this.#dirty = false
    }
    const w = this.width
    const h = this.height
    const x = this.x
    const y = this.y

    buffer.fillRect(x, y, w, h, BG)

    buffer.fillRect(x, y, w, HEADER_H, HEADER_BG)
    const agents = this.workspace.agents
    const detached = this.workspace.detached.length
    const head = `${agents.length} agent${agents.length === 1 ? "" : "s"}` +
      (detached ? ` · ${detached} det` : "")
    buffer.drawText(truncate(head, w), x, y, HEADER_FG, HEADER_BG)

    const rowsH = h - HEADER_H - FOOTER_H
    for (let i = 0; i < rowsH; i++) {
      const row = this.#rows[i + this.#scroll]
      if (!row) break
      const ry = y + HEADER_H + i
      buffer.fillRect(x, ry, w, 1, row.bg)
      let cx = x
      buffer.drawText(row.marker, cx, ry, ACTIVE_FG, row.bg)
      cx += 1
      buffer.drawText(row.dot, cx, ry, row.dotFg, row.bg)
      cx += 2
      const ind = row.indicators
      const indX = x + w - ind.length
      if (indX > cx) {
        buffer.drawText(truncate(row.label, indX - cx), cx, ry, row.labelFg, row.bg)
      }
      if (ind) buffer.drawText(ind, indX, ry, row.labelFg, row.bg)
    }

    buffer.fillRect(x, y + h - FOOTER_H, w, FOOTER_H, BG)
    const foot = this.active ? "↑↓/jk select · ↵ show · x kill" : "^a b toggles sidebar"
    buffer.drawText(truncate(foot, w), x, y + h - FOOTER_H, FOOTER_FG, BG)
  }

  #buildRows(): Row[] {
    const agents = this.workspace.agents
    if (this.#selected >= agents.length) this.#selected = Math.max(0, agents.length - 1)
    const active = this.workspace.focused?.agent ?? null
    const detached = new Set(this.workspace.detached)
    const rows: Row[] = []
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!
      const done = a.status === "done"
      const fgCmd = a.foregroundCommand
      const label = fgCmd && fgCmd !== a.title ? `${a.title}: ${fgCmd}` : a.title
      rows.push({
        marker: active === a ? "▸" : " ",
        dot: STATUS_DOT[a.status],
        dotFg: a.status === "working" ? WORKING_FG : ROW_DIM,
        label,
        labelFg: done ? ROW_DIM : a.unseen ? UNSEEN_FG : ROW_FG,
        bg: i === this.#selected ? SELECT_BG : i === this.#hover ? HOVER_BG : BG,
        indicators:
          (detached.has(a) ? "⇠" : "") +
          (a.unseen ? "*" : "") +
          (a.scrolled ? "▲" : ""),
      })
    }
    return rows
  }

  #rowAt(ly: number): number | null {
    if (ly < HEADER_H || ly >= this.height - FOOTER_H) return null
    const i = ly - HEADER_H + this.#scroll
    return i >= 0 && i < this.workspace.agents.length ? i : null
  }

  #scrollBy(delta: number) {
    const max = Math.max(0, this.workspace.agents.length - (this.height - HEADER_H - FOOTER_H))
    this.#scroll = Math.max(0, Math.min(max, this.#scroll + delta))
    this.#dirty = true
    this.requestRender()
  }

  #ensureVisible() {
    const len = this.workspace.agents.length
    if (!len) return
    const visible = this.height - HEADER_H - FOOTER_H
    if (this.#selected < this.#scroll) this.#scroll = this.#selected
    else if (this.#selected >= this.#scroll + visible) {
      this.#scroll = this.#selected - visible + 1
    }
  }
}
