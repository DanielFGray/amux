/**
 * The client end of the daemon's attach stream.
 *
 * The daemon owns the PTYs; this is how a UI process borrows them. One socket
 * carries every session's bytes in both directions, tagged by session id, so
 * the number of attached sessions costs no extra file descriptors and their
 * frames stay in a single order.
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
import { Deferred, Effect, Layer, Queue, Stream } from "effect"

/**
 * Seconds between heartbeats.
 *
 * The server drops a client that has said nothing for its idle timeout (60s by
 * default), and an attached UI showing an idle session legitimately sends
 * nothing
 * for hours. Comfortably under half the timeout, so a single lost ping is not a
 * disconnection.
 */
const PING_SECONDS = 20

/** How long `connect` waits for the hello to be accepted or refused. */
const HELLO_TIMEOUT_MS = 5_000

/**
 * Frames held for a session nobody has subscribed to yet, per session.
 *
 * Spawning is two steps — ask the daemon over RPC, then subscribe here — and
 * the process starts writing between them. Without this, the first line of
 * every session's output would be dropped exactly when it matters most (a
 * shell prompt, a banner). Bounded because a session that is never subscribed
 * to is a leak otherwise: past the limit the oldest frames go, which is the
 * same thing a terminal does to its scrollback.
 *
 * Sliding, specifically, not `Queue.bounded`. A bounded queue does not drop —
 * it suspends the offer until a taker makes room. Offers here are fire and
 * forget, so against a session nobody subscribes to every frame past the limit
 * would park a fibre that retains it, which is the unbounded growth this
 * constant exists to prevent, and the queue would hold the OLDEST frames while
 * the newest waited behind them.
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

export class AttachError extends Error {}

export interface AttachClientShape {
  readonly client: string
  readonly closed: boolean
  stream(session: string): Stream.Stream<AttachFrame>
  input(session: string, data: string | Uint8Array): void
  resize(session: string, cols: number, rows: number): void
  sync(session: string): void
  ping(timeoutMs?: number): Promise<boolean>
  close(): void
  onClose?: (error: Error | null) => void
  onError?: (message: string) => void
}

class AttachClientImpl implements AttachClientShape {
  readonly client: string
  #socket: Bun.Socket<undefined>
  #buffer = ""
  #closed = false
  #heartbeat: Timer | null = null
  /** Outstanding round trips, called with false when the attachment ends
   *  instead of being left pending forever. */
  #pongs = new Map<string, Deferred.Deferred<boolean>>()
  #queued = new Map<string, Queue.Queue<AttachFrame>>()

  /**
   * The attachment ended: the socket closed, the daemon went away, or the
   * connection errored. Every session is still whatever it was — this says
   * nothing about the processes, only about our view of them.
   */
  onClose?: (error: Error | null) => void
  /** An out-of-band error frame from the daemon, outside any one session. */
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
  static connect(options: AttachClientOptions): Promise<AttachClientImpl> {
    return new Promise<AttachClientImpl>((resolve, reject) => {
      let attached: AttachClientImpl | null = null
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
            attached = new AttachClientImpl(options.client, socket)
            const pong = Effect.runSync(Deferred.make<boolean>())
            attached.#pongs.set(nonce, pong)
            void Effect.runPromise(Deferred.await(pong).pipe(Effect.timeout(HELLO_TIMEOUT_MS), Effect.orElseSucceed(() => false))).then((answered) => {
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

  /** A bounded stream is created before the RPC spawn, so no output can race
   *  subscription. The queue is the pre-subscribe buffer, not a second cache. */
  stream(session: string): Stream.Stream<AttachFrame> {
    let queue = this.#queued.get(session)
    if (!queue) {
      queue = Effect.runSync(Queue.sliding<AttachFrame>(QUEUE_LIMIT))
      this.#queued.set(session, queue)
    }
    return Stream.fromQueue(queue).pipe(
      Stream.tap((frame) => frame._tag === "exit"
        ? Effect.sync(() => {
            // The exit is taken before this runs, so every preceding output is
            // already safe to release. Keep the identity check: a later stream
            // may have installed a replacement queue while this one was ending.
            if (this.#queued.get(session) !== queue) return
            this.#queued.delete(session)
            Effect.runFork(Queue.shutdown(queue!))
          })
        : Effect.void),
    )
  }

  input(session: string, data: string | Uint8Array): void {
    this.#send({
      _tag: "input",
      session,
      data: typeof data === "string" ? new TextEncoder().encode(data) : data,
    })
  }

  resize(session: string, cols: number, rows: number): void {
    this.#send({ _tag: "resize", session, cols, rows })
  }

  /**
   * Ask the daemon to replay this session's current screen to us, ahead of its
   * live output. Sent when adopting a session whose process is already running;
   * without it the pane would be blank until the program next redraws.
   */
  sync(session: string): void {
    this.#send({ _tag: "sync", session })
  }

  /** Round-trip the daemon. Resolves false if the attachment ends first. */
  ping(timeoutMs = 5_000): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false)
    const nonce = `ping-${Math.random().toString(36).slice(2)}`
    const pong = Effect.runSync(Deferred.make<boolean>())
    this.#pongs.set(nonce, pong)
    this.#send({ _tag: "ping", nonce })
    return Effect.runPromise(Deferred.await(pong).pipe(Effect.timeout(timeoutMs), Effect.orElseSucceed(() => false))).finally(() => this.#pongs.delete(nonce))
  }

  /** Detach. The daemon sees EOF and releases the attachment; the sessions
   *  keep running, which is the entire point of there being a daemon. */
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
      const pong = this.#pongs.get(frame.nonce)
      if (pong) Effect.runSync(Deferred.succeed(pong, true))
      this.#pongs.delete(frame.nonce)
      return
    }
    if (frame._tag === "error") {
      this.onError?.(frame.message)
      return
    }
    if (frame._tag !== "output" && frame._tag !== "exit") return

    const queue = this.#queued.get(frame.session) ?? Effect.runSync(Queue.sliding<AttachFrame>(QUEUE_LIMIT))
    // Output and exit share one queue so replay keeps their order: an exit
    // delivered ahead of the bytes that preceded it would blank a pane and
    // then write to it.
    void Effect.runPromise(Queue.offer(queue, frame))
    this.#queued.set(frame.session, queue)
  }

  #finish(error: Error | null): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
    for (const pong of this.#pongs.values()) Effect.runSync(Deferred.succeed(pong, false))
    this.#pongs.clear()
    for (const queue of this.#queued.values()) Effect.runFork(Queue.shutdown(queue))
    this.#queued.clear()
    this.onClose?.(error)
  }
}

/** Scoped service wrapper. The socket is acquired and released with the layer,
 * so a client cannot outlive the scope that owns its attachment. */
export class AttachClient extends Effect.Service<AttachClientShape>()("AttachClient", {
  scoped: (options: AttachClientOptions) => Effect.acquireRelease(
    Effect.tryPromise({
      try: () => AttachClientImpl.connect(options),
      catch: (error) => new AttachError(String(error)),
    }),
    (client) => Effect.sync(() => client.close()),
  ),
}) {
  static layer(options: AttachClientOptions) {
    return Layer.scoped(AttachClient, Effect.acquireRelease(
      Effect.tryPromise({ try: () => AttachClientImpl.connect(options), catch: (error) => new AttachError(String(error)) }),
      (client) => Effect.sync(() => client.close()),
    ))
  }

  /** Promise adapter used by the SessionClient constructor. New callers should
   * provide `AttachClient.layer` over the whole use span. */
  static connect(options: AttachClientOptions): Promise<AttachClientShape> {
    return AttachClientImpl.connect(options)
  }
}
