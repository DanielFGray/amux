import { dlopen, FFIType as T, ptr, toArrayBuffer, type Pointer } from "bun:ffi"

export const LIB_DIR =
  process.env.GHOSTTY_VT_LIB_DIR ?? "/home/dan/build/herdr/vendor/libghostty-vt/zig-out/lib"

const LIB = process.env.GHOSTTY_VT_LIB ?? `${LIB_DIR}/libghostty-vt.so.0.1.0`

const P = T.ptr, I = T.i32, U16 = T.u16, U32 = T.u32, U64 = T.u64, B = T.bool, V = T.void

const { symbols: g } = dlopen(LIB, {
  ghostty_terminal_new: { args: [P, P, U64, U64], returns: I },
  ghostty_terminal_free: { args: [P], returns: V },
  ghostty_terminal_vt_write: { args: [P, P, U64], returns: V },
  ghostty_terminal_resize: { args: [P, U16, U16, U32, U32], returns: I },
  ghostty_terminal_get: { args: [P, I, P], returns: I },

  ghostty_render_state_new: { args: [P, P], returns: I },
  ghostty_render_state_free: { args: [P], returns: V },
  ghostty_render_state_update: { args: [P, P], returns: I },
  ghostty_render_state_get: { args: [P, I, P], returns: I },
  ghostty_render_state_set: { args: [P, I, P], returns: I },

  ghostty_render_state_row_iterator_new: { args: [P, P], returns: I },
  ghostty_render_state_row_iterator_free: { args: [P], returns: V },
  ghostty_render_state_row_iterator_next: { args: [P], returns: B },
  ghostty_render_state_row_get: { args: [P, I, P], returns: I },

  ghostty_render_state_row_cells_new: { args: [P, P], returns: I },
  ghostty_render_state_row_cells_free: { args: [P], returns: V },
  ghostty_render_state_row_cells_next: { args: [P], returns: B },
  ghostty_render_state_row_cells_get: { args: [P, I, P], returns: I },
  ghostty_cell_get: { args: [U64, I, P], returns: I },
  ghostty_render_state_row_cells_get_multi: { args: [P, U64, P, P, P], returns: I },

  ghostty_mouse_encoder_new: { args: [P, P], returns: I },
  ghostty_mouse_encoder_free: { args: [P], returns: V },
  ghostty_mouse_encoder_setopt: { args: [P, I, P], returns: V },
  ghostty_mouse_encoder_setopt_from_terminal: { args: [P, P], returns: V },
  ghostty_mouse_encoder_encode: { args: [P, P, P, U64, P], returns: I },
  ghostty_mouse_event_new: { args: [P, P], returns: I },
  ghostty_mouse_event_free: { args: [P], returns: V },
  ghostty_mouse_event_set_action: { args: [P, I], returns: V },
  ghostty_mouse_event_set_button: { args: [P, I], returns: V },
  ghostty_mouse_event_clear_button: { args: [P], returns: V },
  ghostty_mouse_event_set_mods: { args: [P, I], returns: V },
  /** GhosttyMousePosition is {f32,f32} = SSE class under SysV, so it travels
   *  in an XMM register. Declaring it u64 would use the integer register file
   *  and silently corrupt coordinates; f64 with the same bit pattern is right. */
  ghostty_mouse_event_set_position: { args: [P, T.f64], returns: V },
})

const OK = 0
/** GhosttyTerminalOptions is 16B / all-INTEGER, so SysV + AAPCS64 pass it in
 *  two registers. Bun FFI has no struct-by-value, so we declare two u64s.
 *  NOTE: Windows x64 passes 16B structs by reference — needs a shim there. */
const packOptions = (cols: number, rows: number, scrollback: number) =>
  [BigInt(cols) | (BigInt(rows) << 16n), BigInt(scrollback)] as const

const STATE_ROW_ITERATOR = 4
const ROW_DATA_CELLS = 3
const CELL_GRAPHEMES_LEN = 3
const CELL_GRAPHEMES_BUF = 4
const CELL_BG_COLOR = 5
const CELL_FG_COLOR = 6
const CELL_HAS_STYLING = 8
const CELL_RAW = 1
const CELL_DATA_WIDE = 3
const WIDE_WIDE = 1

const TERMINAL_DATA_TITLE = 12
const TERMINAL_DATA_PWD = 13

