/* Shim for libghostty-vt calls that Bun FFI cannot express.
 *
 * ghostty_terminal_scroll_viewport takes GhosttyTerminalScrollViewport by
 * value. At 24 bytes it is MEMORY class under SysV AMD64, so it is passed on
 * the stack — unlike the 16-byte INTEGER-class structs elsewhere in this
 * binding, which can be split across registers. Bun FFI has no way to express
 * a stack-passed struct, so we compile a scalar wrapper with bun:ffi's cc(). */
#include <stddef.h>
#include <stdint.h>

extern int ghostty_terminal_new(const void *allocator, void **terminal,
                                 uint16_t cols, uint16_t rows);

int oh_terminal_new(void **terminal, uint16_t cols, uint16_t rows) {
  return ghostty_terminal_new(0, terminal, cols, rows);
}

#ifndef _WIN32
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/file.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

extern char **environ;
extern pid_t forkpty(int *master, char *name, const struct termios *termios,
                     const struct winsize *size);

typedef struct {
  const char *argv;
  uint64_t argv_len;
  const char *env;
  uint64_t env_len;
  const char *cwd;
  uint16_t rows;
  uint16_t cols;
} OhSpawnPtyRequest;

static char **oh_block_vector(const char *block, uint64_t len) {
  size_t count = 0;
  for (uint64_t i = 0; i < len; i++)
    if (block[i] == '\0') count++;
  char **values = calloc(count + 1, sizeof(char *));
  if (values == 0) return 0;
  size_t next = 0;
  for (uint64_t i = 0; i < len; i++) {
    if (i == 0 || block[i - 1] == '\0') values[next++] = (char *)&block[i];
  }
  return values;
}

static void oh_child_error(int error) {
  const char *message;
  switch (error) {
    case EACCES: message = "Permission denied\n"; break;
    case E2BIG: message = "Argument list too long\n"; break;
    case ENOEXEC: message = "Exec format error\n"; break;
    case ENOMEM: message = "Cannot allocate memory\n"; break;
    case ENOTDIR: message = "Not a directory\n"; break;
    case ENOENT: message = "No such file or directory\n"; break;
    default: message = "Could not execute command\n"; break;
  }
  size_t length = 0;
  while (message[length] != '\0') length++;
  while (length > 0) {
    ssize_t written = write(STDERR_FILENO, message, length);
    if (written > 0) {
      message += written;
      length -= (size_t)written;
    } else if (written < 0 && errno == EINTR) {
      continue;
    } else {
      break;
    }
  }
}

int oh_spawn_pty(const OhSpawnPtyRequest *req, int32_t out[2]) {
  if (req == 0 || out == 0 || req->argv == 0 || req->argv_len == 0 ||
      req->env == 0 || req->env_len == 0)
    return EINVAL;

  char **argv = oh_block_vector(req->argv, req->argv_len);
  char **env = oh_block_vector(req->env, req->env_len);
  if (argv == 0 || env == 0) {
    free(argv);
    free(env);
    return ENOMEM;
  }

  int cwd = -1;
  if (req->cwd != 0) {
    cwd = open(req->cwd, O_RDONLY | O_DIRECTORY);
    if (cwd < 0) {
      int error = errno;
      free(argv);
      free(env);
      return error;
    }
  }

  struct winsize size = {0};
  size.ws_row = req->rows;
  size.ws_col = req->cols;
  int master = -1;
  pid_t pid = forkpty(&master, 0, 0, &size);
  if (pid == 0) {
    if (cwd >= 0 && fchdir(cwd) != 0) goto child_error;
    if (cwd >= 0) close(cwd);
    environ = env;
    execvp(argv[0], argv);
child_error: {
      int error = errno;
      oh_child_error(error);
      _exit(127);
    }
  }

  int fork_error = errno;
  if (cwd >= 0) close(cwd);
  free(argv);
  free(env);
  if (pid < 0) return fork_error;

  int flags = fcntl(master, F_GETFL, 0);
  if (flags < 0 || fcntl(master, F_SETFL, flags | O_NONBLOCK) < 0) {
    int error = errno;
    kill(pid, SIGKILL);
    (void)waitpid(pid, 0, 0);
    close(master);
    return error;
  }
  if (fcntl(master, F_SETFD, FD_CLOEXEC) < 0) {
    int error = errno;
    kill(pid, SIGKILL);
    (void)waitpid(pid, 0, 0);
    close(master);
    return error;
  }
  out[0] = (int32_t)pid;
  out[1] = master;
  return 0;
}

