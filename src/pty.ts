import { Schema as S } from "effect";
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";
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

/** How much output one yielded chunk may hold. Matches the read buffer of the
 *  sleep-poll this replaces, so a burst stays a handful of terminal writes. */
const READ_BATCH = 65536;
/** How long output may sit in a partial batch before it is flushed. One
 *  millisecond is far shorter than any human-perceptible latency yet long
 *  enough that a continuous stream keeps filling the batch instead. */
const READ_GAP_MS = 1;

/** Every /dev/ptmx fd this process holds, in /proc order. */
function ptmxFds(): number[] {
  const fds: number[] = [];
  let entries: string[];
  try {
    entries = require("node:fs").readdirSync("/proc/self/fd");
  } catch {
    return fds;
  }
  for (const entry of entries) {
    const fd = Number(entry);
    if (!Number.isInteger(fd)) continue;
    try {
      const target = require("node:fs").readlinkSync(`/proc/self/fd/${fd}`);
      if (target.includes("ptmx")) fds.push(fd);
    } catch {
      // raced with close; ignore
    }
  }
  return fds;
}

/** Bun's fd-backed file stream dups the master and leaks the dup: the stream
 *  always ends in EIO on a pty, and `reader.cancel()` only releases its fd
 *  when the stream has not errored. The dup is the one ptmx fd that appears
 *  while the stream is created, so it is found here and closed by the
 *  generator the moment the stream ends, restoring the old single-fd
 *  ownership. */
function openStream(master: number): {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  dup: number | null;
} {
  const before = new Set(ptmxFds());
  const reader = Bun.file(master).stream().getReader();
  const dup = ptmxFds().find((fd) => !before.has(fd)) ?? null;
  return { reader, dup };
}

/**
 * Async iterator over raw PTY output bytes.
 *
 * Drains through Bun's event-loop fd watcher (`Bun.file(fd).stream()`) rather
 * than a sleep-poll. The old loop ran `fs.readSync` once per 4ms per session —
 * a blocking syscall plus a timer wakeup at 250Hz even for an idle session,
 * N sessions deep on the same loop the renderer shares. A watched fd only
 * wakes the loop when bytes actually arrive.
 *
 * Stream chunks land small and the moment bytes do, so the generator batches
 * them into READ_BATCH and yields a chunk either when it fills or when the
 * stream goes quiet for READ_GAP_MS. Between reads it yields to the event
 * loop, so a flooding child cannot monopolize the loop's turn; after the
 * initial probe the idle path has no reads, no timers and no syscalls at all.
 *
 * The one synchronous read is the first pull: anything already in the master's
 * buffer is drained before the stream is created, because a stream read is an
 * `await` — and an `await` can lose a race the caller's next step depends on.
 * The daemon captures its replay screen right after spawn, so a first burst
 * that missed it would land at the cursor position the replay left behind.
 *
 * Each yielded chunk is owned: a fresh view over a batch buffer that is never
 * written again. Consumers may keep it past the next pull, and need no copy
 * at their ownership boundary.
 */