const STATE_DIRTY = 3
const STATE_OPTION_DIRTY = 0
const STATE_CURSOR_VISUAL_STYLE = 10
const STATE_CURSOR_VISIBLE = 11
const STATE_CURSOR_BLINKING = 12
const STATE_CURSOR_VIEWPORT_HAS_VALUE = 14
const STATE_CURSOR_VIEWPORT_X = 15
const STATE_CURSOR_VIEWPORT_Y = 16
const STATE_CURSOR_VIEWPORT_WIDE_TAIL = 17

const handle = () => new BigUint64Array(1)
/** Opaque Ghostty handles are plain numbers here; cast to bun:ffi's branded
 *  Pointer when passing them to pointer-typed FFI arguments. */
const asPtr = (n: number): Pointer => n as unknown as Pointer
function check(what: string, r: number) {
  if (r !== OK) throw new Error(`libghostty-vt: ${what} failed (${r})`)
}

export class Terminal {
  #h: number
  #freed = false
  #cols: number
  #rows: number
  #str = new BigUint64Array(2)

  constructor(cols: number, rows: number, scrollback = 10_000) {
    const out = handle()
    const [a, b] = packOptions(cols, rows, scrollback)
    check("terminal_new", g.ghostty_terminal_new(null, ptr(out), a, b))
    this.#h = Number(out[0])
    this.#cols = cols
    this.#rows = rows
  }

  get handle() {
    return this.#h
  }

  get cols() {
    return this.#cols
  }

  get rows() {
    return this.#rows
  }

