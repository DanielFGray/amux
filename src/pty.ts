import { Schema as S } from "effect";
import { closeFd, ptyForegroundPgid, resizePty, spawnNativePty, waitPid } from "./shim.ts";

/** A trapped TERM must not make daemon shutdown unbounded. */
const TERMINATE_GRACE_MS = 200;
const KILL_SETTLE_MS = 500;

export class PtyWriteInterrupted extends S.TaggedError<PtyWriteInterrupted>()(
  "PtyWriteInterrupted",
  {
    reason: S.Literal("shutdown", "aborted"),
  },
) {}

export interface Pty {
  master: number;
  pid: number;
  readonly exitCode: number | null;
  readonly processExited: Promise<void>;
  /** True once the master fd has been closed. readPty() bails on this before
   *  every read so a pump that outlived its agent can never touch an fd that
   *  has been closed and reused by a newer agent. */
  readonly closed: boolean;
  /** True once the child process has exited, which is not the same as the
   *  master being closed: bytes the child wrote just before exiting are still
   *  in the terminal's buffer and are still ours to read. See readPty. */
  readonly exited: boolean;
  /** Resolves after the entire process session has terminated and the master
   *  closed.
   *
   *  **Destructive:** merely reading this property begins termination
   *  (SIGTERM after 100ms, then SIGKILL). It exists to be read exactly once
   *  by the exit path after output has ended; inspecting it for any other
   *  reason will kill the child. */
  readonly wait: Promise<void>;
  /** Foreground process group of the terminal, or -1. Equal to the child's own
   *  pgid when the shell sits at a prompt; a different pgid means a command is
   *  running in the foreground. This is how we tell "idle" from "working". */
  foregroundPgid(): number;
  /** Session id of the terminal = the pid of the session leader (the shell).
   *  forkpty makes the child both the session leader and controlling-terminal
   *  owner, so this normally equals pid. */
  sessionId(): number;
  resize(cols: number, rows: number): void;
  write(data: string | Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Signal the session and wait until every member has reached a terminal state. */
  kill(): Promise<void>;
  /** Idempotent: the master fd is closed exactly once no matter how many of
   *  {process exit, kill, dispose, shutdown} fire. */
  close(): void;
}

/** PIDs of every process in a session, so kill() can take down background jobs
 *  the shell left in other process groups instead of orphaning them. */
type SessionMember = { pid: number; state: string };

function sessionMembers(session: number): SessionMember[] {
  const members: SessionMember[] = [];
  let entries: string[];
  try {
    entries = require("node:fs").readdirSync("/proc");
  } catch {
    const result = Bun.spawnSync(["ps", "-Ao", "pid=,sid=,stat="]);
    if (result.exitCode !== 0) return members;
    for (const line of result.stdout.toString().split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      if (match && Number(match[2]) === session) {
        members.push({ pid: Number(match[1]), state: match[3]![0] ?? "" });
      }
    }
    return members;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // stat: "pid (comm) state ppid pgrp session ..." — comm may contain
      // spaces and parens, so find the closing paren and index from there.
      const stat = require("node:fs").readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[3]) === session) members.push({ pid: Number(entry), state: fields[0]! });
    } catch {
      // raced with process exit; ignore
    }
  }
  return members;
}

function liveSessionMembers(session: number): SessionMember[] {
  // Zombies are no longer executing and cannot produce output. They remain in
  // /proc until their parent reaps them, so they must not prevent termination.
  return sessionMembers(session).filter(({ state }) => state !== "Z" && state !== "X");
}

