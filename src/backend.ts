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

import { spawnPty, readPty } from "./pty.ts"
import { Deferred, Effect, Fiber, Mailbox, Stream } from "effect"
import type { AttachClientShape } from "./attach.ts"

export interface AgentBackend {
  /** True once the stream is over: the process exited, or the attachment was
   *  lost, or it was never running to begin with. */
  readonly closed: boolean
  /** True when the stream ended because the client lost its attachment while
   * the daemon-owned process may still be running. */
  readonly detached: boolean
  /** Exit status once closed, null while running or when it is not knowable. */
  readonly exitCode: number | null
  /** Output bytes, ending when the backend closes. Run exactly once. */
  readonly stream: Stream.Stream<Uint8Array>
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
  /**
   * Foreground process group and session id of the controlling terminal, or -1.
   *
   * Local-only: this is how a shell sitting at a prompt is told from one
   * running a command, and it is read from the tty by the process that owns it.
   * A backend that is not a local tty returns -1, which every caller already
   * treats as "no foreground process worth naming".
   */
  foregroundPgid(): number
  sessionId(): number
}

export interface BackendOptions {
  /**
   * The agent this backend belongs to.
   *
   * A local PTY has no use for it — the fd is the identity. A daemon-owned one
   * has nothing else: every agent's bytes share one socket and are told apart
   * by this id, and the layout being persisted alongside is written in terms of
   * the same ids, so the client chooses it rather than the daemon.
   */
  id: string
  cmd: string[]
  cwd?: string
  cols: number
  rows: number
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
const OUTPUT_LIMIT = 1024

/** How an Agent obtains its backend. Swapping this is the whole point. */
export type SpawnBackend = (opts: BackendOptions) => AgentBackend

/** A PTY in this process — what every agent used before there was a choice. */
export const localPty: SpawnBackend = (opts) => {
  const pty = spawnPty(opts.cmd, opts)
  return {
    get closed() {
      return pty.closed
    },
    detached: false,
    get exitCode() {
      return pty.proc.exitCode
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
        if (!pty.closed) console.error("local PTY write failed", error)
      })
    },
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    foregroundPgid: () => pty.foregroundPgid(),
    sessionId: () => pty.sessionId(),
  }
}

/**
 * The daemon, as far as a backend needs to know it.
 *
 * Two planes, deliberately: `attach` carries bytes and is a live connection,
 * while `spawn` and `kill` change what agents exist and are request/response.
 * Splitting them is what lets a keystroke be fire-and-forget while a failed
 * spawn still has somewhere to report itself.
 */
