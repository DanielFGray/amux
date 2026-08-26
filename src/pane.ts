import {
  Renderable,
  RGBA,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core";
import {
  RenderState,
  MouseEncoder,
  MouseAction,
  MouseButton,
  CursorStyle,
  Dirty,
  type CursorInfo,
  type KittyPlacement,
} from "./ghostty.ts";
import { NativeImage } from "@opentui/core";
import { Effect, Exit, Scope } from "effect";
import type { SessionHandle } from "./session-handle.ts";
import { runtime } from "./options.ts";
import { STATE_GLYPH } from "./detect.ts";
import { captureRange } from "./shim.ts";
import { clearSelection, setSelection } from "./shim.ts";
import { cellWidth } from "./copy.ts";
import { encodeKey } from "./keys.ts";

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

const OPENTUI_TO_GHOSTTY_BUTTON = {
  0: MouseButton.left,
  1: MouseButton.middle,
  2: MouseButton.right,
} satisfies Record<number, number>;

function hasOwn<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.hasOwn(record, key);
}

/**
 * A viewport onto a session: one leaf of a window's split tree.
 *
 * A pane is a frame around content plus the identity the layout addresses it
 * by. What fills the frame is the session's substrate (Session.kind) and is the
 * subclass's business: a pty draws a terminal grid, a component draws a Solid
 * subtree. Everything a window does to a leaf — place it, size it, focus it,
 * draw its share of the split frame, close it — is the same either way, and
 * lives here.
 *
 * Owns nothing about the process. Destroying a pane closes the view; the
 * session keeps running.
 */
export abstract class Pane extends Renderable {
  /** The session this pane views, or null for a client-rendered plugin pane
   *  whose content declares no backend (see PaneContent in layout.ts). A pane
   *  with no session has nothing to resize, write to or count viewers on, so
   *  every use of the session is guarded rather than asserted. */
  readonly session: SessionHandle | null;

  hovered = false;
  onFocusRequest?: (pane: Pane) => void;
  onCopy?: (text: string) => boolean | void;
  onCopyError?: (error: Error) => void;

  #edges: Edges = { ...ALL_EDGES };
  #active = false;

  constructor(
    ctx: RenderContext,
    options: RenderableOptions & { id: string; session: SessionHandle | null },
  ) {
    super(ctx, options);
    this.session = options.session;
    if (this.session) {
      this.session.addViewer();
      // The session is sized here rather than through #applyEdges: a subclass's
      // own fields do not exist yet, so nothing may call back into it.
      const { width, height } = this.content;
      this.session.resize(width, height);
    }
  }

  /** Whether this pane is the workspace's active viewport. Named `active`, not
   *  `focused`: Renderable already exposes a read-only `focused` accessor for
   *  OpenTUI's own keyboard-focus tree, and overriding it would break that. */
  get active(): boolean {
    return this.#active;
  }