int oh_wait_pid(int32_t pid, int32_t *exit_code) {
  int status = 0;
  pid_t result;
  do {
    result = waitpid((pid_t)pid, &status, WNOHANG);
  } while (result < 0 && errno == EINTR);
  if (result < 0) return -errno;
  if (result == 0) return 0;
  if (WIFEXITED(status)) *exit_code = WEXITSTATUS(status);
  else if (WIFSIGNALED(status)) *exit_code = 128 + WTERMSIG(status);
  else *exit_code = 1;
  return 1;
}

int oh_resize_pty(int fd, uint16_t rows, uint16_t cols) {
  struct winsize size = {0};
  size.ws_row = rows;
  size.ws_col = cols;
  return ioctl(fd, TIOCSWINSZ, &size);
}

int oh_tcgetpgrp(int fd) { return (int)tcgetpgrp(fd); }
int oh_close_fd(int fd) { return close(fd); }
int oh_flock(int fd, int operation) {
  if (flock(fd, operation | LOCK_NB) == 0) return 0;
  return errno;
}
int oh_flock_unlock(int fd) { return flock(fd, LOCK_UN); }
const char *oh_error_message(int error) { return strerror(error); }
#else
int oh_spawn_pty(const void *req, int32_t out[2]) { return 38; }
int oh_wait_pid(int32_t pid, int32_t *exit_code) { return -38; }
int oh_resize_pty(int fd, uint16_t rows, uint16_t cols) { return -1; }
int oh_tcgetpgrp(int fd) { return -1; }
int oh_close_fd(int fd) { return -1; }
int oh_flock(int fd, int operation) { return ENOTSUP; }
int oh_flock_unlock(int fd) { return -1; }
const char *oh_error_message(int error) { return "unsupported operation"; }
#endif

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

/* The capture request, passed as one pointer rather than as loose scalars.
 *
 * This used to be thirteen arguments. Bun's FFI mis-passed them once the call
 * stub was optimised under load: end_x — the sixth integer argument, the last
 * one SysV puts in a register — arrived as 0, so every capture ended at column
 * 0 of its last row and dropped that row's tail. It reproduced only in a full
 * test run, because a capture whose last row is blank loses nothing visible.
 * One pointer argument cannot be miscounted, so the boundary stays narrow no
 * matter how many fields the request grows. */
typedef struct {
  int32_t start_tag;
  uint32_t start_x;
  uint32_t start_y;
  int32_t end_tag;
  uint32_t end_x;
  uint32_t end_y;
  int32_t emit;
  uint8_t unwrap;
  uint8_t trim;
  uint8_t pad[2];
} OhCaptureRequest;

