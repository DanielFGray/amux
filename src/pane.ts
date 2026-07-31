import {
  Renderable,
  RGBA,
  type MouseEvent,
  type OptimizedBuffer,
  type RenderContext,
} from "@opentui/core"
import {
  RenderState,
  MouseEncoder,
  MouseAction,
  MouseButton,
  CursorStyle,
  Dirty,
  type CursorInfo,
} from "./ghostty.ts"
import type { Agent } from "./agent.ts"
import { runtime } from "./config.ts"
import { SPINNER_FRAMES, STATE_GLYPH } from "./detect.ts"

const DEFAULT_FG = RGBA.fromInts(205, 214, 244, 255)
const DEFAULT_BG = RGBA.fromInts(30, 30, 46, 255)
const FOCUS_BG = RGBA.fromInts(137, 180, 250, 255)
const HOVER_BG = RGBA.fromInts(69, 71, 90, 255)
const IDLE_BG = RGBA.fromInts(49, 50, 68, 255)
const BAR_FG_ACTIVE = RGBA.fromInts(17, 17, 27, 255)
const BAR_FG_IDLE = RGBA.fromInts(166, 173, 200, 255)
const CURSOR_ON = RGBA.fromInts(249, 226, 175, 255)
const CURSOR_IDLE = RGBA.fromInts(108, 112, 134, 255)

/** @deprecated the sidebar owns state glyphs now; see detect.ts STATE_GLYPH. */
export const STATUS_DOT = STATE_GLYPH

const TITLE_H = 1

interface Run {
  text: string
  x: number
  y: number
  fg: RGBA
  bg: RGBA
}

const color = (c: number | null, fallback: RGBA) =>
  c === null ? fallback : RGBA.fromInts((c >> 16) & 255, (c >> 8) & 255, c & 255, 255)

const OPENTUI_TO_GHOSTTY_BUTTON: Record<number, number> = {
  0: MouseButton.left,
  1: MouseButton.middle,
  2: MouseButton.right,
}

/**
 * A viewport onto an Agent.
 *
 * Owns nothing about the process — only the read side (a RenderState), a mouse
 * encoder, and a cached display list. Destroying a pane closes the view; the
 * agent keeps running.
 */
export class TerminalPane extends Renderable {
  readonly agent: Agent
  #state = new RenderState()
  #mouse = new MouseEncoder()

  /** Whether this pane is the workspace's active viewport. Named `active`, not
   *  `focused`: Renderable already exposes a read-only `focused` accessor for
   *  OpenTUI's own keyboard-focus tree, and overriding it would break that. */
  active = false
  hovered = false
  onFocusRequest?: (pane: TerminalPane) => void

  #runs: Run[] = []
  #cachedCursor: CursorInfo | null = null
  #cursorText = " "
  #haveCache = false
  #title = ""

  constructor(ctx: RenderContext, options: { id: string; agent: Agent } & Record<string, any>) {
    super(ctx, options)
    this.agent = options.agent
    this.agent.addViewer()
    this.agent.resize(Math.max(1, this.width), Math.max(1, this.height - TITLE_H))
  }

  /** Called by the workspace when the agent produces output. */
  invalidate() {
    this.#haveCache = false
    this.requestRender()
  }

  protected override onResize(width: number, height: number): void {
    this.agent.resize(Math.max(1, width), Math.max(1, height - TITLE_H))
    this.#haveCache = false
  }

  write(data: string) {
    this.agent.write(data)
    this.#haveCache = false
  }

