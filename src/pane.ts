import {
  Renderable,
  RGBA,
  type MouseEvent,
  type OptimizedBuffer,
  type RenderContext,
} from "@opentui/core";
import {
  RenderState,
  MouseEncoder,
  MouseAction,
  MouseButton,
  CursorStyle,
  Dirty,
  type CursorInfo,
} from "./ghostty.ts";
import { Effect, Exit, Scope } from "effect";
import type { Session } from "./agent.ts";
import { runtime } from "./options.ts";
import { STATE_GLYPH } from "./detect.ts";
import { captureRange } from "./shim.ts";
import { clearSelection, setSelection } from "./shim.ts";
import { cellWidth } from "./copy.ts";

const DEFAULT_FG = RGBA.fromInts(205, 214, 244, 255);
const DEFAULT_BG = RGBA.fromInts(30, 30, 46, 255);
const BORDER_FOCUS = RGBA.fromInts(137, 180, 250, 255); // blue
const BORDER_HOVER = RGBA.fromInts(203, 166, 247, 255); // mauve
const BORDER_IDLE = RGBA.fromInts(69, 71, 90, 255); // surface1
const CURSOR_ON = RGBA.fromInts(249, 226, 175, 255);
const CURSOR_IDLE = RGBA.fromInts(108, 112, 134, 255);
const SELECTION_FG = 0x1e1e2e;
const SELECTION_BG = 0x89b4fa;

/** @deprecated the sidebar owns state glyphs now; see detect.ts STATE_GLYPH. */
export const STATUS_DOT = STATE_GLYPH;

/**
 * Which of a pane's four sides it draws itself.
 *
 * A pane only draws the sides that face the window's outer edge. Sides that
 * face another pane are drawn by the Divider sitting between them, which is a
 * single shared cell — so borders stay one column/row wide everywhere instead of
 * doubling up at every split.
 */
