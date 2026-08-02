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
/** A trapped TERM must not make daemon shutdown unbounded. */
const TERMINATE_GRACE_MS = 200
const KILL_SETTLE_MS = 500

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
  /** True once the child process has exited, which is not the same as the
   *  master being closed: bytes the child wrote just before exiting are still
   *  in the terminal's buffer and are still ours to read. See readPty. */
  readonly exited: boolean
  /** Resolves after the entire process session has terminated and the master closed. */
  readonly wait: Promise<void>
  /** Foreground process group of the terminal, or -1. Equal to the child's own
   *  pgid when the shell sits at a prompt; a different pgid means a command is
   *  running in the foreground. This is how we tell "idle" from "working". */
  foregroundPgid(): number
  /** Session id of the terminal = the pid of the session leader (the shell).
   *  Used instead of proc.pid because we launch via setsid(1), whose pid is
   *  not the shell's. */
  sessionId(): number
  resize(cols: number, rows: number): void
  write(data: string | Uint8Array, signal?: AbortSignal): Promise<void>
  /** Signal the session and wait until every member has reached a terminal state. */
  kill(): Promise<void>
  /** Idempotent: the master fd is closed exactly once no matter how many of
   *  {process exit, kill, dispose, shutdown} fire. */
  close(): void
}

/** PIDs of every process in a session, so kill() can take down background jobs
 *  the shell left in other process groups instead of orphaning them.
 *  Linux-only (/proc); the setsid launch path is already Linux-only. */
type SessionMember = { pid: number; state: string }

