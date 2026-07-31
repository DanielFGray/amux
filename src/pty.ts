import { dlopen, FFIType as T, ptr } from "bun:ffi"

const { symbols: libc } = dlopen("libc.so.6", {
  // int openpty(int *amaster, int *aslave, char *name, const termios *tp, const winsize *wp)
  openpty: { args: [T.ptr, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
  ioctl: { args: [T.i32, T.u64, T.ptr], returns: T.i32 },
  close: { args: [T.i32], returns: T.i32 },
  fcntl: { args: [T.i32, T.i32, T.i32], returns: T.i32 },
  tcgetpgrp: { args: [T.i32], returns: T.i32 },
  tcgetsid: { args: [T.i32], returns: T.i32 },
})

const TIOCSWINSZ = 0x5414n
const F_GETFL = 3
const F_SETFL = 4
const O_NONBLOCK = 0o4000

/** struct winsize { u16 row, col, xpixel, ypixel } */
function winsize(rows: number, cols: number): Uint16Array {
  return new Uint16Array([rows, cols, 0, 0])
}

export interface Pty {
  master: number
  proc: Bun.Subprocess
  /** True once the master fd has been closed. readPty() bails on this before
   *  every read so a pump that outlived its agent can never touch an fd that
   *  has been closed and reused by a newer agent. */
  readonly closed: boolean
  /** Foreground process group of the terminal, or -1. Equal to the child's own
   *  pgid when the shell sits at a prompt; a different pgid means a command is
   *  running in the foreground. This is how we tell "idle" from "working". */
  foregroundPgid(): number
  /** Session id of the terminal = the pid of the session leader (the shell).
   *  Used instead of proc.pid because we launch via setsid(1), whose pid is
   *  not the shell's. */
  sessionId(): number
  resize(cols: number, rows: number): void
  write(data: string | Uint8Array): void
  kill(): void
  /** Idempotent: the master fd is closed exactly once no matter how many of
   *  {process exit, kill, dispose, shutdown} fire. */
  close(): void
}

/** PIDs of every process in a session, so kill() can take down background jobs
 *  the shell left in other process groups instead of orphaning them.
 *  Linux-only (/proc); the setsid launch path is already Linux-only. */
function sessionPids(session: number): number[] {
  const pids: number[] = []
  let entries: string[]
  try {
    entries = require("node:fs").readdirSync("/proc")
  } catch {
    return pids
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // stat: "pid (comm) state ppid pgrp session ..." — comm may contain
      // spaces and parens, so find the closing paren and index from there.
      const stat = require("node:fs").readFileSync(`/proc/${entry}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      if (Number(fields[3]) === session) pids.push(Number(entry))
    } catch {
      // raced with process exit; ignore
    }
  }
  return pids
}

export function spawnPty(
  cmd: string[],
  opts: { cols: number; rows: number; cwd?: string; env?: Record<string, string> },
): Pty {
  const am = new Int32Array(1)
  const as = new Int32Array(1)
  const ws = winsize(opts.rows, opts.cols)

  if (libc.openpty(ptr(am), ptr(as), null, null, ptr(ws)) !== 0) {
    throw new Error("openpty failed")
  }
  const master = am[0]!
  const slave = as[0]!

  // Without this, readSync() on the master blocks the entire event loop.
  libc.fcntl(master, F_SETFL, libc.fcntl(master, F_GETFL, 0) | O_NONBLOCK)

  // The child must be a session leader owning the slave as its controlling
  // terminal, or shells lose job control. forkpty(3) does this for us, but
  // Bun.spawn gives no hook for the between-fork-and-exec window, so we
  // delegate to setsid(1). Linux/util-linux only — macOS needs a different
  // approach (a tiny forkpty shim via FFI is the portable fix).
  const launch = Bun.which("setsid") ? ["setsid", "-c", ...cmd] : cmd

  // closed flips on the first close (whichever path gets there first) and is
  // what readPty checks, so a stale pump can never read a reused fd.
  let closed = false
  const closeMaster = () => {
    if (closed) return
    closed = true
    libc.close(master)
  }

  const proc = Bun.spawn(launch, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, TERM: "xterm-256color" },
    stdio: [slave, slave, slave],
    onExit() {
      closeMaster()
    },
  })
  // parent doesn't need the slave end once the child holds it
  libc.close(slave)

  return {
    master,
    proc,
    get closed() {
      return closed
    },
    foregroundPgid() {
      return libc.tcgetpgrp(master)
    },
    sessionId() {
      return libc.tcgetsid(master)
    },
    resize(cols, rows) {
      if (closed) return
      libc.ioctl(master, TIOCSWINSZ, ptr(winsize(rows, cols)))
    },
    write(data) {
      if (closed) return
      const buf = typeof data === "string" ? new TextEncoder().encode(data) : data
      // The master is O_NONBLOCK, so a single write can complete partially or
      // hit EAGAIN when the child's input queue is full. Loop until every byte
      // is in: the child is effectively wedged if this ever spins long, and
      // dropping bytes would silently corrupt the session.
      let off = 0
      while (off < buf.length) {
        let n: number
        try {
          n = require("node:fs").writeSync(master, buf, off, buf.length - off, null)
        } catch (e: any) {
          if (e.code === "EAGAIN") {
            Bun.sleepSync(1)
            continue
          }
          throw e
        }
        if (n <= 0) throw new Error("pty write stalled")
        off += n
      }
    },
    kill() {
      if (closed) return
      const session = libc.tcgetsid(master)
      if (session > 0) {
        // Signal the whole session so neither the foreground command nor a
        // background job is left orphaned; closing the master below then sends
        // SIGHUP to the session's controlling terminal as a backstop.
        for (const pid of sessionPids(session)) {
          try {
            process.kill(pid, "SIGTERM")
          } catch {
            // already gone
          }
        }
      } else {
        try {
          proc.kill()
        } catch {
          // already gone
        }
      }
      closeMaster()
    },
    close() {
      closeMaster()
    },
  }
}

/** Async iterator over raw PTY output bytes. */
export async function* readPty(pty: Pty): AsyncGenerator<Uint8Array> {
  const fs = require("node:fs")
  const buf = Buffer.alloc(65536)
  while (!pty.closed) {
    let n: number
    try {
      n = fs.readSync(pty.master, buf, 0, buf.length, null)
    } catch (e: any) {
      // EAGAIN = nothing to read yet; EBADF/EIO = closed or child exited.
      if (pty.closed) return
      if (e.code === "EAGAIN") {
        await Bun.sleep(4)
        continue
      }
      return
    }
    if (n <= 0) return
    yield new Uint8Array(buf.subarray(0, n))
  }
}