  protected override onMouseEvent(event: MouseEvent): void {
    // opentui resolved the target from its native hit grid, so local
    // coordinates are just the offset — no rect math, no layout duplication.
    const x = event.x - this.x
    const y = event.y - this.y - TITLE_H

    switch (event.type) {
      case "over":
        this.hovered = true
        this.requestRender()
        return
      case "out":
        this.hovered = false
        this.requestRender()
        return
    }

    if (event.type === "down") this.onFocusRequest?.(this)
    if (y < 0) return // title bar: focus only, nothing forwarded to the agent

    const action =
      event.type === "down"
        ? MouseAction.press
        : event.type === "up"
          ? MouseAction.release
          : MouseAction.motion

    let button: number | null = null
    if (event.type === "scroll") {
      button = event.scroll?.direction === "up" ? MouseButton.wheelUp : MouseButton.wheelDown
    } else if (event.type === "down" || event.type === "up" || event.type === "drag") {
      button = OPENTUI_TO_GHOSTTY_BUTTON[event.button] ?? MouseButton.left
    }

    const seq = this.#mouse.encode(this.agent.term, x, y, action, button, event.modifiers)

    // Full-screen apps (vim, htop) want the wheel themselves. A plain shell
    // does not, and there the wheel should walk our scrollback instead.
    if (!seq && event.type === "scroll") {
      const rows = runtime.scrollRows
      this.agent.scrollBy(event.scroll?.direction === "up" ? -rows : rows)
      this.invalidate()
      event.stopPropagation()
      return
    }

    if (seq) {
      this.agent.write(seq)
      this.#haveCache = false
      event.stopPropagation()
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const ox = this.x
    const oy = this.y + TITLE_H
    buffer.fillRect(this.x, this.y, this.width, this.height, DEFAULT_BG)

    const barBg = this.active ? FOCUS_BG : this.hovered ? HOVER_BG : IDLE_BG
    const barFg = this.active || this.hovered ? BAR_FG_ACTIVE : BAR_FG_IDLE
    buffer.fillRect(this.x, this.y, this.width, TITLE_H, barBg)

    const state = this.agent.state
    const fgCmd = this.agent.foregroundCommand
    const suffix = state === "done" ? " (exited)" : fgCmd ? ` — ${fgCmd}` : ""
    // The title bar is repainted every frame anyway, so animate off the clock
    // rather than plumbing a tick down here.
    const glyph =
      state === "working"
        ? SPINNER_FRAMES[Math.floor(Date.now() / 100) % SPINNER_FRAMES.length]!
        : STATE_GLYPH[state]
    const label = `${glyph} ${this.#title || this.agent.name}${suffix}`
    buffer.drawText(label.slice(0, Math.max(0, this.width)), this.x, this.y, barFg, barBg)

    this.#state.update(this.agent.term)

    // Idle panes — most panes, most frames — replay the cached display list
    // instead of walking the grid over FFI again.
    if (!this.#haveCache || this.#state.dirty() !== Dirty.none) {
      this.#rebuild()
      this.#state.clearDirty()
      this.#haveCache = true
    }

    for (const r of this.#runs) buffer.drawText(r.text, ox + r.x, oy + r.y, r.fg, r.bg)

    const cur = this.#cachedCursor
    if (cur && cur.x < this.width && cur.y < this.height - TITLE_H) {
      this.#drawCursor(buffer, ox + cur.x, oy + cur.y, cur.style, this.#cursorText)
    }
  }

  /** Walk the grid once and batch contiguous same-style cells into runs.
   *  drawText is width-aware; setCell is single-column and drops wide glyphs. */
  #rebuild(): void {
    const runs: Run[] = []
    this.#title = this.agent.title
    const cur = this.#state.cursor()
    this.#cachedCursor = cur
    this.#cursorText = " "

    let text = ""
    let rx = 0
    let ry = 0
    let rFg: number | null = null
    let rBg: number | null = null
    let nextX = -1

    const flush = () => {
      if (!text) return
      runs.push({ text, x: rx, y: ry, fg: color(rFg, DEFAULT_FG), bg: color(rBg, DEFAULT_BG) })
      text = ""
    }

    const maxY = this.height - TITLE_H
    this.#state.forEachCell((x, y, t, fg, bg, width) => {
      if (y >= maxY || x >= this.width) return
      if (cur && x === cur.x && y === cur.y) this.#cursorText = t

      if (text && (y !== ry || x !== nextX || fg !== rFg || bg !== rBg)) flush()
      if (!text) {
        rx = x
        ry = y
        rFg = fg
        rBg = bg
      }
      text += t
      nextX = x + width
    })
    flush()
    this.#runs = runs
  }

  /** Focused panes get a solid cursor; unfocused ones a dim outline, so a
   *  glance tells you which pane keystrokes land in. */
  #drawCursor(buffer: OptimizedBuffer, x: number, y: number, style: number, text: string): void {
    if (!this.active) {
      buffer.setCell(x, y, text === " " ? "█" : text, CURSOR_IDLE, DEFAULT_BG)
      return
    }
    switch (style) {
      case CursorStyle.bar:
        buffer.setCell(x, y, "▏", CURSOR_ON, DEFAULT_BG)
        break
      case CursorStyle.underline:
        buffer.setCell(x, y, "▁", CURSOR_ON, DEFAULT_BG)
        break
      case CursorStyle.blockHollow:
        buffer.setCell(x, y, "░", CURSOR_ON, DEFAULT_BG)
        break
      default:
        buffer.setCell(x, y, text, DEFAULT_BG, CURSOR_ON)
    }
  }

  protected override destroySelf(): void {
    // Closes the view only; the agent keeps running.
    this.agent.removeViewer()
    this.#mouse.free()
    this.#state.free()
    super.destroySelf()
  }
}
