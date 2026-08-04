/**
 * The client end of the daemon's attach stream.
 *
 * The daemon owns the PTYs; this is how a UI process borrows them. One socket
 * carries every session's bytes in both directions, tagged by session id, so
 * the number of attached sessions costs no extra file descriptors and their
 * frames stay in a single order.
 *
 * Socket callbacks remain imperative so Bun can deliver frames in their
 * original order. Effect owns the connection lifetime around them: handshake
 * timeout, heartbeat, and release are all children of one connection scope.
 */

import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./effect/AttachProtocol.ts";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Runtime,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { createSocketWriter, type SocketWriter } from "./attach-write.ts";
import { parseWorkspace, type WorkspaceSnapshot } from "./workspace.ts";

/**
 * Seconds between heartbeats.
 *
 * The server drops a client that has said nothing for its idle timeout (60s by
 * default), and an attached UI showing an idle session legitimately sends
 * nothing
 * for hours. Comfortably under half the timeout, so a single lost ping is not a
 * disconnection.
 */
const PING_SECONDS = 20;

/** How long `connect` waits for the hello to be accepted or refused. */
const HELLO_TIMEOUT_MS = 5_000;

/**
 * Frames held for a session nobody has subscribed to yet, per session.
 *
 * Spawning is two steps — ask the daemon over RPC, then subscribe here — and
 * the process starts writing between them. Without this, the first line of
 * every session's output would be dropped exactly when it matters most (a
 * shell prompt, a banner). Bounded because a session that is never subscribed
 * to is a leak otherwise. If the limit is reached, the attachment closes
 * rather than silently losing terminal bytes; a later attachment can request
 * a fresh screen with sync.
 */
const QUEUE_LIMIT = 256;

export interface AttachClientOptions {
  /** Unix socket path — SessionPaths.attach. */
  path: string;
  /** Stable identity for this client. Reconnecting under the same id is a
   *  reconnect rather than a conflict; see SessionDaemon's claim rule. */
  client: string;
  pingSeconds?: number;
  /** Override the handshake deadline for deterministic callers and tests. */
  helloTimeoutMs?: number;
}

export class AttachError extends Error {}

export interface AttachClientShape {
  readonly client: string;
  readonly closed: boolean;
  stream(session: string): Stream.Stream<AttachFrame>;
  /** Ordered daemon model generations, independent of terminal streams. */
  workspace(): Stream.Stream<WorkspaceSnapshot>;
  input(session: string, data: string | Uint8Array): void;
  resize(session: string, cols: number, rows: number): void;
  sync(session: string): void;
  ping(timeoutMs?: number): Promise<boolean>;
  close(): void;
  onClose?: (error: Error | null) => void;
  onError?: (message: string) => void;
}

class AttachClientImpl implements AttachClientShape {
  readonly client: string;
  #socket: Bun.Socket<undefined>;
  #runtime: Runtime.Runtime<never>;
  #writer: SocketWriter;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #closedSignal = Effect.runSync(Deferred.make<void>());
  #releaseScope: (() => void) | null = null;
  #handshake: { nonce: string; accept: () => void } | null;
  /** Outstanding round trips, called with false when the attachment ends
   *  instead of being left pending forever. */
  #pongs = new Map<string, Deferred.Deferred<boolean>>();
  #queued = new Map<
    string,
    { queue: Queue.Queue<AttachFrame>; active: number; terminal: boolean }
  >();
  // Workspace generations are snapshots, so an unconsumed client only needs
  // the newest one. Terminal/session queues remain lossless and bounded.
  #workspace = Effect.runSync(Queue.sliding<WorkspaceSnapshot>(1));

  /**
   * The attachment ended: the socket closed, the daemon went away, or the
   * connection errored. Every session is still whatever it was — this says
   * nothing about the processes, only about our view of them.
   */
  onClose?: (error: Error | null) => void;
  /** An out-of-band error frame from the daemon, outside any one session. */
  onError?: (message: string) => void;

