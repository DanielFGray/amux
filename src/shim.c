/* Shim for libghostty-vt calls that Bun FFI cannot express.
 *
 * ghostty_terminal_scroll_viewport takes GhosttyTerminalScrollViewport by
 * value. At 24 bytes it is MEMORY class under SysV AMD64, so it is passed on
 * the stack — unlike the 16-byte INTEGER-class structs elsewhere in this
 * binding, which can be split across registers. Bun FFI has no way to express
 * a stack-passed struct, so we compile a scalar wrapper with bun:ffi's cc(). */
#include <stddef.h>
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

/* Capture a range of terminal content as plain text via the formatter.
 *
 * ghostty_terminal_grid_ref takes GhosttyPoint by value (24 bytes, MEMORY
 * class, stack-passed) and ghostty_formatter_terminal_new takes
 * GhosttyFormatterTerminalOptions by value (56 bytes, stack-passed), so both
 * are beyond Bun FFI. Points and options are therefore built here from
 * scalars. Coordinates use the SCREEN tag space: row 0 is the oldest row in
 * the scrollback and rows increase downward to the bottom of the active
 * screen, matching the scrollbar offset/total space. */

typedef struct {
  int32_t tag;
  uint64_t value[2];
} OhPoint; /* GhosttyPoint */

typedef struct {
  uint64_t size;
  void *node;
  uint16_t x;
  uint16_t y;
} OhGridRef; /* GhosttyGridRef */

typedef struct {
  uint64_t size;
  OhGridRef start;
  OhGridRef end;
  uint8_t rectangle;
} OhSelection; /* GhosttySelection */

typedef struct {
  uint64_t size;
  int32_t emit;
  uint8_t unwrap;
  uint8_t trim;
  uint8_t pad[2];
  struct {
    uint64_t size;
    uint8_t palette;
    uint8_t modes;
    uint8_t scrolling_region;
    uint8_t tabstops;
    uint8_t pwd;
    uint8_t keyboard;
    uint8_t pad2[2];
    struct {
      uint64_t size;
      uint8_t cursor;
      uint8_t style;
      uint8_t hyperlink;
      uint8_t protection;
      uint8_t kitty_keyboard;
      uint8_t charsets;
      uint8_t pad3[2];
    } screen;
  } extra;
  void *selection;
} OhFormatterOptions; /* GhosttyFormatterTerminalOptions */

extern int ghostty_terminal_grid_ref(GhosttyTerminal terminal, OhPoint point,
                                      OhGridRef *out_ref);
extern int ghostty_terminal_set(GhosttyTerminal terminal, int32_t option,
                                 const void *value);
extern int ghostty_formatter_terminal_new(const void *allocator, void **formatter,
                                          GhosttyTerminal terminal,
                                          OhFormatterOptions options);
extern int ghostty_formatter_format_buf(void *formatter, uint8_t *buf,
                                        size_t buf_len, size_t *out_written);
extern void ghostty_formatter_free(void *formatter);

int oh_capture_range(GhosttyTerminal terminal, int32_t start_tag,
                     uint32_t start_x, uint32_t start_y, int32_t end_tag,
                     uint32_t end_x, uint32_t end_y, int32_t emit,
                     uint8_t unwrap, uint8_t trim, uint8_t *buf,
                     uint64_t buf_len, uint64_t *out_written) {
  OhPoint start;
  OhPoint end;
  start.tag = start_tag;
  start.value[0] = ((uint64_t)start_y << 32) | (uint64_t)start_x;
  start.value[1] = 0;
  end.tag = end_tag;
  end.value[0] = ((uint64_t)end_y << 32) | (uint64_t)end_x;
  end.value[1] = 0;

  OhGridRef start_ref;
  OhGridRef end_ref;
  int r = ghostty_terminal_grid_ref(terminal, start, &start_ref);
  if (r != 0) return r;
  r = ghostty_terminal_grid_ref(terminal, end, &end_ref);
  if (r != 0) return r;

  OhSelection sel;
  sel.size = sizeof(sel);
  sel.start = start_ref;
  sel.end = end_ref;
  sel.rectangle = 0;

  OhFormatterOptions opts;
  opts.size = sizeof(opts);
  opts.emit = emit;
  opts.unwrap = unwrap;
  opts.trim = trim;
  opts.extra.size = sizeof(opts.extra);
  opts.extra.screen.size = sizeof(opts.extra.screen);
  opts.selection = &sel;

  void *formatter = 0;
  r = ghostty_formatter_terminal_new(0, &formatter, terminal, opts);
  if (r != 0) return r;
  r = ghostty_formatter_format_buf(formatter, buf, (size_t)buf_len,
                                   (size_t *)out_written);
  ghostty_formatter_free(formatter);
  return r;
}

/* Install the host selection in ghostty's active screen. The selection option
 * takes resolved grid references, so build those from SCREEN coordinates here
 * instead of trying to express the sized structs through Bun FFI. */
int oh_set_selection(GhosttyTerminal terminal, uint32_t start_x,
                     uint32_t start_y, uint32_t end_x, uint32_t end_y) {
  OhPoint start;
  OhPoint end;
  start.tag = 2;
  start.value[0] = ((uint64_t)start_y << 32) | (uint64_t)start_x;
  start.value[1] = 0;
  end.tag = 2;
  end.value[0] = ((uint64_t)end_y << 32) | (uint64_t)end_x;
  end.value[1] = 0;

  OhGridRef start_ref;
  OhGridRef end_ref;
  int r = ghostty_terminal_grid_ref(terminal, start, &start_ref);
  if (r != 0) return r;
  r = ghostty_terminal_grid_ref(terminal, end, &end_ref);
  if (r != 0) return r;

  OhSelection sel;
  sel.size = sizeof(sel);
  sel.start = start_ref;
  sel.end = end_ref;
  sel.rectangle = 0;
  return ghostty_terminal_set(terminal, 21, &sel);
}

int oh_clear_selection(GhosttyTerminal terminal) {
  return ghostty_terminal_set(terminal, 21, NULL);
}
