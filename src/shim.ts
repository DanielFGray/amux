import { cc, CString, FFIType as T, ptr } from "bun:ffi"
import { LIB_DIR } from "./ghostty-library.ts"

/** Compiled at startup by bun:ffi's cc(). See src/shim.c for why this exists. */
const { symbols } = cc({
  source: new URL("./shim.c", import.meta.url).pathname,
  library: process.platform === "win32" ? ["ghostty-vt"] : ["ghostty-vt", "util"],
  flags: [`-L${LIB_DIR}`],
  symbols: {
    oh_terminal_new: { args: [T.ptr, T.ptr], returns: T.i32 },
    oh_scroll_viewport: { args: [T.u64, T.i32, T.i64], returns: T.void },
    oh_capture_range: {
      args: [T.u64, T.ptr, T.ptr, T.u64, T.ptr],
      returns: T.i32,
    },
    oh_set_selection: { args: [T.u64, T.u32, T.u32, T.u32, T.u32], returns: T.i32 },
    oh_clear_selection: { args: [T.u64], returns: T.i32 },
    oh_format_screen: { args: [T.u64, T.ptr, T.u64, T.ptr], returns: T.i32 },
    oh_spawn_pty: { args: [T.ptr, T.ptr], returns: T.i32 },
    oh_wait_pid: { args: [T.i32, T.ptr], returns: T.i32 },
    oh_resize_pty: { args: [T.i32, T.u16, T.u16], returns: T.i32 },
    oh_tcgetpgrp: { args: [T.i32], returns: T.i32 },
    oh_close_fd: { args: [T.i32], returns: T.i32 },
    oh_error_message: { args: [T.i32], returns: T.ptr },
  },
})

export function terminalNew(
  out: BigUint64Array,
  cols: number,
  rows: number,
  scrollback: number,
): number {
  const options = new Uint8Array(16)
  const view = new DataView(options.buffer)
  view.setUint16(0, cols, true)
  view.setUint16(2, rows, true)
  view.setBigUint64(8, BigInt(scrollback), true)
  return symbols.oh_terminal_new(ptr(out), ptr(options))
}

export interface SpawnedPty {
  readonly pid: number
  readonly master: number
}

export function spawnNativePty(
  cmd: readonly string[],
  opts: { cols: number; rows: number; cwd?: string; env?: Record<string, string> },
): SpawnedPty {
  if (process.platform === "win32") throw new Error("PTY processes are not supported on Windows")
  if (cmd.length === 0) throw new Error("PTY command must not be empty")
  if (cmd.some((value) => value.includes("\0")) || opts.cwd?.includes("\0")) {
    throw new Error("PTY command and cwd must not contain NUL bytes")
  }

  const argv = nulBlock(cmd)
  const environment = Object.entries({ ...process.env, ...opts.env, TERM: "xterm-256color" })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
  if (environment.some((value) => value.includes("\0"))) {
    throw new Error("PTY environment must not contain NUL bytes")
  }
  const env = nulBlock(environment)
  const cwd = opts.cwd === undefined ? undefined : nulString(opts.cwd)
  const request = new Uint8Array(48)
  const view = new DataView(request.buffer)
  view.setBigUint64(0, address(argv), true)
  view.setBigUint64(8, BigInt(argv.length), true)
  view.setBigUint64(16, address(env), true)
  view.setBigUint64(24, BigInt(env.length), true)
  view.setBigUint64(32, cwd === undefined ? 0n : address(cwd), true)
  view.setUint16(40, opts.rows, true)
  view.setUint16(42, opts.cols, true)

  const out = new Int32Array(2)
  const result = symbols.oh_spawn_pty(ptr(request), ptr(out))
  void argv; void env; void cwd;
  if (result !== 0) {
    const message = symbols.oh_error_message(result)
    const detail = message === null ? `errno ${result}` : new CString(message).toString()
    throw new Error(`forkpty failed: ${detail}`)
  }
  return { pid: out[0]!, master: out[1]! }
}

export function waitPid(pid: number): number | undefined {
  const code = new Int32Array(1)
  const result = symbols.oh_wait_pid(pid, ptr(code))
  if (result < 0) throw new Error(`waitpid failed (errno ${-result})`)
  return result === 0 ? undefined : code[0]!
}

export const resizePty = (fd: number, cols: number, rows: number) =>
  symbols.oh_resize_pty(fd, rows, cols)
export const ptyForegroundPgid = (fd: number) => symbols.oh_tcgetpgrp(fd)
export const closeFd = (fd: number) => symbols.oh_close_fd(fd)

const encoder = new TextEncoder()

function nulString(value: string): Uint8Array {
  const encoded = encoder.encode(value)
  const result = new Uint8Array(encoded.length + 1)
  result.set(encoded)
  return result
}

function nulBlock(values: readonly string[]): Uint8Array {
  const encoded = values.map((value) => encoder.encode(value))
  const result = new Uint8Array(encoded.reduce((size, value) => size + value.length + 1, 0))
  let offset = 0
  for (const value of encoded) {
    result.set(value, offset)
    offset += value.length + 1
  }
  return result
}

function address(value: Uint8Array): bigint {
  return BigInt(ptr(value) as unknown as number)
}

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

/**
 * Serialize the terminal's active screen as VT bytes that reconstruct the same
 * state in a fresh terminal: mode switches (alternate screen included), the
 * screen content with SGR styling, cursor position, and the rest of the
 * formatter's terminal extras. Used to replay an adopted agent's screen to a
 * reattaching client ahead of its live output.
 */
export function formatScreen(terminal: number): Uint8Array {
  const run = (buf: Uint8Array | null) => {
    const written = new BigUint64Array(1)
    const r = symbols.oh_format_screen(
      BigInt(terminal),
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
  if (fill.r !== Result.success) return new Uint8Array(0)

  // A formatter omits modes that already match defaults. Normalize the target
  // first so replay also works when a previous occupant left it in alt-screen
  // or left stale rows below the new screen contents.
  const prefix = new TextEncoder().encode("\x1b[?1049l\x1b[2J\x1b[H")
  const result = new Uint8Array(prefix.length + fill.n)
  result.set(prefix)
  result.set(buf.subarray(0, fill.n), prefix.length)
  return result
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