  private constructor(
    client: string,
    socket: Bun.Socket<undefined>,
    runtime: Runtime.Runtime<never>,
    handshake: { nonce: string; accept: () => void },
  ) {
    this.client = client;
    this.#socket = socket;
    this.#runtime = runtime;
    this.#handshake = handshake;
    this.#writer = createSocketWriter(socket, () => {
      this.#finish(new AttachError("attach client is too slow"));
      socket.end();
    });
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
  static scoped(
    options: AttachClientOptions,
  ): Effect.Effect<AttachClientImpl, AttachError, Scope.Scope> {
    const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    return Effect.runtime<never>().pipe(
      Effect.flatMap((runtime) => {
        const acquire = Effect.async<AttachClientImpl, AttachError>((resume) => {
          let attached: AttachClientImpl | null = null;
          let socketRef: Bun.Socket<undefined> | null = null;
          let settled = false;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            if (attached) attached.#finish(error);
            socketRef?.end();
            resume(
              Effect.fail(error instanceof AttachError ? error : new AttachError(String(error))),
            );
          };

          void Bun.connect<undefined>({
            unix: options.path,
            socket: {
              binaryType: "buffer",
              open(socket) {
                socketRef = socket;
                // Bun can deliver open after the promise has already timed out.
                // Do not let that late transport become an unattached daemon claim.
                if (settled) {
                  socket.end();
                  return;
                }
                // Hello and the probing ping in one write: the server decodes every
                // complete frame in a read, so batching them saves a round trip and
                // exercises the same path a real client's first keystrokes take.
                const nonce = `hello-${Math.random().toString(36).slice(2)}`;
                attached = new AttachClientImpl(options.client, socket, runtime, {
                  nonce,
                  accept: () => {
                    if (settled) return;
                    settled = true;
                    resume(Effect.succeed(attached!));
                  },
                });
                if (
                  !attached.#writer.send(
                    new TextEncoder().encode(
                      encodeAttachFrame({ _tag: "hello", client: options.client }) +
                        encodeAttachFrame({ _tag: "ping", nonce }),
                    ),
                  )
                )
                  fail(new AttachError("attach handshake could not write"));
              },
              data(_socket, data) {
                if (attached) attached.#receive(data, fail);
              },
              close() {
                if (!settled)
                  fail(new AttachError("daemon closed the attachment before accepting it"));
                else if (attached) attached.#finish(null);
              },
              error(_socket, error) {
                if (!settled) fail(error);
                else if (attached) attached.#finish(error);
              },
              drain() {
                if (attached) attached.#writer.drain();
              },
            },
          }).catch(fail);

          return Effect.sync(() => {
            if (settled) return;
            settled = true;
            if (attached) attached.#finish(new AttachError("attach handshake interrupted"));
            socketRef?.end();
          });
        }).pipe(
          Effect.timeoutFail({
            duration: helloTimeoutMs,
            onTimeout: () => new AttachError(`attach to ${options.path} timed out`),
          }),
        );

        // A handshake is allowed to time out; ordinary acquireRelease masks
        // interruption during acquisition and would therefore mask this deadline.
        let acquired: AttachClientImpl | null = null;
        return Effect.acquireReleaseInterruptible(
          acquire.pipe(
            Effect.tap((client) =>
              Effect.sync(() => {
                acquired = client;
              }),
            ),
          ),
          () => Effect.sync(() => acquired?.close()),
        ).pipe(
          Effect.tap((client) =>
            client.#heartbeatEffect(options.pingSeconds ?? PING_SECONDS).pipe(Effect.forkScoped),
          ),
        );
      }),
    );
  }

  static connect(options: AttachClientOptions): Promise<AttachClientImpl> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const client = yield* AttachClientImpl.scoped(options).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        );
        client.#setScopeRelease(() => {
          void Effect.runPromise(Scope.close(scope, Exit.void));
        });
        return client;
      }),
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Select and claim a queue when the stream is acquired, not when the Stream
   *  value is constructed. An unused Stream therefore has no lifecycle claim. */
  stream(session: string): Stream.Stream<AttachFrame> {
    return Stream.unwrap(
      Effect.gen(this, function* () {
        let entry = this.#queued.get(session);
        if (!entry || entry.terminal) {
          if (entry?.terminal) yield* Queue.shutdown(entry.queue);
          entry = {
            queue: Effect.runSync(Queue.bounded<AttachFrame>(QUEUE_LIMIT)),
            active: 0,
            terminal: false,
          };
          this.#queued.set(session, entry);
        }
        entry.active += 1;
        const queue = entry.queue;
        return Stream.unfoldEffect(false, (done) => {
          if (done) return Effect.succeed(Option.none());
          return Queue.take(queue).pipe(
            Effect.map((frame) => Option.some([frame, frame._tag === "exit"] as const)),
          );
        }).pipe(
          Stream.ensuring(
            Effect.suspend(() => {
              const current = this.#queued.get(session);
              if (current?.queue !== queue) {
                return Queue.shutdown(queue);
              }
              current.active -= 1;
              if (current.terminal && current.active === 0) {
                this.#queued.delete(session);
                return Queue.shutdown(queue);
              }
              return Effect.void;
            }),
          ),
        );
      }),
    );
  }

  workspace(): Stream.Stream<WorkspaceSnapshot> {
    return Stream.fromQueue(this.#workspace);
  }

  input(session: string, data: string | Uint8Array): void {
    this.#send({
      _tag: "input",
      session,
      data: typeof data === "string" ? new TextEncoder().encode(data) : data,
    });
  }

  resize(session: string, cols: number, rows: number): void {
    this.#send({ _tag: "resize", session, cols, rows });
  }

  /**
   * Ask the daemon to replay this session's current screen to us, ahead of its
   * live output. Sent when adopting a session whose process is already running;
   * without it the pane would be blank until the program next redraws.
   */
  sync(session: string): void {
    this.#send({ _tag: "sync", session });
  }

  /** Round-trip the daemon. Resolves false if the attachment ends first. */
  ping(timeoutMs = 5_000): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    const nonce = `ping-${Math.random().toString(36).slice(2)}`;
    const pong = Effect.runSync(Deferred.make<boolean>());
    this.#pongs.set(nonce, pong);
    this.#send({ _tag: "ping", nonce });
    return Effect.runPromise(
      Deferred.await(pong).pipe(
        Effect.timeout(timeoutMs),
        Effect.orElseSucceed(() => false),
      ),
    ).finally(() => this.#pongs.delete(nonce));
  }

  /** Detach. The daemon sees EOF and releases the attachment; the sessions
   *  keep running, which is the entire point of there being a daemon. */
  close(): void {
    if (this.#closed) return;
    this.#socket.end();
    this.#finish(null);
  }

  #send(frame: AttachFrame): void {
    if (this.#closed) return;
    this.#writer.send(new TextEncoder().encode(encodeAttachFrame(frame)));
  }

  #heartbeatEffect(seconds: number): Effect.Effect<void> {
    const beat = Effect.sync(() => this.#send({ _tag: "ping", nonce: `beat-${Date.now()}` }));
    return beat.pipe(
      Effect.repeat(Schedule.spaced(`${seconds} seconds`)),
      Effect.delay(`${seconds} seconds`),
      Effect.raceFirst(Deferred.await(this.#closedSignal)),
      Effect.asVoid,
    );
  }

  #setScopeRelease(release: () => void): void {
    if (this.#closed) release();
    else this.#releaseScope = release;
  }

  #receive(chunk: Buffer, onProtocolError: (error: Error) => void): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const lastNewline = this.#buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) return;
    const complete = this.#buffer.subarray(0, lastNewline + 1);
    this.#buffer = this.#buffer.subarray(lastNewline + 1);
    let decoded;
    try {
      decoded = decodeAttachFrames(complete.toString("utf8"));
    } catch (error) {
      // A frame we cannot parse means the two ends disagree about the wire
      // format; continuing would silently act on a guess.
      const protocolError = error instanceof Error ? error : new AttachError(String(error));
      onProtocolError(protocolError);
      this.#finish(protocolError);
      this.#socket.end();
      return;
    }
    for (const frame of decoded.frames) this.#route(frame);
  }

  #route(frame: AttachFrame): void {
    if (frame._tag === "pong") {
      if (this.#handshake?.nonce === frame.nonce) {
        const accept = this.#handshake.accept;
        this.#handshake = null;
        accept();
        return;
      }
      const pong = this.#pongs.get(frame.nonce);
      if (pong) Effect.runSync(Deferred.succeed(pong, true));
      this.#pongs.delete(frame.nonce);
      return;
    }
    if (frame._tag === "error") {
      this.onError?.(frame.message);
      return;
    }
    if (frame._tag === "workspace") {
      try {
        const workspace = parseWorkspace(JSON.parse(frame.state));
        if (workspace.revision !== frame.revision)
          throw new AttachError("workspace revision does not match frame");
        this.#workspace.unsafeOffer(workspace);
      } catch (error) {
        this.#finish(error instanceof Error ? error : new AttachError(String(error)));
        this.#socket.end();
      }
      return;
    }
    if (frame._tag !== "output" && frame._tag !== "exit" && frame._tag !== "foreground") return;

    let entry = this.#queued.get(frame.session);
    // Exit closes a generation. The first later frame starts a new one even
    // when replacement stream() has not been called yet.
    if (entry?.terminal) {
      if (entry.active === 0) this.#shutdownQueue(entry.queue);
      entry = {
        queue: Effect.runSync(Queue.bounded<AttachFrame>(QUEUE_LIMIT)),
        active: 0,
        terminal: false,
      };
      this.#queued.set(frame.session, entry);
    }
    if (!entry) {
      entry = {
        queue: Effect.runSync(Queue.bounded<AttachFrame>(QUEUE_LIMIT)),
        active: 0,
        terminal: false,
      };
      this.#queued.set(frame.session, entry);
    }
    const queue = entry.queue;
    // Output and exit share one queue so replay keeps their order. Never slide
    // terminal frames: an overflow invalidates this attachment and reattach
    // will obtain a fresh screen through sync.
    if (!queue.unsafeOffer(frame)) {
      this.#finish(new AttachError("attach receive queue is overloaded"));
      this.#socket.end();
      return;
    }
    entry.terminal ||= frame._tag === "exit";
    if (frame._tag === "exit") {
      // An acquired stream must drain output and exit. An unclaimed terminal
      // generation has no consumer and must not retain stale exit state.
      if (entry.active === 0) {
        this.#queued.delete(frame.session);
        this.#shutdownQueue(queue);
      }
    }
  }

  #finish(error: Error | null): void {
    if (this.#closed) return;
    this.#closed = true;
    const releaseScope = this.#releaseScope;
    this.#releaseScope = null;
    this.#handshake = null;
    this.#writer.close();
    Effect.runSync(Deferred.succeed(this.#closedSignal, undefined));
    for (const pong of this.#pongs.values()) Effect.runSync(Deferred.succeed(pong, false));
    this.#pongs.clear();
    for (const { queue } of this.#queued.values()) this.#shutdownQueue(queue);
    this.#shutdownQueue(this.#workspace);
    this.#queued.clear();
    this.onClose?.(error);
    releaseScope?.();
  }

  #shutdownQueue<A>(queue: Queue.Queue<A>): void {
    Runtime.runSync(this.#runtime)(Queue.shutdown(queue));
  }
}

/** Scoped service wrapper. The socket is acquired and released with the layer,
 * so a client cannot outlive the scope that owns its attachment. */
export class AttachClient extends Effect.Service<AttachClientShape>()("AttachClient", {
  scoped: (options: AttachClientOptions) => AttachClientImpl.scoped(options),
}) {
  static layer(options: AttachClientOptions) {
    return Layer.scoped(AttachClient, AttachClientImpl.scoped(options));
  }

  /** Promise adapter used by the SessionClient constructor. New callers should
   * provide `AttachClient.layer` over the whole use span. */
  static connect(options: AttachClientOptions): Promise<AttachClientShape> {
    return AttachClientImpl.connect(options);
  }
}
