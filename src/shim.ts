import { cc, FFIType as T, ptr } from "bun:ffi"
import { LIB_DIR } from "./ghostty.ts"

/** Compiled at startup by bun:ffi's cc(). See src/shim.c for why this exists. */
const { symbols } = cc({
  source: new URL("./shim.c", import.meta.url).pathname,
  library: ["ghostty-vt"],
  flags: [`-L${LIB_DIR}`],
  symbols: {
    oh_scroll_viewport: { args: [T.u64, T.i32, T.i64], returns: T.void },
    oh_capture_range: {
      args: [T.u64, T.ptr, T.ptr, T.u64, T.ptr],
      returns: T.i32,
    },
    oh_set_selection: { args: [T.u64, T.u32, T.u32, T.u32, T.u32], returns: T.i32 },
    oh_clear_selection: { args: [T.u64], returns: T.i32 },
  },
})

export const ScrollTo = { top: 0, bottom: 1, delta: 2, row: 3 } as const

export function scrollViewport(terminal: number, tag: number, value = 0) {
  symbols.oh_scroll_viewport(BigInt(terminal), tag, BigInt(value))
}

/** libghostty-vt Result enum (negative values; see terminal/c/result.zig). */
export const Result = {
  success: 0,
  outOfMemory: -1,
  invalidValue: -2,
  outOfSpace: -3,
} as const

/** Emit format for the formatter (GhosttyFormatterFormat). */
export const Emit = { plain: 0, vt: 1, html: 2 } as const

export interface CaptureRange {
  /** Tag of the start point (see point.h: screen=2 is the uniform space). */
  startTag: number
  startX: number
  startY: number
  endTag: number
  endX: number
  endY: number
}

/**
 * Byte layout of OhCaptureRequest in shim.c: seven 4-byte fields, then two
 * flags and two bytes of tail padding. Kept in one place because the two sides
 * only agree by convention — nothing checks this at compile time.
 */
const Request = {
  startTag: 0,
  startX: 4,
  startY: 8,
  endTag: 12,
  endX: 16,
  endY: 20,
  emit: 24,
  unwrap: 28,
  trim: 29,
  bytes: 32,
} as const

function encodeRequest(range: CaptureRange): Uint8Array {
  const req = new Uint8Array(Request.bytes)
  const view = new DataView(req.buffer)
  view.setInt32(Request.startTag, range.startTag, true)
  view.setUint32(Request.startX, range.startX, true)
  view.setUint32(Request.startY, range.startY, true)
  view.setInt32(Request.endTag, range.endTag, true)
  view.setUint32(Request.endX, range.endX, true)
  view.setUint32(Request.endY, range.endY, true)
  view.setInt32(Request.emit, Emit.plain, true)
  req[Request.unwrap] = 0 // keep soft-wrapped rows wrapped
  req[Request.trim] = 1 // drop trailing whitespace, as tmux does
  return req
}

/**
 * Format the range [start..end] (inclusive, both axes) as plain text.
 *
 * Returns the captured bytes. Rows are joined with newlines; trailing
 * whitespace on otherwise non-blank lines and trailing blank lines are
 * trimmed by the formatter's `trim` option.
 */
export function captureRange(terminal: number, range: CaptureRange): Uint8Array {
  const req = encodeRequest(range)
  const run = (buf: Uint8Array | null) => {
    const written = new BigUint64Array(1)
    const r = symbols.oh_capture_range(
      BigInt(terminal),
      ptr(req),
      buf ? ptr(buf) : null,
      buf ? BigInt(buf.length) : 0n,
      ptr(written),
    )
    return { r, n: Number(written[0]) }
  }

  const probe = run(null)
  if (probe.r !== Result.outOfSpace) return new Uint8Array(0)
  const buf = new Uint8Array(probe.n)
  const fill = run(buf)
  return fill.r === Result.success ? buf.subarray(0, fill.n) : new Uint8Array(0)
}

export function setSelection(
  terminal: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  const r = symbols.oh_set_selection(BigInt(terminal), startX, startY, endX, endY)
  if (r !== Result.success) throw new Error(`libghostty-vt: selection failed (${r})`)
}

export function clearSelection(terminal: number): void {
  const r = symbols.oh_clear_selection(BigInt(terminal))
  if (r !== Result.success) throw new Error(`libghostty-vt: clear selection failed (${r})`)
}