export async function* readPty(pty: Pty): AsyncGenerator<Uint8Array> {
  const fs = require("node:fs");
  const prime = Buffer.alloc(READ_BATCH);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // Bun's dup of the master, found when the stream is created and closed the
  // moment the stream ends: a pty stream always ends in EIO, and reader.cancel()
  // then never releases it. Closed synchronously at that point, so the number
  // cannot have been reused in between.
  let streamDup: number | null = null;
  let batch = new Uint8Array(READ_BATCH);
  let len = 0;
  // A read abandoned to a gap timer. Its result is bytes the stream already
  // handed to this generator, so it must be consumed on the next pull, never
  // dropped. It never rejects, so an abandoned read cannot surface as an
  // unhandled rejection while the consumer holds the generator at a yield.
  let carried: Promise<Outcome> | null = null;

  const gap = () => new Promise<"gap">((resolve) => setTimeout(() => resolve("gap"), READ_GAP_MS));
  const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** Wrap a read so its failure is a value. The pump both races reads against
   *  the gap timer and carries the loser across yields; a rejecting read
   *  abandoned to a timer is an unhandled rejection. */
  const outcome = (read: Promise<ReadableStreamReadResult<Uint8Array>>): Promise<Outcome> =>
    read.then(
      (next) => ({ tag: "read" as const, next }),
      (error) => ({ tag: "error" as const, error }),
    );
  const append = (chunk: Uint8Array) => {
    if (len + chunk.length > batch.length) {
      const grown = new Uint8Array(len + chunk.length);
      grown.set(batch.subarray(0, len));
      batch = grown;
    }
    batch.set(chunk, len);
    len += chunk.length;
  };
  const take = () => {
    const out = batch.subarray(0, len);
    batch = new Uint8Array(READ_BATCH);
    len = 0;
    return out;
  };
  /** EIO is terminal EOF and EBADF a master closed under us; neither can
   *  produce more bytes. The one gate is the exit code: the pump must not end
   *  before the waitpid watcher records it, because the consumer reads it the
   *  moment the stream ends. */
  const waitTerminal = async (error: { code?: string }) => {
    if (pty.closed) return;
    if (error.code === "EIO" && !pty.exited) await pty.processExited;
  };
  /** The stream has ended (error or done); Bun will not release its dup, so
   *  it is closed here, synchronously, before the number can be reused. */
  const closeStreamDup = () => {
    if (streamDup !== null) {
      closeFd(streamDup);
      streamDup = null;
    }
  };

  try {
    while (!pty.closed) {
      // First pulls: drain whatever is already in the master's buffer
      // synchronously, before the event-driven stream exists. This is what a
      // consumer that reads the terminal right after spawn sees — a stream
      // read is an `await`, and the caller's next step can run before it
      // resolves. The stream takes over at the first EAGAIN.
      if (!reader) {
        let n: number;
        try {
          n = fs.readSync(pty.master, prime, 0, prime.length, null);
        } catch (error: any) {
          if (pty.closed) return;
          if (error.code === "EAGAIN") {
            ({ reader, dup: streamDup } = openStream(pty.master));
            continue;
          }
          await waitTerminal(error);
          return;
        }
        if (n === 0) {
          ({ reader, dup: streamDup } = openStream(pty.master));
          continue;
        }
        if (n < 0) return;
        append(prime.subarray(0, n));
        yield take();
        continue;
      }
      const pending = carried ?? outcome(reader.read());
      carried = null;
      const first = await pending;
      if (first.tag === "error") {
        if (len > 0) yield take();
        closeStreamDup();
        await waitTerminal(first.error);
        return;
      }
      if (first.next.done) {
        if (len > 0) yield take();
        closeStreamDup();
        return;
      }
      if (first.next.value.length > 0) append(first.next.value);
      // Fill the batch while the stream keeps delivering, giving the loop a
      // turn between reads so a flood cannot starve the renderer's timer.
      while (len < READ_BATCH && !pty.closed) {
        const read = outcome(reader.read());
        const result = await Promise.race([read, gap()]);
        if (result === "gap") {
          carried = read;
          break;
        }
        if (result.tag === "error") {
          // The bytes already read are yielded before the terminal-EOF wait:
          // the exit code may not be recorded for another waitpid poll, and a
          // final batch of output must reach the consumer now, not four
          // milliseconds from now.
          if (len > 0) yield take();
          closeStreamDup();
          await waitTerminal(result.error);
          return;
        }
        if (result.next.done) {
          if (len > 0) yield take();
          closeStreamDup();
          return;
        }
        if (result.next.value.length > 0) append(result.next.value);
        await turn();
      }
      if (len > 0) yield take();
    }
  } finally {
    await reader?.cancel().catch(() => {});
  }
}

type Outcome =
  | { readonly tag: "read"; readonly next: ReadableStreamReadResult<Uint8Array> }
  | { readonly tag: "error"; readonly error: { code?: string } };