export interface DaemonSession {
  readonly attach: AttachClientShape
  stream(agent: string): Stream.Stream<import("./effect/AttachProtocol.ts").AttachFrame>
  spawn(spec: BackendOptions): Effect.Effect<void, unknown, never>
  kill(id: string): Effect.Effect<void, unknown, never>
  save(workspace: Pick<import("./session.ts").SessionState, "spaces"> & { activeSpace?: string | null }): Effect.Effect<void, unknown, never>
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
): SpawnBackend {
  return (opts) => {
    let closed = false
    let detached = false
    let exitCode: number | null = null

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
    let foregroundPgid = -1
    let foregroundSid = -1

    /**
     * Output waiting to be drawn.
     *
     * A Mailbox rather than a Queue because ending it still yields what it is
     * holding: the bytes a program writes immediately before exiting are the
     * ones that say why, and `Queue.shutdown` would discard them. Bounded, so a
     * UI that stalls cannot grow this without limit — which the array it
     * replaces could, and did.
     */
    const output = Effect.runSync(Mailbox.make<Uint8Array>(OUTPUT_LIMIT))

    const end = (code: number | null) => {
      if (closed) return
      closed = true
      exitCode = code
      Effect.runFork(output.end)
    }

    const streamFiber = Effect.runFork(
      Stream.runForEach(session.attach.stream(opts.id), (frame) =>
        frame._tag === "output"
          ? output.offer(frame.data)
          : frame._tag === "exit"
            ? Effect.sync(() => end(frame.code))
            : frame._tag === "foreground"
              ? Effect.sync(() => {
                  foregroundPgid = frame.pgid
                  foregroundSid = frame.sid
                })
              : Effect.void,
      ).pipe(Effect.ensuring(Effect.sync(() => {
        if (!closed) {
          detached = true
          end(null)
        }
      }))),
    )

    /**
     * Resolved once this agent exists in the daemon.
     *
     * Frames naming an agent the daemon has not started yet are dropped on the
     * floor by design (they are the tail of a dying agent's keystrokes), so
     * anything said before the spawn round trip completes has to wait for this.
     */
    const started = Effect.runSync(Deferred.make<void>())
    const once = (action: () => void) =>
      Effect.runFork(Deferred.await(started).pipe(Effect.andThen(Effect.sync(action))))

    if (live.has(opts.id)) {
      Effect.runSync(Deferred.succeed(started, undefined))
      // An adopted agent was sized by whoever had it last. This client's
      // viewport is the current truth, so say so before drawing anything.
      session.attach.resize(opts.id, opts.cols, opts.rows)
      // And ask for its screen: this client was not there for the bytes that
      // drew it, so without a replay the pane stays blank until the program
      // next redraws. The resize frame precedes the sync, and the daemon
      // serializes at the resize it just applied.
      session.attach.sync(opts.id)
    } else {
      Effect.runPromise(session.spawn(opts)).then(
        () => Effect.runSync(Deferred.succeed(started, undefined)),
        (error) => {
          // A stale live snapshot can race the authoritative daemon spawn. The
          // daemon rejects the duplicate; this client adopts the already-owned
          // PTY instead of turning a successful session into a tombstone.
          if (String(error).includes("already live or starting")) {
            Effect.runSync(Deferred.succeed(started, undefined))
            session.attach.resize(opts.id, opts.cols, opts.rows)
            session.attach.sync(opts.id)
            return
          }
          // A spawn that never happened has no process to exit, so the agent
          // becomes a tombstone carrying the reason rather than a pane waiting
          // forever on bytes that are not coming. Interrupting the gate rather
          // than completing it discards whatever was queued behind it: there is
          // nothing to send it to.
          Effect.runFork(Deferred.interrupt(started))
          Effect.runFork(
            output.offer(new TextEncoder().encode(`\r\n[daemon] could not start: ${String(error)}\r\n`)),
          )
          end(null)
        },
      )
    }

    return {
      get closed() {
        return closed
      },
      get detached() {
        return detached
      },
      get exitCode() {
        return exitCode
      },
      // The frame reader outlives nothing: when whoever is drawing this stops,
      // the fiber forwarding frames into the mailbox goes with it.
      stream: Mailbox.toStream(output).pipe(
        Stream.ensuring(Fiber.interrupt(streamFiber)),
      ),
      write: (data) => once(() => session.attach.input(opts.id, data)),
      resize: (cols, rows) => once(() => session.attach.resize(opts.id, cols, rows)),
      kill: () => once(() => void Effect.runPromise(session.kill(opts.id)).catch(() => {})),
      // The tty is in the daemon; these answer from its `foreground` frames
      // rather than from this process's view of the tty (which is -1). A
      // caller that reads /proc/<pgid> is reading a global namespace, so the
      // pgid alone is enough — the cmdline never needs to cross the wire.
      foregroundPgid: () => foregroundPgid,
      sessionId: () => foregroundSid,
    }
  }
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
export function exitedBackend(exitCode: number | null): AgentBackend {
  return {
    closed: true,
    detached: false,
    exitCode,
    stream: Stream.empty,
    write() {},
    resize() {},
    kill() {},
    foregroundPgid: () => -1,
    sessionId: () => -1,
  }
}
