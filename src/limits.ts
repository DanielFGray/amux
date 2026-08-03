/** Resource limits shared by every disk, RPC, and terminal allocation boundary. */
export const MAX_TERMINAL_DIMENSION = 1_000
export const MAX_TERMINAL_CELLS = 500_000
export const MAX_LAYOUT_DEPTH = 64
export const MAX_LAYOUT_NODES = 4_096
export const MAX_LAYOUT_BYTES = 1_048_576
export const MAX_SESSION_BYTES = 8 * 1_048_576
export const MAX_RPC_BYTES = 1_048_576
export const MAX_ATTACH_FRAME_BYTES = 8 * 1_048_576
export const MAX_SPACES = 256
export const MAX_WINDOWS = 2_048
export const MAX_AGENTS = 4_096

export function isTerminalSize(cols: unknown, rows: unknown): cols is number {
  return Number.isSafeInteger(cols) && Number.isSafeInteger(rows) &&
    (cols as number) > 0 && (rows as number) > 0 &&
    (cols as number) <= MAX_TERMINAL_DIMENSION && (rows as number) <= MAX_TERMINAL_DIMENSION &&
    (cols as number) * (rows as number) <= MAX_TERMINAL_CELLS
}

export function assertTerminalSize(cols: unknown, rows: unknown): asserts cols is number {
  if (!isTerminalSize(cols, rows)) {
    throw new Error(`terminal size must be positive and at most ${MAX_TERMINAL_DIMENSION}x${MAX_TERMINAL_DIMENSION} / ${MAX_TERMINAL_CELLS} cells`)
  }
}