export function spawnPty(
  cmd: string[],
  opts: { cols: number; rows: number; cwd?: string; env?: Record<string, string> },
): Pty {
  const { master, pid } = spawnNativePty(cmd, opts);

  // closed flips on the first close (whichever path gets there first) and is
  // what readPty checks, so a stale pump can never read a reused fd.
  let closed = false;
  let exited = false;
  let exitCode: number | null = null;
  let writeTail = Promise.resolve();
  let killPromise: Promise<void> | undefined;
  // forkpty makes the child a session leader before returning in the parent.
  // Unlike a tty query, this remains available after an instant child exit.
  const session = pid;
  let beginTermination: (immediate: boolean) => Promise<void>;
  let resolveProcessExited!: () => void;
  const processExited = new Promise<void>((resolve) => {
    resolveProcessExited = resolve;
  });
  const closeMaster = () => {
    if (closed) return;
    closed = true;
    closeFd(master);
  };

  /** How long the master stays open after the child exits, so a reader can
   *  collect what the child wrote on its way out. Reads are memory-speed; this
   *  only has to outlast one poll interval of readPty. */
  const DRAIN_GRACE_MS = 100;

  beginTermination = (immediate) => {
    if (killPromise) return killPromise;
    killPromise = (async () => {
      const sid = session;
      const signal = (name: "SIGTERM" | "SIGKILL") => {
        if (sid > 0) {
          // Enumerate rather than signal one process group: background jobs
          // can use separate groups while remaining in this session.
          for (const { pid } of liveSessionMembers(sid)) {
            try {
              process.kill(pid, name);
            } catch {
              /* raced with exit */
            }
          }
        } else {
          try {
            process.kill(pid, name);
          } catch {
            /* raced with exit */
          }
        }
      };

      if (!immediate) await Bun.sleep(DRAIN_GRACE_MS);
      signal("SIGTERM");
      await Promise.race([processExited, Bun.sleep(TERMINATE_GRACE_MS)]);
      if (sid > 0) {
        // Re-scan on every pass. A TERM trap can fork a replacement, and a
        // single snapshot would leave that replacement behind.
        const deadline = Date.now() + KILL_SETTLE_MS;
        while (liveSessionMembers(sid).length > 0 && Date.now() < deadline) {
          signal("SIGKILL");
          await Bun.sleep(10);
        }
      } else {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* raced with exit */
        }
        await Promise.race([processExited, Bun.sleep(KILL_SETTLE_MS)]);
      }
      const processTerminated = await Promise.race([
        processExited.then(() => true),
        Bun.sleep(KILL_SETTLE_MS).then(() => false),
      ]);
      if (!processTerminated) throw new Error("pty leader did not terminate before deadline");
      if (sid > 0 && liveSessionMembers(sid).length > 0) {
        throw new Error(`pty session ${sid} did not terminate before deadline`);
      }
      closeMaster();
    })();
    return killPromise;
  };

  const result = {
    master,
    pid,
    get exitCode() {
      return exitCode;
    },
    processExited,
    get closed() {
      return closed;
    },
    get exited() {
      return exited;
    },
    get wait() {
      return killPromise ?? beginTermination(false);
    },
    foregroundPgid() {
      return ptyForegroundPgid(master);
    },
    sessionId() {
      return session;
    },
    resize(cols: number, rows: number) {
      if (closed) return;
      resizePty(master, cols, rows);
    },
    write(data: string | Uint8Array, signal?: AbortSignal) {
      const buf = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      const write = writeTail.then(async () => {
        const checkInterrupted = () => {
          if (closed) throw new PtyWriteInterrupted({ reason: "shutdown" });
          if (signal?.aborted) throw new PtyWriteInterrupted({ reason: "aborted" });
        };
        checkInterrupted();
        let off = 0;
        while (off < buf.length) {
          checkInterrupted();
          let n: number;
          try {
            n = require("node:fs").writeSync(master, buf, off, buf.length - off, null);
          } catch (e: any) {
            checkInterrupted();
            if (e.code === "EAGAIN") {
              await Bun.sleep(1);
              continue;
            }
            throw e;
          }
          if (n <= 0) throw new Error("pty write stalled");
          off += n;
        }
      });
      writeTail = write.catch(() => {});
      return write;
    },
    kill() {
      return beginTermination(true);
    },
    close() {
      // Closing the master sends HUP and discards buffered output. All callers
      // therefore enter the same drain-aware termination operation instead.
      void beginTermination(true);
    },
  };

  void (async () => {
    while (true) {
      const code = waitPid(pid);
      if (code !== undefined) {
        exitCode = code;
        exited = true;
        resolveProcessExited();
        // The leader can exit while background members remain in the session.
        void beginTermination(false);
        return;
      }
      await Bun.sleep(4);
    }
  })();
  return result;
}

/** Async iterator over raw PTY output bytes. */
export async function* readPty(pty: Pty): AsyncGenerator<Uint8Array> {
  const fs = require("node:fs");
  const buf = Buffer.alloc(65536);
  while (!pty.closed) {
    let n: number;
    try {
      n = fs.readSync(pty.master, buf, 0, buf.length, null);
    } catch (e: any) {
      // EAGAIN = nothing to read yet; EBADF/EIO = closed or child exited.
      if (pty.closed) return;
      // Nothing to read right now. The session terminator keeps the master
      // open while residual members may still produce output.
      if (e.code === "EAGAIN") {
        await Bun.sleep(4);
        continue;
      }
      // The master can report EIO just ahead of the waitpid poll. Keep the
      // output stream alive until exitCode has been recorded.
      if (e.code === "EIO" && !pty.exited) {
        await Bun.sleep(4);
        continue;
      }
      return;
    }
    // A zero-length master read is not a reliable process-exit signal. The
    // waitpid watcher owns that state; EIO above owns terminal EOF.
    if (n === 0) {
      await Bun.sleep(4);
      continue;
    }
    if (n < 0) return;
    yield new Uint8Array(buf.subarray(0, n));
  }
}