export interface Edges {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

const ALL_EDGES: Edges = { top: true, right: true, bottom: true, left: true };

interface Run {
  text: string;
  x: number;
  y: number;
  fg: RGBA;
  bg: RGBA;
}

interface CellPoint {
  x: number;
  y: number;
}

const color = (c: number | null, fallback: RGBA) =>
  c === null ? fallback : RGBA.fromInts((c >> 16) & 255, (c >> 8) & 255, c & 255, 255);

const OPENTUI_TO_GHOSTTY_BUTTON: Record<number, number> = {
  0: MouseButton.left,
  1: MouseButton.middle,
  2: MouseButton.right,
};

/**
 * A viewport onto an Agent.
 *
 * Owns nothing about the process — only the read side (a RenderState), a mouse
 * encoder, and a cached display list. Destroying a pane closes the view; the
 * agent keeps running.
 */
export class TerminalPane extends Renderable {
  readonly session: Session;
  /** Owns this pane's FFI handles, so closing it frees them all — see the note
   *  on Agent's scope. A pane is destroyed from OpenTUI's tree rather than from
   *  an Effect, so the scope is closed by destroySelf rather than by a parent. */
  #scope = Effect.runSync(Scope.make());
  #state = this.#own(
    () => new RenderState(),
    (state) => state.free(),
  );
  #mouse = this.#own(
    () => new MouseEncoder(),
    (mouse) => mouse.free(),
  );

  /** Whether this pane is the workspace's active viewport. Named `active`, not
   *  `focused`: Renderable already exposes a read-only `focused` accessor for
   *  OpenTUI's own keyboard-focus tree, and overriding it would break that. */
  active = false;
  hovered = false;
  onFocusRequest?: (pane: TerminalPane) => void;
  onCopy?: (text: string) => boolean | void;
  onCopyError?: (error: Error) => void;
  /** Fired when the mouse takes over the pane: a drag selection claims the
   *  terminal's selection slot, or a sequence routed to a mouse-reporting child
   *  hands the mouse to that program. Copy mode steps out on either. */
  onCopyModeInterrupt?: (() => void) | null;

  #runs: Run[] = [];
  #cachedCursor: CursorInfo | null = null;
  #cursorText = " ";
  #haveCache = false;
  #rebuildCount = 0;
  #edges: Edges = { ...ALL_EDGES };
  #selectionAnchor: CellPoint | null = null;
  #selectionEnd: CellPoint | null = null;
  #selecting = false;

  constructor(ctx: RenderContext, options: { id: string; session: Session } & Record<string, any>) {
    super(ctx, options);
    this.session = options.session;
    this.session.addViewer();
    this.#sync();
  }

  get edges(): Edges {
    return this.#edges;
  }

  /** Set by the window after any structural change; the agent is resized to
   *  whatever the border leaves over. */
  set edges(edges: Edges) {
    const e = this.#edges;
    if (
      e.top === edges.top &&
      e.right === edges.right &&
      e.bottom === edges.bottom &&
      e.left === edges.left
    ) {
      return;
    }
    this.#edges = { ...edges };
    this.#sync();
    this.#haveCache = false;
    this.requestRender();
  }

  /** Columns/rows the border eats on each axis. */
  get #padX(): number {
    return (this.#edges.left ? 1 : 0) + (this.#edges.right ? 1 : 0);
  }
  get #padY(): number {
    return (this.#edges.top ? 1 : 0) + (this.#edges.bottom ? 1 : 0);
  }

  #sync() {
    this.session.resize(
      Math.max(1, this.width - this.#padX),
      Math.max(1, this.height - this.#padY),
    );
  }

  /** Called by the workspace when the agent produces output. */
  invalidate() {
    this.#haveCache = false;
    this.requestRender();
  }

  /** Number of display-list rebuilds, exposed for performance diagnostics. */
  get rebuildCount(): number {
    return this.#rebuildCount;
  }

  protected override onResize(width: number, height: number): void {
    this.session.resize(Math.max(1, width - this.#padX), Math.max(1, height - this.#padY));
    this.#haveCache = false;
  }

  write(data: string | Uint8Array) {
    this.session.write(data);
    this.#haveCache = false;
  }

  protected override onMouseEvent(event: MouseEvent): void {
    // opentui resolved the target from its native hit grid, so local
    // coordinates are just the offset — no rect math, no layout duplication.
    const x = event.x - this.x - (this.#edges.left ? 1 : 0);
    const y = event.y - this.y - (this.#edges.top ? 1 : 0);

    switch (event.type) {
      case "over":
        this.hovered = true;
        this.requestRender();
        return;
      case "out":
        this.hovered = false;
        this.requestRender();
        return;
    }

    if (event.type === "down") this.onFocusRequest?.(this);
    // On the border: focus only. Forwarding it would hand the child a click at
    // coordinates that are off its grid.
    if (x < 0 || y < 0 || x >= this.session.term.cols || y >= this.session.term.rows) return;

    const action =
      event.type === "down" || event.type === "scroll"
        ? MouseAction.press
        : event.type === "up"
          ? MouseAction.release
          : MouseAction.motion;

    let button: number | null = null;
    if (event.type === "scroll") {
      button = event.scroll?.direction === "up" ? MouseButton.wheelUp : MouseButton.wheelDown;
    } else if (event.type === "down" || event.type === "up" || event.type === "drag") {
      button = OPENTUI_TO_GHOSTTY_BUTTON[event.button] ?? MouseButton.left;
    }

    const seq = this.#mouse.encode(this.session.term, x, y, action, button, event.modifiers);

    const point = this.#point(x, y);
    if (event.type === "down" && (event.modifiers.shift || !seq)) {
      // A drag selection claims the terminal's selection slot; whatever modal
      // owns it now (keyboard copy mode) must step out first.
      this.onCopyModeInterrupt?.();
      this.#selecting = true;
      this.#selectionAnchor = point;
      this.#selectionEnd = point;
      setSelection(this.session.term.handle, point.x, point.y, point.x, point.y);
      (
        this._ctx as unknown as { setCapturedRenderable?: (r: unknown) => void }
      ).setCapturedRenderable?.(this);
      this.invalidate();
      event.stopPropagation();
      return;
    }

    if (this.#selecting && (event.type === "drag" || event.type === "move")) {
      this.#selectionEnd = point;
      const anchor = this.#selectionAnchor!;
      setSelection(this.session.term.handle, anchor.x, anchor.y, point.x, point.y);
      this.invalidate();
      event.stopPropagation();
      return;
    }

    if (this.#selecting && (event.type === "drag-end" || event.type === "up")) {
      this.#selectionEnd = point;
      const anchor = this.#selectionAnchor!;
      setSelection(this.session.term.handle, anchor.x, anchor.y, point.x, point.y);
      if (anchor.x !== point.x || anchor.y !== point.y) this.#copySelection(anchor, point);
      else clearSelection(this.session.term.handle);
      this.#selecting = false;
      this.#selectionAnchor = null;
      this.#selectionEnd = null;
      this.invalidate();
      event.stopPropagation();
      return;
    }

    // Full-screen apps (vim, htop) want the wheel themselves. A plain shell
    // does not, and there the wheel should walk our scrollback instead.
    if (!seq && event.type === "scroll") {
      const rows = runtime["behaviour.scrollRows"];
      this.session.scrollBy(event.scroll?.direction === "up" ? -rows : rows);
      this.invalidate();
      event.stopPropagation();
      return;
    }

    if (seq) {
      // The child negotiated mouse reporting, so this event is routed to it
      // rather than to a local selection. Whatever modal owns the pane now
      // (keyboard copy mode) must step out before the child gets the mouse.
      this.onCopyModeInterrupt?.();
      this.session.write(seq);
      this.#haveCache = false;
      event.stopPropagation();
    }
  }

  #point(x: number, y: number): CellPoint {
    const rows = this.session.term.scrollbar;
    return {
      x: Math.max(0, Math.min(this.session.term.cols - 1, x)),
      y: Math.max(0, Math.min(this.session.term.rows - 1, y)) + rows.offset,
    };
  }

  #copySelection(a: CellPoint, b: CellPoint) {
    const start = a.y < b.y || (a.y === b.y && a.x <= b.x) ? a : b;
    const end = start === a ? b : a;
    const bytes = captureRange(this.session.term.handle, {
      startTag: 2,
      startX: start.x,
      startY: start.y,
      endTag: 2,
      endX: end.x,
      endY: end.y,
    });
    this.copyText(new TextDecoder().decode(bytes));
  }

  /** Hand a string to the copy chain (OSC 52 to the host terminal). The one
   *  path both mouse-drag selection and keyboard copy mode use, so a rejected
   *  write reports the same way from either. */
  copyText(text: string) {
    if (!text || !this.onCopy) return;
    try {
      if (this.onCopy(text) === false) this.onCopyError?.(new Error("clipboard rejected OSC 52"));
    } catch (error) {
      this.onCopyError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const ox = this.x + (this.#edges.left ? 1 : 0);
    const oy = this.y + (this.#edges.top ? 1 : 0);
    buffer.fillRect(this.x, this.y, this.width, this.height, DEFAULT_BG);
    this.#drawBorder(buffer);

    this.#state.update(this.session.term);

    // Idle panes — most panes, most frames — replay the cached display list
    // instead of walking the grid over FFI again.
    if (!this.#haveCache || this.#state.dirty() !== Dirty.none) {
      this.#rebuild();
      this.#state.clearDirty();
      this.#haveCache = true;
    }

    for (const r of this.#runs) buffer.drawText(r.text, ox + r.x, oy + r.y, r.fg, r.bg);

    const cur = this.#cachedCursor;
    if (cur && cur.x < this.width - this.#padX && cur.y < this.height - this.#padY) {
      this.#drawCursor(buffer, ox + cur.x, oy + cur.y, cur.style, this.#cursorText);
    }
  }

  /**
   * Draw only the sides this pane owns.
   *
   * A corner glyph is used where two owned sides meet; where only one of the
   * pair is owned the line simply runs to the end of the pane and the Divider
   * next to it draws the tee. That is what keeps a split looking like one
   * continuous frame rather than two boxes pushed together.
   */
  #drawBorder(buffer: OptimizedBuffer): void {
    const fg = this.active ? BORDER_FOCUS : this.hovered ? BORDER_HOVER : BORDER_IDLE;
    const { top, right, bottom, left } = this.#edges;
    const x0 = this.x;
    const y0 = this.y;
    const x1 = this.x + this.width - 1;
    const y1 = this.y + this.height - 1;

    if (top) {
      const title = this.session.term.title;
      const titleWidth = cellWidth(title);
      if (title && runtime["appearance.gap"] && this.width >= titleWidth + 4) {
        if (left) buffer.setCell(x0, y0, "┌", fg, DEFAULT_BG);
        else buffer.setCell(x0, y0, "─", fg, DEFAULT_BG);
        buffer.drawText(` ${title} `, x0 + 1, y0, fg, DEFAULT_BG);
        const dashStart = x0 + 3 + titleWidth;
        const dashEnd = right ? x1 - 1 : x1;
        for (let x = dashStart; x <= dashEnd; x++) buffer.setCell(x, y0, "─", fg, DEFAULT_BG);
      } else {
        for (let x = x0; x <= x1; x++) buffer.setCell(x, y0, "─", fg, DEFAULT_BG);
      }
    }
    if (bottom) for (let x = x0; x <= x1; x++) buffer.setCell(x, y1, "─", fg, DEFAULT_BG);
    if (left) for (let y = y0; y <= y1; y++) buffer.setCell(x0, y, "│", fg, DEFAULT_BG);
    if (right) for (let y = y0; y <= y1; y++) buffer.setCell(x1, y, "│", fg, DEFAULT_BG);

    if (top && right) buffer.setCell(x1, y0, "┐", fg, DEFAULT_BG);
    if (bottom && left) buffer.setCell(x0, y1, "└", fg, DEFAULT_BG);
    if (bottom && right) buffer.setCell(x1, y1, "┘", fg, DEFAULT_BG);
    if (top && left) buffer.setCell(x0, y0, "┌", fg, DEFAULT_BG);
  }

  /** Walk the grid once and batch contiguous same-style cells into runs.
   *  drawText is width-aware; setCell is single-column and drops wide glyphs. */
  #rebuild(): void {
    this.#rebuildCount++;
    const runs: Run[] = [];
    const cur = this.#state.cursor();
    this.#cachedCursor = cur;
    this.#cursorText = " ";

    let text = "";
    let rx = 0;
    let ry = 0;
    let rFg: number | null = null;
    let rBg: number | null = null;
    let nextX = -1;

    const flush = () => {
      if (!text) return;
      runs.push({ text, x: rx, y: ry, fg: color(rFg, DEFAULT_FG), bg: color(rBg, DEFAULT_BG) });
      text = "";
    };

    const maxY = this.height - this.#padY;
    const maxX = this.width - this.#padX;
    this.#state.forEachCell((x, y, t, fg, bg, width, selected) => {
      if (y >= maxY || x >= maxX) return;
      if (cur && x === cur.x && y === cur.y) this.#cursorText = t;

      const runFg = selected ? SELECTION_FG : fg;
      const runBg = selected ? SELECTION_BG : bg;
      if (text && (y !== ry || x !== nextX || runFg !== rFg || runBg !== rBg)) flush();
      if (!text) {
        rx = x;
        ry = y;
        rFg = runFg;
        rBg = runBg;
      }
      text += t;
      nextX = x + width;
    });
    flush();
    this.#runs = runs;
  }

  /** Focused panes get a solid cursor; unfocused ones a dim outline, so a
   *  glance tells you which pane keystrokes land in. */
  #drawCursor(buffer: OptimizedBuffer, x: number, y: number, style: number, text: string): void {
    if (!this.active) {
      buffer.setCell(x, y, text === " " ? "█" : text, CURSOR_IDLE, DEFAULT_BG);
      return;
    }
    switch (style) {
      case CursorStyle.bar:
        buffer.setCell(x, y, "▏", CURSOR_ON, DEFAULT_BG);
        break;
      case CursorStyle.underline:
        buffer.setCell(x, y, "▁", CURSOR_ON, DEFAULT_BG);
        break;
      case CursorStyle.blockHollow:
        buffer.setCell(x, y, "░", CURSOR_ON, DEFAULT_BG);
        break;
      default:
        buffer.setCell(x, y, text, DEFAULT_BG, CURSOR_ON);
    }
  }

  /** Allocate an FFI handle into this pane's scope. See Agent's #own. */
  #own<A>(acquire: () => A, free: (handle: A) => void): A {
    return Effect.runSync(
      Scope.extend(
        Effect.acquireRelease(Effect.sync(acquire), (handle) => Effect.sync(() => free(handle))),
        this.#scope,
      ),
    );
  }

  protected override destroySelf(): void {
    // Closes the view only; the agent keeps running.
    this.session.removeViewer();
    Effect.runFork(Scope.close(this.#scope, Exit.void));
    super.destroySelf();
  }
}
