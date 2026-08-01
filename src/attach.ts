/**
 * The client end of the daemon's attach stream.
 *
 * The daemon owns the PTYs; this is how a UI process borrows them. One socket
 * carries every agent's bytes in both directions, tagged by agent id, so the
 * number of attached agents costs no extra file descriptors and their frames
 * stay in a single order.
 *
 * Deliberately plain TypeScript, not Effect. Effect owns the daemon's data
 * plane, where scopes and supervision are what make PTY ownership correct; the
 * UI side is an imperative renderer and a socket, and giving it a runtime would
 * buy nothing. The protocol is shared (see effect/AttachProtocol.ts) precisely
 * so the two ends cannot drift apart while the transports differ.
 */

import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./effect/AttachProtocol.ts"

/**
 * Seconds between heartbeats.
 *
 * The server drops a client that has said nothing for its idle timeout (60s by
 * default), and an attached UI showing an idle agent legitimately sends nothing
 * for hours. Comfortably under half the timeout, so a single lost ping is not a
 * disconnection.
 */
const PING_SECONDS = 20

/** How long `connect` waits for the hello to be accepted or refused. */
const HELLO_TIMEOUT_MS = 5_000

/**
 * Frames held for an agent nobody has subscribed to yet, per agent.
 *
 * Spawning is two steps — ask the daemon over RPC, then subscribe here — and
 * the process starts writing between them. Without this, the first line of
 * every agent's output would be dropped exactly when it matters most (a shell
 * prompt, a banner). Bounded because an agent that is never subscribed to is a
 * leak otherwise: past the limit the oldest frames go, which is the same thing
 * a terminal does to its scrollback.
 */
const QUEUE_LIMIT = 256

export interface AttachClientOptions {
  /** Unix socket path — SessionPaths.attach. */
  path: string
  /** Stable identity for this client. Reconnecting under the same id is a
   *  reconnect rather than a conflict; see SessionDaemon's claim rule. */
  client: string
  pingSeconds?: number
}

export interface AgentSink {
  onOutput(data: Uint8Array): void
  /** The process ended. */
  onExit(code: number | null): void
  /**
   * The attachment ended while this agent was still running.
   *
   * Deliberately not the same call as `onExit`: no more bytes are coming, but
   * the process is alive and another client — or this one, after reconnecting —
   * can pick it up. Collapsing the two would make a detach indistinguishable
   * from a death, which is the distinction the daemon exists to provide.
   */
  onDetach(): void
}

export class AttachError extends Error {}

export class AttachClient {
  readonly client: string
  #socket: Bun.Socket<undefined>
  #buffer = ""
  #closed = false
  #heartbeat: Timer | null = null
  /** Outstanding round trips, called with false when the attachment ends
   *  instead of being left pending forever. */
  #pongs = new Map<string, (answered: boolean) => void>()
  #sinks = new Map<string, AgentSink>()
  #queued = new Map<string, AttachFrame[]>()

  /**
   * The attachment ended: the socket closed, the daemon went away, or the
   * connection errored. Every agent is still whatever it was — this says
   * nothing about the processes, only about our view of them.
   */
  onClose?: (error: Error | null) => void
  /** An out-of-band error frame from the daemon, outside any one agent. */
  onError?: (message: string) => void

  private constructor(client: string, socket: Bun.Socket<undefined>) {
    this.client = client
    this.#socket = socket
  }

