/* Shim for libghostty-vt calls that Bun FFI cannot express.
 *
 * ghostty_terminal_scroll_viewport takes GhosttyTerminalScrollViewport by
 * value. At 24 bytes it is MEMORY class under SysV AMD64, so it is passed on
 * the stack — unlike the 16-byte INTEGER-class structs elsewhere in this
 * binding, which can be split across registers. Bun FFI has no way to express
 * a stack-passed struct, so we compile a scalar wrapper with bun:ffi's cc(). */
#include <stdint.h>

typedef uint64_t GhosttyTerminal;
typedef struct {
  int32_t tag;
  uint64_t value[2];
} GhosttyTerminalScrollViewport;

extern void ghostty_terminal_scroll_viewport(GhosttyTerminal terminal,
                                             GhosttyTerminalScrollViewport behavior);

void oh_scroll_viewport(GhosttyTerminal terminal, int32_t tag, int64_t value) {
  GhosttyTerminalScrollViewport behavior;
  behavior.tag = tag;
  behavior.value[0] = (uint64_t)value;
  behavior.value[1] = 0;
  ghostty_terminal_scroll_viewport(terminal, behavior);
}