int oh_capture_range(GhosttyTerminal terminal, const OhCaptureRequest *req,
                     uint8_t *buf, uint64_t buf_len, uint64_t *out_written) {
  if (req == 0) return -2; /* GHOSTTY_INVALID_VALUE */

  /* Zeroed, not merely assigned field by field. These are sized/versioned
     structs with reserved and optional members: anything left unset is stack
     garbage that ghostty reads as a real option. */
  OhPoint start = {0};
  OhPoint end = {0};
  start.tag = req->start_tag;
  start.value[0] = ((uint64_t)req->start_y << 32) | (uint64_t)req->start_x;
  start.value[1] = 0;
  end.tag = req->end_tag;
  end.value[0] = ((uint64_t)req->end_y << 32) | (uint64_t)req->end_x;
  end.value[1] = 0;

  OhGridRef start_ref = {0};
  OhGridRef end_ref = {0};
  start_ref.size = sizeof(start_ref);
  end_ref.size = sizeof(end_ref);
  int r = ghostty_terminal_grid_ref(terminal, start, &start_ref);
  if (r != 0) return r;
  r = ghostty_terminal_grid_ref(terminal, end, &end_ref);
  if (r != 0) return r;

  OhSelection sel = {0};
  sel.size = sizeof(sel);
  sel.start = start_ref;
  sel.end = end_ref;
  sel.rectangle = 0;

  OhFormatterOptions opts = {0};
  opts.size = sizeof(opts);
  opts.emit = req->emit;
  opts.unwrap = req->unwrap;
  opts.trim = req->trim;
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

/* Serialize the terminal's active screen as VT that a fresh terminal can
 * consume to resume identical state.
 *
 * This is ghostty's own TerminalFormatter in VT mode with the mode and
 * screen-style extras enabled: modes (which includes the alternate-screen
 * switch), cursor position, the SGR style at the cursor, scrolling region,
 * tabstops, pwd (OSC 7) and keyboard modes. Together these reconstruct the
 * screen including its mode state, so an application on the alternate screen
 * is replayed onto a client terminal that re-enters the alternate screen —
 * which a raw byte-suffix replay cannot do. The palette is deliberately not
 * emitted (OSC 4): the replay target applies its own theme, and both ends
 * share ghostty defaults. Selection is NULL, which formats the whole active
 * screen (the replay terminal keeps no scrollback, so that is just the
 * screen). */
int oh_format_screen(GhosttyTerminal terminal, uint8_t *buf, uint64_t buf_len,
                     uint64_t *out_written) {
  OhFormatterOptions opts = {0};
  opts.size = sizeof(opts);
  opts.emit = 1; /* GHOSTTY_FORMATTER_FORMAT_VT */
  opts.unwrap = 0;
  opts.trim = 1;
  opts.extra.size = sizeof(opts.extra);
  opts.extra.palette = 0;
  opts.extra.modes = 1;
  opts.extra.scrolling_region = 1;
  opts.extra.tabstops = 1;
  opts.extra.pwd = 1;
  opts.extra.keyboard = 1;
  opts.extra.screen.size = sizeof(opts.extra.screen);
  opts.extra.screen.cursor = 1;
  opts.extra.screen.style = 1;
  opts.extra.screen.hyperlink = 1;
  opts.extra.screen.protection = 1;
  opts.extra.screen.kitty_keyboard = 1;
  opts.extra.screen.charsets = 1;

  void *formatter = 0;
  int r = ghostty_formatter_terminal_new(0, &formatter, terminal, opts);
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
  OhPoint start = {0};
  OhPoint end = {0};
  start.tag = 2;
  start.value[0] = ((uint64_t)start_y << 32) | (uint64_t)start_x;
  start.value[1] = 0;
  end.tag = 2;
  end.value[0] = ((uint64_t)end_y << 32) | (uint64_t)end_x;
  end.value[1] = 0;

  OhGridRef start_ref = {0};
  OhGridRef end_ref = {0};
  start_ref.size = sizeof(start_ref);
  end_ref.size = sizeof(end_ref);
  int r = ghostty_terminal_grid_ref(terminal, start, &start_ref);
  if (r != 0) return r;
  r = ghostty_terminal_grid_ref(terminal, end, &end_ref);
  if (r != 0) return r;

  OhSelection sel = {0};
  sel.size = sizeof(sel);
  sel.start = start_ref;
  sel.end = end_ref;
  sel.rectangle = 0;
  return ghostty_terminal_set(terminal, 21, &sel);
}

int oh_clear_selection(GhosttyTerminal terminal) {
  return ghostty_terminal_set(terminal, 21, NULL);
}
