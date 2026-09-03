/** Resource limits shared by every disk, RPC, and terminal allocation boundary. */
export const MAX_TERMINAL_DIMENSION = 1_000;
export const MAX_TERMINAL_CELLS = 500_000;
export const MAX_LAYOUT_DEPTH = 64;
export const MAX_LAYOUT_NODES = 4_096;
export const MAX_LAYOUT_BYTES = 1_048_576;
export const MAX_SESSION_BYTES = 8 * 1_048_576;
export const MAX_RPC_BYTES = 1_048_576;
export const MAX_ATTACH_FRAME_BYTES = 8 * 1_048_576;
export const MAX_PENDING_BYTES = 4 * 1_048_576;
export const MAX_SPACES = 256;
export const MAX_WINDOWS = 2_048;
export const MAX_SESSIONS = 4_096;
export const MAX_HARNESS_LOG_LINES = 500;
export const DEFAULT_HARNESS_LOG_LINES = 50;

export function isTerminalSize(cols: number, rows: number): boolean {
  return (
    Number.isSafeInteger(cols) &&
    Number.isSafeInteger(rows) &&
    cols > 0 &&
    rows > 0 &&
    cols <= MAX_TERMINAL_DIMENSION &&
    rows <= MAX_TERMINAL_DIMENSION &&
    cols * rows <= MAX_TERMINAL_CELLS
  );
}

export function assertTerminalSize(cols: number, rows: number): void {
  if (!isTerminalSize(cols, rows)) {
    throw new Error(
      `terminal size must be positive and at most ${MAX_TERMINAL_DIMENSION}x${MAX_TERMINAL_DIMENSION} / ${MAX_TERMINAL_CELLS} cells`,
    );
  }
}