  write(bytes: Uint8Array) {
    g.ghostty_terminal_vt_write(asPtr(this.#h), ptr(bytes), BigInt(bytes.length))
  }

  resize(cols: number, rows: number) {
    check("terminal_resize", g.ghostty_terminal_resize(asPtr(this.#h), cols, rows, 0, 0))
    this.#cols = cols
    this.#rows = rows
  }

  /** GhosttyString is {ptr, len}; the bytes are borrowed and only valid until
   *  the next vt_write, so decode immediately rather than holding the pointer. */
  #string(kind: number): string {
    if (g.ghostty_terminal_get(asPtr(this.#h), kind, ptr(this.#str)) !== OK) return ""
    const p = this.#str[0]
    const len = Number(this.#str[1])
    if (!p || len === 0) return ""
    return new TextDecoder().decode(new Uint8Array(toArrayBuffer(asPtr(Number(p)), 0, len)))
  }

  /** Title set by the child via OSC 0 / OSC 2, or "" if never set. */
  get title(): string {
    return this.#string(TERMINAL_DATA_TITLE)
  }

  /** Working directory reported via OSC 7, or "" if never set. */
  get pwd(): string {
    return this.#string(TERMINAL_DATA_PWD)
  }

  free() {
    if (this.#freed) return
    this.#freed = true
    g.ghostty_terminal_free(asPtr(this.#h))
  }
}

export const MouseAction = { press: 0, release: 1, motion: 2 } as const
export const MouseButton = { left: 1, right: 2, middle: 3, wheelUp: 4, wheelDown: 5 } as const

export interface MouseMods {
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
}
// Matches Ghostty's GhosttyMods bitfield ordering.
const MOD_SHIFT = 1, MOD_CTRL = 2, MOD_ALT = 4

const ENCODER_OPT_SIZE = 2
/** GhosttyMouseEncoderSize: size@0, screen_w@8, screen_h@12, cell_w@16, cell_h@20,
 *  then four u32 paddings. Positions are in pixels, so we declare 1px cells and
 *  feed cell coordinates directly. */
function encoderSize(cols: number, rows: number): Uint8Array {
  const buf = new ArrayBuffer(40)
  const v = new DataView(buf)
  v.setBigUint64(0, 40n, true)
  v.setUint32(8, cols, true)
  v.setUint32(12, rows, true)
  v.setUint32(16, 1, true)
  v.setUint32(20, 1, true)
  return new Uint8Array(buf)
}

/** Encodes mouse events into whatever protocol the child program negotiated
 *  (X10 / SGR / urxvt / pixels). Returns null when the child has not enabled
 *  mouse reporting, in which case the host should handle the event itself. */
export class MouseEncoder {
  #enc: number
  #ev: number
  #buf = new Uint8Array(64)
  #len = new BigUint64Array(1)
  #pos = new Float32Array(2)
  #size = encoderSize(80, 24)
  #sizeCols = 80
  #sizeRows = 24

  constructor() {
    const e = handle()
    check("mouse_encoder_new", g.ghostty_mouse_encoder_new(null, ptr(e)))
    this.#enc = Number(e[0])
    const v = handle()
    check("mouse_event_new", g.ghostty_mouse_event_new(null, ptr(v)))
    this.#ev = Number(v[0])
  }

  encode(
    term: Terminal,
    x: number,
    y: number,
    action: number,
    button: number | null,
    mods: MouseMods = {},
  ): Uint8Array | null {
    // Pull the child's current mouse mode straight from the terminal state,
    // then restate the grid size (from_terminal does not set it).
    g.ghostty_mouse_encoder_setopt_from_terminal(asPtr(this.#enc), asPtr(term.handle))
    if (this.#sizeCols !== term.cols || this.#sizeRows !== term.rows) {
      this.#sizeCols = term.cols
      this.#sizeRows = term.rows
      this.#size = encoderSize(term.cols, term.rows)
    }
    g.ghostty_mouse_encoder_setopt(asPtr(this.#enc), ENCODER_OPT_SIZE, ptr(this.#size))

    g.ghostty_mouse_event_set_action(asPtr(this.#ev), action)
    if (button === null) g.ghostty_mouse_event_clear_button(asPtr(this.#ev))
    else g.ghostty_mouse_event_set_button(asPtr(this.#ev), button)
    g.ghostty_mouse_event_set_mods(
      asPtr(this.#ev),
      (mods.shift ? MOD_SHIFT : 0) | (mods.ctrl ? MOD_CTRL : 0) | (mods.alt ? MOD_ALT : 0),
    )
    this.#pos[0] = x
    this.#pos[1] = y
    g.ghostty_mouse_event_set_position(asPtr(this.#ev), new Float64Array(this.#pos.buffer)[0]!)

    const r = g.ghostty_mouse_encoder_encode(
      asPtr(this.#enc),
      asPtr(this.#ev),
      ptr(this.#buf),
      BigInt(this.#buf.length),
      ptr(this.#len),
    )
    if (r !== OK) return null
    const n = Number(this.#len[0])
    return n > 0 ? this.#buf.subarray(0, n) : null
  }

  free() {
    g.ghostty_mouse_event_free(asPtr(this.#ev))
    g.ghostty_mouse_encoder_free(asPtr(this.#enc))
  }
}

export interface CellVisitor {
  (x: number, y: number, text: string, fg: number | null, bg: number | null, width: number): void
}

export const Dirty = { none: 0, partial: 1, full: 2 } as const

export const CursorStyle = { bar: 0, block: 1, underline: 2, blockHollow: 3 } as const

export interface CursorInfo {
  x: number
  y: number
  style: number
  blinking: boolean
  wideTail: boolean
}

/** Reusable read-side view over a Terminal's screen. */
export class RenderState {
  #s: number
  #iter: number
  #cells = handle()
  #cellsCur = 0
  #iterBox = handle()

  // scratch buffers reused every frame — no per-cell allocation
  #len = new Uint32Array(1)
  #cps = new Uint32Array(16)
  #rgb = new Uint8Array(4)
  #styled = new Uint8Array(1)
  #u16 = new Uint16Array(1)
  #bool = new Uint8Array(1)
  #i32 = new Int32Array(1)
  #raw = new BigUint64Array(1)
  #wide = new Int32Array(1)
  // Measured: ghostty_render_state_row_cells_get_multi is SLOWER here than
  // separate get() calls (5.09ms vs 3.02ms per 200x50 walk) — Bun's marshalling
  // of the pointer array costs more than the calls it saves. Left unused.

  constructor() {
    const s = handle()
    check("render_state_new", g.ghostty_render_state_new(null, ptr(s)))
    this.#s = Number(s[0])
    const it = handle()
    check("row_iterator_new", g.ghostty_render_state_row_iterator_new(null, ptr(it)))
    this.#iter = Number(it[0])
    check("row_cells_new", g.ghostty_render_state_row_cells_new(null, ptr(this.#cells)))
    this.#cellsCur = Number(this.#cells[0])
  }

  /** Pull the latest screen contents from a terminal. */
  update(term: Terminal) {
    check("render_state_update", g.ghostty_render_state_update(asPtr(this.#s), asPtr(term.handle)))
  }

  #getBool(kind: number): boolean {
    return (
      g.ghostty_render_state_get(asPtr(this.#s), kind, ptr(this.#bool)) === OK && this.#bool[0] !== 0
    )
  }

  #getU16(kind: number): number {
    return g.ghostty_render_state_get(asPtr(this.#s), kind, ptr(this.#u16)) === OK
      ? this.#u16[0]!
      : 0
  }

  /** How much changed since the last clearDirty(). `none` means the previous
   *  frame's output is still valid and all cell reads can be skipped. */
  dirty(): number {
    return g.ghostty_render_state_get(asPtr(this.#s), STATE_DIRTY, ptr(this.#i32)) === OK
      ? this.#i32[0]!
      : Dirty.full
  }

  /** Mark the state clean after a successful render. */
  clearDirty() {
    this.#i32[0] = Dirty.none
    g.ghostty_render_state_set(asPtr(this.#s), STATE_OPTION_DIRTY, ptr(this.#i32))
  }

  /** Cursor position/style for the current viewport, or null when the cursor
   *  is hidden or scrolled out of view. */
  cursor(): CursorInfo | null {
    if (!this.#getBool(STATE_CURSOR_VISIBLE)) return null
    if (!this.#getBool(STATE_CURSOR_VIEWPORT_HAS_VALUE)) return null
    const style =
      g.ghostty_render_state_get(asPtr(this.#s), STATE_CURSOR_VISUAL_STYLE, ptr(this.#i32)) === OK
        ? this.#i32[0]!
        : CursorStyle.block
    return {
      x: this.#getU16(STATE_CURSOR_VIEWPORT_X),
      y: this.#getU16(STATE_CURSOR_VIEWPORT_Y),
      style,
      blinking: this.#getBool(STATE_CURSOR_BLINKING),
      wideTail: this.#getBool(STATE_CURSOR_VIEWPORT_WIDE_TAIL),
    }
  }

  #color(kind: number): number | null {
    if (g.ghostty_render_state_row_cells_get(asPtr(this.#cellsCur), kind, ptr(this.#rgb)) !== OK)
      return null
    return (this.#rgb[0]! << 16) | (this.#rgb[1]! << 8) | this.#rgb[2]!
  }

  /** Walk every cell of the current viewport. Colors are null when the cell
   *  uses the terminal default, which the caller resolves to its own theme. */
  forEachCell(visit: CellVisitor) {
    this.#iterBox[0] = BigInt(this.#iter)
    if (g.ghostty_render_state_get(asPtr(this.#s), STATE_ROW_ITERATOR, ptr(this.#iterBox)) !== OK)
      return
    const iter = Number(this.#iterBox[0])

    let y = 0
    while (g.ghostty_render_state_row_iterator_next(asPtr(iter))) {
      if (g.ghostty_render_state_row_get(asPtr(iter), ROW_DATA_CELLS, ptr(this.#cells)) === OK) {
        const cells = Number(this.#cells[0])
        this.#cellsCur = cells
        let x = 0
        while (g.ghostty_render_state_row_cells_next(asPtr(cells))) {
          if (
            g.ghostty_render_state_row_cells_get(asPtr(cells), CELL_GRAPHEMES_LEN, ptr(this.#len)) ===
              OK &&
            this.#len[0]! > 0
          ) {
            const n = Math.min(this.#len[0]!, this.#cps.length)
            if (
              g.ghostty_render_state_row_cells_get(asPtr(cells), CELL_GRAPHEMES_BUF, ptr(this.#cps)) ===
              OK
            ) {
              let text = ""
              for (let i = 0; i < n; i++)
                if (this.#cps[i]! > 0) text += String.fromCodePoint(this.#cps[i]!)
              // HAS_STYLING lets us skip two FFI calls for the common plain cell
              let fg: number | null = null
              let bg: number | null = null
              if (
                g.ghostty_render_state_row_cells_get(
                  asPtr(cells),
                  CELL_HAS_STYLING,
                  ptr(this.#styled),
                ) === OK && this.#styled[0]
              ) {
                fg = this.#color(CELL_FG_COLOR)
                bg = this.#color(CELL_BG_COLOR)
              }
              // Spacer tails carry no text so they never reach here; we only
              // need the wide flag to know how far the run advances. ASCII is
              // always narrow, so skip two FFI calls on the common path.
              let width = 1
              if (
                text.codePointAt(0)! > 0x7f &&
                g.ghostty_render_state_row_cells_get(asPtr(cells), CELL_RAW, ptr(this.#raw)) ===
                  OK &&
                g.ghostty_cell_get(this.#raw[0]!, CELL_DATA_WIDE, ptr(this.#wide)) === OK &&
                this.#wide[0] === WIDE_WIDE
              ) {
                width = 2
              }
              if (text) visit(x, y, text, fg, bg, width)
            }
          }
          x++
        }
      }
      y++
    }
  }

  free() {
    g.ghostty_render_state_row_cells_free(asPtr(this.#cellsCur))
    g.ghostty_render_state_row_iterator_free(asPtr(this.#iter))
    g.ghostty_render_state_free(asPtr(this.#s))
  }
}
