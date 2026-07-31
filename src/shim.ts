import { cc, FFIType as T } from "bun:ffi"
import { LIB_DIR } from "./ghostty.ts"

/** Compiled at startup by bun:ffi's cc(). See src/shim.c for why this exists. */
const { symbols } = cc({
  source: new URL("./shim.c", import.meta.url).pathname,
  library: ["ghostty-vt"],
  flags: [`-L${LIB_DIR}`],
  symbols: {
    oh_scroll_viewport: { args: [T.u64, T.i32, T.i64], returns: T.void },
  },
})

export const ScrollTo = { top: 0, bottom: 1, delta: 2, row: 3 } as const

export function scrollViewport(terminal: number, tag: number, value = 0) {
  symbols.oh_scroll_viewport(BigInt(terminal), tag, BigInt(value))
}