  set active(active: boolean) {
    if (this.#active === active) return;
    this.#active = active;
    this.onActiveChange(active);
    this.requestRender();
  }

  /** Hook for a subclass whose content cares who has the keyboard — a composer
   *  may only hold OpenTUI's focus while its own pane is the active one. */
  protected onActiveChange(_active: boolean): void {}

  /**
   * Take a keystroke the app's bindings did not claim.
   *
   * The substrate's own question, like drawing: a grid wants the key as the
   * bytes a child process reads, a Solid subtree wants it delivered to whatever
   * renderable holds focus inside it. True means the pane consumed it and the
   * app should stop the event; see the note on preventDefault in bindings.ts.
   */
  abstract handleKey(event: KeyEvent): boolean;

  get edges(): Edges {
    return this.#edges;
  }

  /** Set by the window after any structural change; the session is resized to
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
    this.#applyEdges();
    this.invalidate();
  }

  /** Columns/rows the border eats on each axis. */
  protected get padX(): number {
    return (this.#edges.left ? 1 : 0) + (this.#edges.right ? 1 : 0);
  }
  protected get padY(): number {
    return (this.#edges.top ? 1 : 0) + (this.#edges.bottom ? 1 : 0);
  }

  /** Where a pane's content starts and how big it is: its own rect less the
   *  sides it draws. The one statement of "the frame eats a cell". */
  protected get content() {
    return {
      x: this.x + (this.#edges.left ? 1 : 0),
      y: this.y + (this.#edges.top ? 1 : 0),
      width: Math.max(1, this.width - this.padX),
      height: Math.max(1, this.height - this.padY),
    };
  }

  /**
   * Told to the session, and told to whatever the subclass draws with.
   *
   * Deliberately NOT yoga padding on this node. A flex item's automatic minimum
   * is its min-content size, which includes padding, so a padded pane refuses
   * to shrink past its own border — the split then distributes differently from
   * geometry.ts's model and the two disagree about where the pane is. A pane is
   * a share of its parent and nothing else; the inset is the subclass's to
   * apply inside that share.
   */
  #applyEdges() {
    const { width, height } = this.content;
    this.session?.resize(width, height);
    this.onContentResize();
  }

  /** Hook for a subclass that lays renderables out rather than drawing cells:
   *  the content rect has moved or changed size. Never fires before the
   *  subclass is constructed, so an override may use its own fields. */
  protected onContentResize(): void {}

  /** Called by the workspace when the session produces output. */
  invalidate() {
    this.requestRender();
  }

  protected override onResize(width: number, height: number): void {
    // The arguments, not this.width: the node's own size is not published until
    // after the layout pass that raised this.
    this.session?.resize(Math.max(1, width - this.padX), Math.max(1, height - this.padY));
    this.onContentResize();
  }

  write(data: string | Uint8Array) {
    this.session?.write(data);
  }

  /**
   * Hover tracking and click-to-focus, which every pane wants whatever it
   * draws. True means the event was pane chrome and the subclass is done with
   * it.
   */
  protected trackPointer(event: MouseEvent): boolean {
    switch (event.type) {
      case "over":
        this.hovered = true;
        this.requestRender();
        return true;
      case "out":
        this.hovered = false;
        this.requestRender();
        return true;
    }
    if (event.type === "down") this.onFocusRequest?.(this);
    return false;
  }

  protected override onMouseEvent(event: MouseEvent): void {
    this.trackPointer(event);
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
    buffer.fillRect(this.x, this.y, this.width, this.height, DEFAULT_BG);
    this.drawBorder(buffer);
  }

  /**
   * Draw only the sides this pane owns.
   *
   * A corner glyph is used where two owned sides meet; where only one of the
   * pair is owned the line simply runs to the end of the pane and the Divider
   * next to it draws the tee. That is what keeps a split looking like one
   * continuous frame rather than two boxes pushed together.
   */
  protected drawBorder(buffer: OptimizedBuffer): void {
    const fg = this.active ? BORDER_FOCUS : this.hovered ? BORDER_HOVER : BORDER_IDLE;
    const { top, right, bottom, left } = this.#edges;
    const x0 = this.x;
    const y0 = this.y;
    const x1 = this.x + this.width - 1;
    const y1 = this.y + this.height - 1;

    if (top) {
      const title = this.session?.term.title ?? "";
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

  protected override destroySelf(): void {
    // Closes the view only; the session keeps running.
    this.session?.removeViewer();
    super.destroySelf();
  }
}

/**
 * A pane showing a pty: the terminal grid, its mouse encoding and its selection.
 *
 * Owns the read side of the emulator (a RenderState), a mouse encoder, and a
 * cached display list — nothing about the process itself.
 */
export class TerminalPane extends Pane {
  /** A pty pane always views a session — TerminalPane is only ever built for
   *  content that names one. Narrowing the base's nullable field keeps the
   *  emulator code free of null checks. */
  declare readonly session: SessionHandle;

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

  /** Fired when the mouse takes over the pane: a drag selection claims the
   *  terminal's selection slot, or a sequence routed to a mouse-reporting child
   *  hands the mouse to that program. Copy mode steps out on either. */
  onCopyModeInterrupt?: (() => void) | null;

  #runs: Run[] = [];
  #cachedCursor: CursorInfo | null = null;
  #cursorText = " ";
  #haveCache = false;
  #rebuildCount = 0;
  #selectionAnchor: CellPoint | null = null;
  #selecting = false;
  #kittyImages = new Map<
    number,
    { image: NativeImage; width: number; height: number; pixels: Uint8Array }
  >();

  /** Called by the workspace when the agent produces output. */
  override invalidate() {
    this.#haveCache = false;
    this.requestRender();
  }

  /** Number of display-list rebuilds, exposed for performance diagnostics. */
  get rebuildCount(): number {
    return this.#rebuildCount;
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.#haveCache = false;
  }

  override write(data: string | Uint8Array) {
    super.write(data);
    this.#haveCache = false;
  }

  /** A grid's answer: the bytes the child would have read from a real
   *  terminal. A key with no terminal encoding is not this pane's to take. */
  override handleKey(event: KeyEvent): boolean {
    const bytes = encodeKey(event);
    if (bytes === null) return false;
    this.write(bytes);
    return true;
  }

  protected override onMouseEvent(event: MouseEvent): void {
    // opentui resolved the target from its native hit grid, so local
    // coordinates are just the offset — no rect math, no layout duplication.
    const x = event.x - this.x - (this.edges.left ? 1 : 0);
    const y = event.y - this.y - (this.edges.top ? 1 : 0);

    if (this.trackPointer(event)) return;
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
      button = hasOwn(OPENTUI_TO_GHOSTTY_BUTTON, event.button)
        ? OPENTUI_TO_GHOSTTY_BUTTON[event.button]
        : MouseButton.left;
    }

    const seq = this.#mouse.encode(this.session.term, x, y, action, button, event.modifiers);

    const point = this.#point(x, y);
    if (event.type === "down" && (event.modifiers.shift || !seq)) {
      // A drag selection claims the terminal's selection slot; whatever modal
      // owns it now (keyboard copy mode) must step out first.
      this.onCopyModeInterrupt?.();
      this.#selecting = true;
      this.#selectionAnchor = point;
      setSelection(this.session.term.handle, point.x, point.y, point.x, point.y);
      (this._ctx as { setCapturedRenderable?: (r: Renderable) => void }).setCapturedRenderable?.(
        this,
      );
      this.invalidate();
      event.stopPropagation();
      return;
    }

    if (this.#selecting && (event.type === "drag" || event.type === "move")) {
      const anchor = this.#selectionAnchor!;
      setSelection(this.session.term.handle, anchor.x, anchor.y, point.x, point.y);
      this.invalidate();
      event.stopPropagation();
      return;
    }

    if (this.#selecting && (event.type === "drag-end" || event.type === "up")) {
      const anchor = this.#selectionAnchor!;
      setSelection(this.session.term.handle, anchor.x, anchor.y, point.x, point.y);
      if (anchor.x !== point.x || anchor.y !== point.y) this.#copySelection(anchor, point);
      else clearSelection(this.session.term.handle);
      this.#selecting = false;
      this.#selectionAnchor = null;
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

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const { x: ox, y: oy } = this.content;
    super.renderSelf(buffer);

    this.#state.update(this.session.term);

    // Idle panes — most panes, most frames — replay the cached display list
    // instead of walking the grid over FFI again.
    if (!this.#haveCache || this.#state.dirty() !== Dirty.none) {
      this.#rebuild();
      this.#state.clearDirty();
      this.#haveCache = true;
    }

    const placements = this.session.term.kittyGraphics();
    const layers = kittyPlacementLayers(placements);
    const visible = new Set<number>(placements.map((placement) => placement.imageId));
    const drawPlacement = (placement: (typeof placements)[number]) => {
      const rgba =
        placement.format === "rgba"
          ? placement.pixels
          : rgbToRgba(placement.pixels, placement.width, placement.height);
      const cached = this.#kittyImages.get(placement.imageId);
      const image =
        cached &&
        cached.width === placement.width &&
        cached.height === placement.height &&
        sameBytes(cached.pixels, rgba)
          ? cached.image
          : NativeImage.fromRgba(rgba, placement.width, placement.height);
      if (cached && image !== cached.image) cached.image.dispose();
      if (!cached || image !== cached.image) {
        this.#kittyImages.set(placement.imageId, {
          image,
          width: placement.width,
          height: placement.height,
          pixels: rgba,
        });
      }
      buffer.drawImage(
        image,
        ox + placement.column,
        oy + placement.row,
        placement.columns,
        placement.rows,
        placement.pixelWidth,
        placement.pixelHeight,
        placement.sourceX,
        placement.sourceY,
        placement.sourceWidth,
        placement.sourceHeight,
        "kitty",
      );
    };

    for (const index of layers.beforeText) drawPlacement(placements[index]!);
    for (const r of this.#runs) buffer.drawText(r.text, ox + r.x, oy + r.y, r.fg, r.bg);
    for (const index of layers.afterText) drawPlacement(placements[index]!);

    for (const [imageId, cached] of this.#kittyImages) {
      if (!visible.has(imageId)) {
        cached.image.dispose();
        this.#kittyImages.delete(imageId);
      }
    }

    const cur = this.#cachedCursor;
    if (cur && cur.x < this.width - this.padX && cur.y < this.height - this.padY) {
      this.#drawCursor(buffer, ox + cur.x, oy + cur.y, cur.style, this.#cursorText);
    }
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

    const maxY = this.height - this.padY;
    const maxX = this.width - this.padX;
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
    for (const { image } of this.#kittyImages.values()) image.dispose();
    this.#kittyImages.clear();
    Effect.runFork(Scope.close(this.#scope, Exit.void));
    super.destroySelf();
  }
}

export function kittyPlacementLayers(placements: readonly Pick<KittyPlacement, "zIndex">[]) {
  const order = placements.map((placement, index) => ({ index, zIndex: placement.zIndex }));
  order.sort((left, right) => left.zIndex - right.zIndex);
  const split = order.findIndex(({ zIndex }) => zIndex >= 0);
  const beforeText = (split < 0 ? order : order.slice(0, split)).map(({ index }) => index);
  const afterText = (split < 0 ? [] : order.slice(split)).map(({ index }) => index);
  return { beforeText, afterText };
}

function rgbToRgba(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    rgba[target] = rgb[source]!;
    rgba[target + 1] = rgb[source + 1]!;
    rgba[target + 2] = rgb[source + 2]!;
    rgba[target + 3] = 255;
  }
  return rgba;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}