function sessionMembers(session: number): SessionMember[] {
  const members: SessionMember[] = []
  let entries: string[]
  try {
    entries = require("node:fs").readdirSync("/proc")
  } catch {
    return members
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // stat: "pid (comm) state ppid pgrp session ..." — comm may contain
      // spaces and parens, so find the closing paren and index from there.
      const stat = require("node:fs").readFileSync(`/proc/${entry}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      if (Number(fields[3]) === session) members.push({ pid: Number(entry), state: fields[0]! })
    } catch {
      // raced with process exit; ignore
    }
  }
  return members
}

function liveSessionMembers(session: number): SessionMember[] {
  // Zombies are no longer executing and cannot produce output. They remain in
  // /proc until their parent reaps them, so they must not prevent termination.
  return sessionMembers(session).filter(({ state }) => state !== "Z" && state !== "X")
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
  let exited = false
  let writeTail = Promise.resolve()
  let killPromise: Promise<void> | undefined
  let session: number | undefined
  let beginTermination: (immediate: boolean) => Promise<void>
  const closeMaster = () => {
    if (closed) return
    closed = true
    libc.close(master)
  }

  /** How long the master stays open after the child exits, so a reader can
   *  collect what the child wrote on its way out. Reads are memory-speed; this
   *  only has to outlast one poll interval of readPty. */
  const DRAIN_GRACE_MS = 100

  const proc = Bun.spawn(launch, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, TERM: "xterm-256color" },
    stdio: [slave, slave, slave],
    onExit() {
      // The leader can exit while a background member remains in the session.
      // Marking only the leader as done would publish exit and release the id
      // while that member could still write or outlive the daemon.
      exited = true
      void beginTermination(false)
    },
  })
  // parent doesn't need the slave end once the child holds it
  libc.close(slave)
  // Cache the SID while the master is unquestionably valid. A fast leader can
  // exit before a caller gets a chance to call sessionId(), but its children
  // still belong to this session and remain our termination responsibility.
  const initialSession = libc.tcgetsid(master)
  if (initialSession > 0) session = initialSession

  beginTermination = (immediate) => {
    if (killPromise) return killPromise
    killPromise = (async () => {
      const sid = session ?? libc.tcgetsid(master)
      if (sid > 0) session = sid
      const signal = (name: "SIGTERM" | "SIGKILL") => {
        if (sid > 0) {
            // Enumerate rather than signal one process group: background jobs
            // can use separate groups while remaining in this session.
            for (const { pid } of liveSessionMembers(sid)) {
              try { process.kill(pid, name) } catch { /* raced with exit */ }
            }
        } else {
          try { proc.kill(name) } catch { /* raced with exit */ }
        }
      }

      if (!immediate) await Bun.sleep(DRAIN_GRACE_MS)
      signal("SIGTERM")
      await Promise.race([proc.exited, Bun.sleep(TERMINATE_GRACE_MS)])
      const deadline = Date.now() + KILL_SETTLE_MS
      while (sid > 0 && liveSessionMembers(sid).length > 0 && Date.now() < deadline) {
        // Re-scan on every pass. A TERM trap can fork a replacement, and a
        // single snapshot would leave that replacement behind.
        signal("SIGKILL")
        await Bun.sleep(10)
      }
      if (sid > 0) {
        signal("SIGKILL")
        while (liveSessionMembers(sid).length > 0 && Date.now() < deadline) {
          signal("SIGKILL")
          await Bun.sleep(10)
        }
      } else {
        try { proc.kill("SIGKILL") } catch { /* raced with exit */ }
        await Promise.race([proc.exited, Bun.sleep(KILL_SETTLE_MS)])
      }
      const processTerminated = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(KILL_SETTLE_MS).then(() => false),
      ])
      if (!processTerminated) throw new Error("pty leader did not terminate before deadline")
      if (sid > 0 && liveSessionMembers(sid).length > 0) {
        throw new Error(`pty session ${sid} did not terminate before deadline`)
      }
      closeMaster()
    })()
    return killPromise
  }

  // The callback above is installed before this assignment, but Bun invokes
  // onExit asynchronously after spawn returns.
  const result = {
    master,
    proc,
    get closed() {
      return closed
    },
    get exited() {
      return exited
    },
    get wait() {
      return killPromise ?? beginTermination(false)
    },
    foregroundPgid() {
      return libc.tcgetpgrp(master)
    },
    sessionId() {
      if (session !== undefined) return session
      const value = libc.tcgetsid(master)
      if (value > 0) session = value
      return value
    },
    resize(cols: number, rows: number) {
      if (closed) return
      libc.ioctl(master, TIOCSWINSZ, ptr(winsize(rows, cols)))
    },
    write(data: string | Uint8Array, signal?: AbortSignal) {
      const buf = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)
      const write = writeTail.then(async () => {
        if (closed || signal?.aborted) throw new Error("pty write interrupted")
        let off = 0
        while (off < buf.length) {
          if (closed || signal?.aborted) throw new Error("pty write interrupted")
          let n: number
          try {
            n = require("node:fs").writeSync(master, buf, off, buf.length - off, null)
          } catch (e: any) {
            if (closed || signal?.aborted) throw new Error("pty write interrupted")
            if (e.code === "EAGAIN") {
              await Bun.sleep(1)
              continue
            }
            throw e
          }
          if (n <= 0) throw new Error("pty write stalled")
          off += n
        }
      })
      writeTail = write.catch(() => {})
      return write
    },
    kill() {
      return beginTermination(true)
    },
    close() {
      // Closing the master sends HUP and discards buffered output. All callers
      // therefore enter the same drain-aware termination operation instead.
      void beginTermination(true)
    },
  }
  return result
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
      // Nothing to read right now. The session terminator keeps the master
      // open while residual members may still produce output.
      if (e.code === "EAGAIN") {
        await Bun.sleep(4)
        continue
      }
      return
    }
    // A zero-length read is NOT end-of-file on a pty master. It is what Linux
    // reports while no process holds the slave, and there is such a window at
    // every spawn: the parent closes its copy of the slave as soon as Bun.spawn
    // returns, and setsid's child has not necessarily inherited it yet. Ending
    // the stream here loses every byte the agent will ever produce — invisible
    // for a command that writes instantly and total for one that takes a moment
    // to start, which is most agent CLIs.
    //
    // The authority on "the child is gone" is pty.closed, set from the process's
    // own exit, and the loop is bounded by it. Real EOF on a master arrives as
    // EIO, which the catch above already treats as the end.
    if (n === 0) {
      await Bun.sleep(4)
      continue
    }
    if (n < 0) return
    yield new Uint8Array(buf.subarray(0, n))
  }
}