  /**
   * Connect and attach, resolving only once the daemon has accepted us.
   *
   * Acceptance is proven by a pong rather than by an ack frame the protocol
   * does not have: the server answers a ping only after a hello has been
   * accepted, and refuses one before it with an error and a hang-up. So a round
   * trip is exactly the acknowledgement we need, and it costs one frame that
   * the heartbeat would have sent anyway.
   */
  static connect(options: AttachClientOptions): Promise<AttachClient> {
    return new Promise<AttachClient>((resolve, reject) => {
      let attached: AttachClient | null = null
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
      }

      const timer = setTimeout(
        () => fail(new AttachError(`attach to ${options.path} timed out`)),
        HELLO_TIMEOUT_MS,
      )
      timer.unref?.()

      Bun.connect<undefined>({
        unix: options.path,
        socket: {
          binaryType: "buffer",
          open(socket) {
            // Hello and the probing ping in one write: the server decodes every
            // complete frame in a read, so batching them saves a round trip and
            // exercises the same path a real client's first keystrokes take.
            const nonce = `hello-${Math.random().toString(36).slice(2)}`
            attached = new AttachClient(options.client, socket)
            attached.#pongs.set(nonce, (answered) => {
              if (settled || !answered) return
              settled = true
              clearTimeout(timer)
              attached!.#startHeartbeat(options.pingSeconds ?? PING_SECONDS)
              resolve(attached!)
            })
            socket.write(
              encodeAttachFrame({ _tag: "hello", client: options.client }) +
                encodeAttachFrame({ _tag: "ping", nonce }),
            )
          },
          data(_socket, data) {
            if (attached) attached.#receive(data.toString("utf8"), fail)
          },
          close() {
            clearTimeout(timer)
            fail(new AttachError("daemon closed the attachment before accepting it"))
            if (attached) attached.#finish(null)
          },
          error(_socket, error) {
            clearTimeout(timer)
            fail(error)
            if (attached) attached.#finish(error)
          },
        },
      }).catch(fail)
    })
  }

  get closed(): boolean {
    return this.#closed
  }

  /**
   * Start receiving one agent's frames, and replay whatever arrived before now.
   *
   * Returns an unsubscribe. Frames for an agent with no sink are queued rather
   * than dropped, so subscribing after the process has already spoken — which
   * is the normal case, not an edge one — loses nothing.
   */
  subscribe(agent: string, sink: AgentSink): () => void {
    this.#sinks.set(agent, sink)
    const queued = this.#queued.get(agent)
    this.#queued.delete(agent)
    for (const frame of queued ?? []) this.#dispatch(frame, sink)
    return () => {
      if (this.#sinks.get(agent) === sink) this.#sinks.delete(agent)
    }
  }

  input(agent: string, data: string | Uint8Array): void {
    this.#send({
      _tag: "input",
      agent,
      data: typeof data === "string" ? new TextEncoder().encode(data) : data,
    })
  }

  resize(agent: string, cols: number, rows: number): void {
    this.#send({ _tag: "resize", agent, cols, rows })
  }

  /**
   * Ask the daemon to replay this agent's current screen to us, ahead of its
   * live output. Sent when adopting an agent whose process is already running;
   * without it the pane would be blank until the program next redraws.
   */
  sync(agent: string): void {
    this.#send({ _tag: "sync", agent })
  }

  /** Round-trip the daemon. Resolves false if the attachment ends first. */
  ping(timeoutMs = 5_000): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false)
    const nonce = `ping-${Math.random().toString(36).slice(2)}`
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#pongs.delete(nonce)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.#pongs.set(nonce, (answered) => {
        clearTimeout(timer)
        resolve(answered)
      })
      this.#send({ _tag: "ping", nonce })
    })
  }

  /** Detach. The daemon sees EOF and releases the attachment; the agents keep
   *  running, which is the entire point of there being a daemon. */
  close(): void {
    if (this.#closed) return
    this.#socket.end()
    this.#finish(null)
  }

  #send(frame: AttachFrame): void {
    if (this.#closed) return
    this.#socket.write(encodeAttachFrame(frame))
  }

  #startHeartbeat(seconds: number): void {
    this.#heartbeat = setInterval(() => {
      this.#send({ _tag: "ping", nonce: `beat-${Date.now()}` })
    }, seconds * 1000)
    this.#heartbeat.unref?.()
  }

  #receive(chunk: string, onProtocolError: (error: Error) => void): void {
    this.#buffer += chunk
    let decoded
    try {
      decoded = decodeAttachFrames(this.#buffer)
    } catch (error) {
      // A frame we cannot parse means the two ends disagree about the wire
      // format; continuing would silently act on a guess.
      onProtocolError(error instanceof Error ? error : new AttachError(String(error)))
      this.close()
      return
    }
    this.#buffer = decoded.rest
    for (const frame of decoded.frames) this.#route(frame)
  }

  #route(frame: AttachFrame): void {
    if (frame._tag === "pong") {
      this.#pongs.get(frame.nonce)?.(true)
      this.#pongs.delete(frame.nonce)
      return
    }
    if (frame._tag === "error") {
      this.onError?.(frame.message)
      return
    }
    if (frame._tag !== "output" && frame._tag !== "exit") return

    const sink = this.#sinks.get(frame.agent)
    if (sink) {
      this.#dispatch(frame, sink)
      return
    }
    const queue = this.#queued.get(frame.agent) ?? []
    // Output and exit share one queue so replay keeps their order: an exit
    // delivered ahead of the bytes that preceded it would blank a pane and
    // then write to it.
    if (queue.length >= QUEUE_LIMIT) queue.shift()
    queue.push(frame)
    this.#queued.set(frame.agent, queue)
  }

  #dispatch(frame: AttachFrame, sink: AgentSink): void {
    if (frame._tag === "output") sink.onOutput(frame.data)
    else if (frame._tag === "exit") sink.onExit(frame.code)
  }

  #finish(error: Error | null): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
    for (const resolve of this.#pongs.values()) resolve(false)
    this.#pongs.clear()
    // Every subscriber is told individually as well as through onClose: a sink
    // is what a pane's byte stream is built on, and it has to be ended rather
    // than left waiting for output that can no longer arrive.
    for (const sink of [...this.#sinks.values()]) sink.onDetach()
    this.#sinks.clear()
    this.#queued.clear()
    this.onClose?.(error)
  }
}
