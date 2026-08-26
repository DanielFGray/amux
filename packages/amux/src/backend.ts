/**
 * Where an Agent's bytes come from.
 *
 * An Agent is a terminal plus a stream of output and a sink for input. Until
 * now it reached straight for a local PTY, which made "the process runs in this
 * UI process" an assumption baked into the agent rather than a choice. It is a
 * choice: the same agent can be driven by a PTY the daemon owns and forwards
 * over the attach socket, and a restored agent whose process is already over is
 * driven by nothing at all.
 *
 * The interface is deliberately the small set Agent actually uses, not the Pty
 * surface — a remote backend has no master fd to hand out, and process
 * inspection is a local-only signal it answers -1 to.
 */

import { spawnPty, readPty } from "./pty.ts";
import { Effect, Fiber, Mailbox, Stream } from "effect";
import type { AttachClientContract } from "./attach.ts";
import { isProcessState, type ProcessState } from "./process-state.ts";
import { SESSION_STATE_TOPIC } from "./effect/AttachProtocol.ts";

export interface SessionBackend {
  /** True once the stream is over: the process exited, or the attachment was
   *  lost, or it was never running to begin with. */
  readonly closed: boolean;
  /** True when the stream ended because the client lost its attachment while
   * the daemon-owned process may still be running. */
  readonly detached: boolean;
  /** Exit status once closed, null while running or when it is not knowable. */
  readonly exitCode: number | null;
  /** Output bytes, ending when the backend closes. Run exactly once. */
  readonly stream: Stream.Stream<Uint8Array>;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Release this process's view. Local owners terminate; daemon projections detach. */
  close(): void;
  kill(): void;
  /**
   * Foreground process group and session id of the controlling terminal, or -1.
   *
   * Local-only: this is how a shell sitting at a prompt is told from one
   * running a command, and it is read from the tty by the process that owns it.
   * A backend that is not a local tty returns -1, which every caller already
   * treats as "no foreground process worth naming".
   */
  foregroundPgid(): number;
  sessionId(): number;
  readonly processState?: () => ProcessState | null;
}

export interface BackendOptions {
  /**
   * The agent this backend belongs to.
   *
   * A local PTY has no use for it — the fd is the identity. A daemon-owned one
   * has nothing else: every agent's bytes share one socket and are told apart
   * by this id. The daemon workspace allocates it; projections only adopt it.
   */
  id: string;
  cmd: string[];
  provider?: string;
  cwd?: string;
  cols: number;
  rows: number;
}

/**
 * Output chunks held for a daemon-owned agent before the UI draws them.
 *
 * Generous, because the cost of dropping here is visible corruption rather than
 * a dropped frame: a terminal's bytes are a stream, and losing a chunk out of
 * the middle leaves a half-parsed escape sequence. Bounded all the same,
 * because a pane the renderer has stopped reading must not grow without limit —
 * past this the writer backs up into the attach socket, which is where the
 * decision to drop belongs.
 */
const OUTPUT_LIMIT = 1024;

/** How an Agent obtains its backend. Swapping this is the whole point. */
export type SessionBackendFactory = (opts: BackendOptions) => SessionBackend;

/** A PTY in this process — what every agent used before there was a choice. */
export const localPty: SessionBackendFactory = (opts) => {
  const pty = spawnPty(opts.cmd, opts);
  return {
    get closed() {
      return pty.closed;
    },
    detached: false,
    get exitCode() {
      return pty.exitCode;
    },
    // Suspended so the generator is not created until something runs the
    // stream: constructing a backend must not start draining the master.
    stream: Stream.suspend(() => Stream.fromAsyncIterable(readPty(pty), (error) => error)).pipe(
      Stream.orDie,
    ),
    write: (data) => {
      // Input is intentionally fire-and-forget at the Agent boundary, but a
      // live PTY failure must not disappear silently. Interruption during
      // close/kill is expected; all other failures are actionable diagnostics.
      void pty.write(data).catch((error) => {
        if (!pty.closed) console.error("local PTY write failed", error);
      });
    },
    resize: (cols, rows) => pty.resize(cols, rows),
    close: () => {
      void pty.kill();
    },
    kill: () => pty.kill(),
    foregroundPgid: () => pty.foregroundPgid(),
    sessionId: () => pty.sessionId(),
  };
};

/**
 * The daemon, as far as a backend needs to know it.
 *
 * A projection only borrows terminal bytes. Process creation and destruction
 * are workspace transactions and are intentionally absent from this surface.
 */
export interface DaemonSession {
  readonly attach: AttachClientContract;
}

/**
 * An agent whose process lives in the daemon.
 *
 * The one behavioural difference from a local PTY, and the reason the daemon
 * exists: closing this process does not end the agent. The stream ends, the
 * backend reports itself closed with no exit code — "the attachment was lost",
 * not "the process died" — and the same agent is still there to be adopted
 * when a client comes back.
 *
 * `live` is the set of agents the daemon is already running. An id in it is
 * adopted rather than started: reattaching must never re-run a command, and the
 * only thing that distinguishes reattaching from starting fresh is this set.
 */
