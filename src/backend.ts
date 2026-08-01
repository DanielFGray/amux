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
import type { AttachClient } from "./attach.ts"

export interface AgentBackend {
  /** True once the stream is over: the process exited, or the attachment was
   *  lost, or it was never running to begin with. */
  readonly closed: boolean
  /** True when the stream ended because the client lost its attachment while
   * the daemon-owned process may still be running. */
  readonly detached: boolean
  /** Exit status once closed, null while running or when it is not knowable. */
  readonly exitCode: number | null
  /** Output bytes, ending when the backend closes. Iterated exactly once. */
  read(): AsyncIterable<Uint8Array>
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
    read: () => readPty(pty),
    write: (data) => pty.write(data),
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
  readonly attach: AttachClient
  spawn(spec: BackendOptions): Promise<void>
  kill(id: string): Promise<void>
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
    const chunks: Uint8Array[] = []
    let wake: (() => void) | null = null
    let closed = false
    let detached = false
    let exitCode: number | null = null
    const nudge = () => {
      const resume = wake
      wake = null
      resume?.()
    }

    const end = (code: number | null) => {
      if (closed) return
      closed = true
      exitCode = code
      nudge()
    }

    const unsubscribe = session.attach.subscribe(opts.id, {
      onOutput: (data) => {
        chunks.push(data)
        nudge()
      },
      onExit: end,
      // Detach is not death, but it is the end of what this backend can see.
      // Null rather than 0: an exit code we do not have is not an exit code of
      // zero, and the sidebar renders the difference.
      onDetach: () => {
        detached = true
        end(null)
      },
    })

    // Frames naming an agent the daemon has not started yet are dropped on the
    // floor by design (they are the tail of a dying agent's keystrokes), so
    // anything said before the spawn round trip completes has to wait here.
    let started = live.has(opts.id)
    const backlog: Array<() => void> = []
    const once = (action: () => void) => {
      if (started) action()
      else backlog.push(action)
    }

    if (started) {
      // An adopted agent was sized by whoever had it last. This client's
      // viewport is the current truth, so say so before drawing anything.
      session.attach.resize(opts.id, opts.cols, opts.rows)
    } else {
      session.spawn(opts).then(
        () => {
          started = true
          for (const action of backlog.splice(0)) action()
        },
        (error) => {
          backlog.length = 0
          // A spawn that never happened has no process to exit, so the agent
          // becomes a tombstone carrying the reason rather than a pane waiting
          // forever on bytes that are not coming.
          chunks.push(new TextEncoder().encode(`\r\n[daemon] could not start: ${String(error)}\r\n`))
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
      async *read() {
        try {
          for (;;) {
            while (chunks.length > 0) yield chunks.shift()!
            if (closed) return
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
        } finally {
          unsubscribe()
        }
      },
      write: (data) => once(() => session.attach.input(opts.id, data)),
      resize: (cols, rows) => once(() => session.attach.resize(opts.id, cols, rows)),
      kill: () => once(() => void session.kill(opts.id).catch(() => {})),
      // Process inspection reads /proc through the controlling tty, and the tty
      // is in the daemon. -1 is the answer every caller already handles, and it
      // is the honest one: this process cannot see that tty.
      foregroundPgid: () => -1,
      sessionId: () => -1,
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
    async *read() {},
    write() {},
    resize() {},
    kill() {},
    foregroundPgid: () => -1,
    sessionId: () => -1,
  }
}
