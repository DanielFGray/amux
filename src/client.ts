/**
 * Talking to a session daemon, from the UI process.
 *
 * This is the whole client half of the multiplexer split, and it is small on
 * purpose. Two planes, one object: `spawn`, `kill` and `save` are RPC calls
 * that change what the session *is*, and `attach` is the live stream that
 * carries what the session is *doing*. The rest of the app sees neither — it
 * sees a SpawnBackend, and agents behave the same whether their PTYs are here
 * or in the daemon.
 *
 * The daemon is started on demand. That is what makes attaching feel like tmux:
 * you run the program, and whether that is the first client of a new session or
 * the fourth client of an old one is something you find out from what is on
 * screen, not something you have to decide beforehand.
 */

import { spawn } from "node:child_process"
import { AttachClient } from "./attach.ts"
import { daemonBackend, type BackendOptions, type DaemonSession, type SpawnBackend } from "./backend.ts"
import { daemonRequest, type DaemonResponse } from "./daemon.ts"
import { readLease, processAlive, sessionPaths, type SessionState } from "./session.ts"

/** How long to wait for a daemon we started to answer its first ping. */
const START_TIMEOUT_MS = 10_000
const POLL_MS = 25

export interface SessionClientOptions {
  /** Stable identity for this client, so a reconnect is not read as a second
   *  client trying to steal the session. Defaults to this process. */
  client?: string
  /** Start a daemon if none is running. Off for tests that supply their own. */
  autostart?: boolean
  env?: NodeJS.ProcessEnv
}

export class SessionClientError extends Error {}

export class SessionClient implements DaemonSession {
  readonly id: string
  readonly attach: AttachClient
  /**
   * The workspace as the daemon had it when we attached.
   *
   * A snapshot, not a subscription: the daemon is the writer, and this is what
   * restore rebuilds from. Null when the session is new.
   */
  readonly session: SessionState | null
  /**
   * The agents the daemon is already running.
   *
   * The difference between this and the agents in `session` is precisely the
   * difference between reattaching and restarting: an agent in both is adopted
   * with its process and scrollback intact, one only in `session` is re-run
   * from scratch or comes back as a tombstone.
   */
  readonly live: ReadonlySet<string>
  readonly #env: NodeJS.ProcessEnv

  private constructor(
    id: string,
    attach: AttachClient,
    session: SessionState | null,
    live: ReadonlySet<string>,
    env: NodeJS.ProcessEnv,
  ) {
    this.id = id
    this.attach = attach
    this.session = session
    this.live = live
    this.#env = env
  }

  /**
   * Attach to session `id`, starting its daemon if there is not one.
   *
   * Order matters and is the reverse of what looks natural: status is read
   * *after* the attach stream is up. The daemon can hand out a live agent list
   * that is already stale by the time the socket is connected, and adopting an
   * agent that has since exited leaves a pane waiting on a dead stream —
   * whereas an agent that exits after we have subscribed sends us its exit
   * frame like any other.
   */
  static async connect(id: string, options: SessionClientOptions = {}): Promise<SessionClient> {
    const env = options.env ?? process.env
    if (options.autostart !== false) await ensureDaemon(id, env)

    const attach = await AttachClient.connect({
      path: sessionPaths(id, env).attach,
      client: options.client ?? `pid-${process.pid}`,
    })

    let status: DaemonResponse
    try {
      status = await daemonRequest(id, { command: "status" }, env)
    } catch (error) {
      attach.close()
      throw new SessionClientError(`session '${id}' did not answer status: ${String(error)}`)
    }

    return new SessionClient(id, attach, status.session ?? null, new Set(status.agents ?? []), env)
  }

  /** Where agents get their processes. Hand this to Agent, or to restore. */
  backend(): SpawnBackend {
    return daemonBackend(this, this.live)
  }

  async spawn(spec: BackendOptions): Promise<void> {
    const response = await daemonRequest(this.id, {
      command: "spawn",
      spawn: { id: spec.id, cmd: spec.cmd, cwd: spec.cwd, cols: spec.cols, rows: spec.rows },
    }, this.#env)
    if (!response.ok) throw new SessionClientError(response.error ?? "spawn refused")
  }

  async kill(agent: string): Promise<void> {
    await daemonRequest(this.id, { command: "kill", agent }, this.#env).catch(() => {})
  }

  /** Record the workspace. The daemon owns session.json; we never write it. */
  async save(workspace: Pick<SessionState, "spaces"> & { activeSpace?: string | null }): Promise<void> {
    const response = await daemonRequest(this.id, { command: "save", workspace }, this.#env)
    if (!response.ok) throw new SessionClientError(response.error ?? "save refused")
  }

  /** Detach. Agents keep running; that is the point. */
  close(): void {
    this.attach.close()
  }

  /** Stop the session outright — every agent dies and the state is discarded.
   *  The deliberate opposite of `close`. */
  async stop(): Promise<void> {
    this.attach.close()
    await daemonRequest(this.id, { command: "stop" }, this.#env).catch(() => {})
  }
}

/** True if a daemon for `id` is running and answering. */
export async function daemonAlive(id: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const lease = await readLease(id, env)
  // The lease says a process owns this session; the ping says it is still
  // listening. Both, because a lease outlives a hard kill by up to a heartbeat.
  if (!lease || !processAlive(lease.pid)) return false
  try {
    return (await daemonRequest(id, { command: "ping" }, env)).ok
  } catch {
    return false
  }
}

/**
 * Start a daemon for `id` unless one is already answering.
 *
 * Detached and with its stdio let go, because it must outlive us — a daemon
 * that dies with the terminal that spawned it would defeat the entire exercise.
 */
export async function ensureDaemon(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (await daemonAlive(id, env)) return

  const entry = new URL("./daemon-main.ts", import.meta.url).pathname
  const child = spawn(process.execPath, [entry, id], {
    detached: true,
    stdio: "ignore",
    env: env as NodeJS.ProcessEnv,
  })
  child.unref()

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await daemonAlive(id, env)) return
    await Bun.sleep(POLL_MS)
  }
  throw new SessionClientError(`daemon for session '${id}' did not start within ${START_TIMEOUT_MS}ms`)
}