export function daemonBackend(
  session: DaemonSession,
  live: ReadonlySet<string> = new Set(),
): SessionBackendFactory {
  return (opts) => {
    let closed = false;
    let detached = false;
    let exitCode: number | null = null;
    let processState: ProcessState | null = null;

    /**
     * Foreground process group and session id, as reported by the daemon.
     *
     * The daemon owns the tty, so only it can answer tcgetpgrp/tcgetsid; it
     * publishes a `foreground` frame when the answer changes (and once when a
     * session starts). This cache is what the frame lands in, so
     * `foregroundPgid()` stays synchronous for Agent's polling getters and
     * returns -1 only until the first frame arrives — the same shape a local
     * PTY has before its shell is up.
     */
    let foregroundPgid = -1;
    let foregroundSid = -1;

    /**
     * Output waiting to be drawn.
     *
     * A Mailbox rather than a Queue because ending it still yields what it is
     * holding: the bytes a program writes immediately before exiting are the
     * ones that say why, and `Queue.shutdown` would discard them. Bounded, so a
     * UI that stalls cannot grow this without limit — which the array it
     * replaces could, and did.
     */
    const output = Effect.runSync(Mailbox.make<Uint8Array>(OUTPUT_LIMIT));

    const end = (code: number | null) => {
      if (closed) return;
      closed = true;
      exitCode = code;
      Effect.runFork(output.end);
    };

    const streamFiber = Effect.runFork(
      Stream.runForEach(session.attach.stream(opts.id), (frame) =>
        frame._tag === "output"
          ? output.offer(frame.data)
          : frame._tag === "exit"
            ? Effect.sync(() => end(frame.code))
            : frame._tag === "foreground"
              ? Effect.sync(() => {
                  foregroundPgid = frame.pgid;
                  foregroundSid = frame.sid;
                })
              : frame._tag === "topic" && frame.topic === SESSION_STATE_TOPIC
                ? Effect.sync(() => {
                    if (isProcessState(frame.payload)) processState = frame.payload;
                  })
                : Effect.void,
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!closed) {
              detached = true;
              end(null);
            }
          }),
        ),
      ),
    );

    if (live.has(opts.id)) {
      // An adopted agent was sized by whoever had it last. This client's
      // viewport is the current truth, so say so before drawing anything.
      session.attach.resize(opts.id, opts.cols, opts.rows);
      // And ask for its screen: this client was not there for the bytes that
      // drew it, so without a replay the pane stays blank until the program
      // next redraws. The resize frame precedes the sync, and the daemon
      // serializes at the resize it just applied.
      session.attach.sync(opts.id);
    } else if (opts.provider) {
      // Restored component sessions are pending plans. The client resolves
      // their provider after plugins load and starts them through the daemon.
    } else {
      Effect.runFork(
        output.offer(
          new TextEncoder().encode(`\r\n[daemon] modeled session '${opts.id}' is not live\r\n`),
        ),
      );
      end(null);
    }

    const close = () => {
      if (closed) return;
      detached = true;
      end(null);
      Effect.runFork(Fiber.interrupt(streamFiber));
    };

    return {
      get closed() {
        return closed;
      },
      get detached() {
        return detached;
      },
      get exitCode() {
        return exitCode;
      },
      // The frame reader outlives nothing: when whoever is drawing this stops,
      // the fiber forwarding frames into the mailbox goes with it.
      stream: Mailbox.toStream(output).pipe(Stream.ensuring(Fiber.interrupt(streamFiber))),
      write: (data) => {
        if (!closed) session.attach.input(opts.id, data);
      },
      resize: (cols, rows) => {
        if (!closed) session.attach.resize(opts.id, cols, rows);
      },
      close,
      // Projection code cannot kill daemon-owned processes. Explicit modeled
      // kills go through the revisioned workspace command path.
      kill: close,
      // The tty is in the daemon; these answer from its `foreground` frames
      // rather than from this process's view of the tty (which is -1). A
      // caller that reads /proc/<pgid> is reading a global namespace, so the
      // pgid alone is enough — the cmdline never needs to cross the wire.
      foregroundPgid: () => foregroundPgid,
      sessionId: () => foregroundSid,
      processState: () => processState,
    };
  };
}

/**
 * A backend for a process that is already over.
 *
 * Restoring a session must not re-run the commands in it. A persisted agent
 * that had already exited comes back as a tombstone: it keeps its name, its
 * command and its exit code so the sidebar can still say what happened, and it
 * starts nothing. Its screen is empty, because a session file is metadata and
 * never held the terminal's contents — see the note in snapshot.ts.
 */
export function exitedBackend(exitCode: number | null): SessionBackend {
  return {
    closed: true,
    detached: false,
    exitCode,
    stream: Stream.empty,
    write() {},
    resize() {},
    close() {},
    kill() {},
    foregroundPgid: () => -1,
    sessionId: () => -1,
  };
}
