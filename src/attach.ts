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
import { errorMessage } from "./error-message.ts";
import {
  Clock,
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
  Schema as S,
} from "effect";
import { createSocketWriter, type SocketWriter } from "./attach-write.ts";
import { parseWorkspaceJson, type WorkspaceSnapshot } from "./workspace.ts";

/**
 * Seconds between heartbeats.
 *
 * The server drops a client that has said nothing for its idle timeout (60s by
 * default), and an attached UI showing an idle session legitimately sends
 * nothing for hours. Comfortably under half the timeout, so a single lost ping
 * is not a disconnection.
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

export class AttachError extends S.TaggedError<AttachError>()("AttachError", {
  message: S.String,
}) {}

export interface AttachClientShape {
  readonly client: string;
  readonly closed: boolean;
  stream(session: string): Stream.Stream<AttachFrame>;
  /** Ordered daemon model generations, independent of terminal streams. */
  workspace(): Stream.Stream<WorkspaceSnapshot>;
  input(session: string, data: string | Uint8Array): void;
  resize(session: string, cols: number, rows: number): void;
  sync(session: string, after?: number): void;
  ping(timeoutMs?: number): Promise<boolean>;
  close(): void;
  onClose?: (error: Error | null) => void;
  onError?: (message: string) => void;
}

/**
 * Live transport state for one attachment.
 *
 * Owns the socket writer, receive buffer, handshake nonce, heartbeat pong
 * map, per-session output queues, and the workspace-event sliding queue.
 * Mutable state is private to the class; the public surface is
 * {@link AttachClientShape} plus the internal `_`-prefixed methods that the
 * Effect scope machinery calls during setup and teardown.
 *
 * `Effect.Service` cannot itself be the runtime instance because
 * `Effect.Service<T>()` produces a branded tag class whose constructor
 * expects a service key and identifier, not transport parameters. Two
 * objects that must be constructed differently cannot be the same class.
 * `AttachClientConnection` is the transport state class; the
 * `AttachClient` Effect.Service tag wraps it through the scoped factory.
 */
class AttachClientConnection {
  readonly _tag = "AttachClient" as const;
  readonly client: string;

  private _closed = false;
  private _recvBuffer = Buffer.alloc(0);
  private readonly _runtime: Runtime.Runtime<never>;
  private _handshake: { nonce: string; accept: () => void } | null;
  private readonly _closedSignal: Deferred.Deferred<void>;
  private _releaseScope: (() => void) | null = null;
  private readonly _pongs = new Map<string, Deferred.Deferred<boolean>>();
  private readonly _queued = new Map<
    string,
    { queue: Queue.Queue<AttachFrame>; active: number; terminal: boolean }
  >();
  private readonly _workspaceQ: Queue.Queue<WorkspaceSnapshot>;
  private _onClose: ((error: Error | null) => void) | undefined;
  private _onError: ((message: string) => void) | undefined;
  private readonly _socket: Bun.Socket<undefined>;
  readonly _writer: SocketWriter;
  private readonly _textEncoder = new TextEncoder();

  constructor(
    client: string,
    socket: Bun.Socket<undefined>,
    runtime: Runtime.Runtime<never>,
    handshake: { nonce: string; accept: () => void },
  ) {
    this.client = client;
    this._socket = socket;
    this._runtime = runtime;
    this._handshake = handshake;
    this._closedSignal = Effect.runSync(Deferred.make<void>());
    this._workspaceQ = Effect.runSync(Queue.sliding<WorkspaceSnapshot>(1));
    this._writer = createSocketWriter(socket, () => {
      this._finish(new AttachError({ message: "attach client is too slow" }));
      socket.end();
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  stream(session: string): Stream.Stream<AttachFrame> {
    const self = this;
    return Stream.unwrap(
      Effect.gen(function* () {
        let entry = self._queued.get(session);
        if (!entry || entry.terminal) {
          if (entry?.terminal) yield* Queue.shutdown(entry.queue);
          entry = {
            queue: yield* Queue.bounded<AttachFrame>(QUEUE_LIMIT),
            active: 0,
            terminal: false,
          };
          self._queued.set(session, entry);
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
              const current = self._queued.get(session);
              if (current?.queue !== queue) {
                return Queue.shutdown(queue);
              }
              current.active -= 1;
              if (current.terminal && current.active === 0) {
                self._queued.delete(session);
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
    return Stream.fromQueue(this._workspaceQ);
  }

  input(session: string, data: string | Uint8Array): void {
    this._send({
      _tag: "input",
      session,
      data: typeof data === "string" ? this._textEncoder.encode(data) : data,
    });
  }

  resize(session: string, cols: number, rows: number): void {
    this._send({ _tag: "resize", session, cols, rows });
  }

  sync(session: string, after?: number): void {
    this._send({ _tag: "sync", session, ...(after === undefined ? {} : { after }) });
  }

  ping(timeoutMs = 5_000): Promise<boolean> {
    if (this._closed) return Promise.resolve(false);
    const nonce = `ping-${Math.random().toString(36).slice(2)}`;
    const pong = Effect.runSync(Deferred.make<boolean>());
    this._pongs.set(nonce, pong);
    this._send({ _tag: "ping", nonce });
    return Effect.runPromise(
      Deferred.await(pong).pipe(
        Effect.timeout(timeoutMs),
        Effect.orElseSucceed(() => false),
      ),
    ).finally(() => this._pongs.delete(nonce));
  }

  close(): void {
    if (this._closed) return;
    this._socket.end();
    this._finish(null);
  }

  set onClose(value: ((error: Error | null) => void) | undefined) {
    this._onClose = value;
  }
  get onClose(): ((error: Error | null) => void) | undefined {
    return this._onClose;
  }

  set onError(value: ((message: string) => void) | undefined) {
    this._onError = value;
  }
  get onError(): ((message: string) => void) | undefined {
    return this._onError;
  }

  _heartbeatEffect(seconds: number): Effect.Effect<void> {
    const self = this;
    const beat = Effect.gen(function* () {
      self._send({ _tag: "ping", nonce: `beat-${yield* Clock.currentTimeMillis}` });
    });
    return beat.pipe(
      Effect.repeat(Schedule.spaced(`${seconds} seconds`)),
      Effect.delay(`${seconds} seconds`),
      Effect.raceFirst(Deferred.await(this._closedSignal)),
      Effect.asVoid,
    );
  }

  _setScopeRelease(release: () => void): void {
    if (this._closed) release();
    else this._releaseScope = release;
  }

  _receive(chunk: Buffer, onProtocolError: (error: Error) => void): void {
    this._recvBuffer = Buffer.concat([this._recvBuffer, chunk]);
    const lastNewline = this._recvBuffer.lastIndexOf(0x0a);
    if (lastNewline === -1) return;
    const complete = this._recvBuffer.subarray(0, lastNewline + 1);
    this._recvBuffer = this._recvBuffer.subarray(lastNewline + 1);
    let decoded;
    try {
      decoded = decodeAttachFrames(complete.toString("utf8"));
    } catch (error) {
      const protocolError =
        error instanceof AttachError ? error : new AttachError({ message: errorMessage(error) });
      onProtocolError(protocolError);
      this._finish(protocolError);
      this._socket.end();
      return;
    }
    for (const frame of decoded.frames) this._route(frame);
  }

  private _finish(error: Error | null): void {
    if (this._closed) return;
    this._closed = true;
    const scope = this._releaseScope;
    this._releaseScope = null;
    this._handshake = null;
    this._writer.close();
    Effect.runSync(Deferred.succeed(this._closedSignal, undefined));
    for (const pong of this._pongs.values()) Effect.runSync(Deferred.succeed(pong, false));
    this._pongs.clear();
    for (const { queue } of this._queued.values()) this._shutdownQueue(queue);
    this._shutdownQueue(this._workspaceQ);
    this._queued.clear();
    this._onClose?.(error);
    scope?.();
  }

  private _send(frame: AttachFrame): void {
    if (this._closed) return;
    this._writer.send(this._textEncoder.encode(encodeAttachFrame(frame)));
  }

  private _route(frame: AttachFrame): void {
    if (frame._tag === "pong") {
      if (this._handshake?.nonce === frame.nonce) {
        const accept = this._handshake.accept;
        this._handshake = null;
        accept();
        return;
      }
      const pong = this._pongs.get(frame.nonce);
      if (pong) Effect.runSync(Deferred.succeed(pong, true));
      this._pongs.delete(frame.nonce);
      return;
    }
    if (frame._tag === "error") {
      this._onError?.(frame.message);
      return;
    }
    if (frame._tag === "workspace") {
      try {
        const workspace = Effect.runSync(parseWorkspaceJson(frame.state));
        if (workspace.revision !== frame.revision)
          throw new AttachError({ message: "workspace revision does not match frame" });
        this._workspaceQ.unsafeOffer(workspace);
      } catch (error) {
        this._finish(
          error instanceof AttachError ? error : new AttachError({ message: errorMessage(error) }),
        );
        this._socket.end();
      }
      return;
    }
    if (
      frame._tag !== "output" &&
      frame._tag !== "exit" &&
      frame._tag !== "foreground" &&
      frame._tag !== "turn.start" &&
      frame._tag !== "text.delta" &&
      frame._tag !== "tool.start" &&
      frame._tag !== "tool.params-start" &&
      frame._tag !== "tool.params-delta" &&
      frame._tag !== "tool.params-end" &&
      frame._tag !== "tool.result" &&
      frame._tag !== "permission.request" &&
      frame._tag !== "permission.response" &&
      frame._tag !== "agent.status" &&
      frame._tag !== "turn.end" &&
      frame._tag !== "agent.steer" &&
      frame._tag !== "agent.interrupt"
    )
      return;

    let entry = this._queued.get(frame.session);
    if (entry?.terminal) {
      if (entry.active === 0) this._shutdownQueue(entry.queue);
      entry = {
        queue: Effect.runSync(Queue.bounded<AttachFrame>(QUEUE_LIMIT)),
        active: 0,
        terminal: false,
      };
      this._queued.set(frame.session, entry);
    }
    if (!entry) {
      entry = {
        queue: Effect.runSync(Queue.bounded<AttachFrame>(QUEUE_LIMIT)),
        active: 0,
        terminal: false,
      };
      this._queued.set(frame.session, entry);
    }
    const queue = entry.queue;
    if (!queue.unsafeOffer(frame)) {
      this._finish(new AttachError({ message: "attach receive queue is overloaded" }));
      this._socket.end();
      return;
    }
    entry.terminal ||= frame._tag === "exit";
    if (frame._tag === "exit") {
      if (entry.active === 0) {
        this._queued.delete(frame.session);
        this._shutdownQueue(queue);
      }
    }
  }

  private _shutdownQueue<A>(queue: Queue.Queue<A>): void {
    Runtime.runSync(this._runtime)(Queue.shutdown(queue));
  }
}

/**
 * Creates a scoped attachment. The returned object lives as long as its scope:
 * the socket, handshake, heartbeat, and event routing are all children of the
 * Effect scope returned by the factory.
 *
 * Acceptance is proven by a pong rather than by an ack frame the protocol
 * does not have: the server answers a ping only after a hello has been
 * accepted, and refuses one before it with an error and a hang-up. So a round
 * trip is exactly the acknowledgement we need, and it costs one frame that
 * the heartbeat would have sent anyway.
 */
const makeScoped = (
  options: AttachClientOptions,
): Effect.Effect<AttachClientConnection, AttachError, Scope.Scope> => {
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  return Effect.gen(function* () {
    const rng = yield* Effect.random;
    const n = yield* rng.next;
    const nonce = `hello-${n.toString(36).slice(2)}`;
    return yield* Effect.runtime<never>().pipe(
      Effect.flatMap((runtime) => {
        const acquire = Effect.async<AttachClientConnection, AttachError>((resume) => {
          let attached: AttachClientConnection | null = null;
          let socketRef: Bun.Socket<undefined> | null = null;
          let settled = false;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            if (attached) attached.close();
            socketRef?.end();
            resume(
              Effect.fail(
                S.is(AttachError)(error)
                  ? error
                  : new AttachError({ message: errorMessage(error) }),
              ),
            );
          };

          void Bun.connect<undefined>({
            unix: options.path,
            socket: {
              binaryType: "buffer",
              open(socket) {
                socketRef = socket;
                if (settled) {
                  socket.end();
                  return;
                }
                attached = new AttachClientConnection(options.client, socket, runtime, {
                  nonce,
                  accept: () => {
                    if (settled) return;
                    settled = true;
                    resume(Effect.succeed(attached!));
                  },
                });
                if (
                  !attached._writer.send(
                    new TextEncoder().encode(
                      encodeAttachFrame({ _tag: "hello", client: options.client }) +
                        encodeAttachFrame({ _tag: "ping", nonce }),
                    ),
                  )
                )
                  fail(new AttachError({ message: "attach handshake could not write" }));
              },
              data(_socket, data) {
                if (attached) attached._receive(data, fail);
              },
              close() {
                if (!settled)
                  fail(
                    new AttachError({
                      message: "daemon closed the attachment before accepting it",
                    }),
                  );
                else if (attached) attached.close();
              },
              error(_socket, error) {
                if (!settled) fail(error);
                else if (attached) attached.close();
              },
              drain() {
                if (attached) attached._writer.drain();
              },
            },
          }).catch(fail);

          return Effect.sync(() => {
            if (settled) return;
            settled = true;
            if (attached) attached.close();
            socketRef?.end();
          });
        }).pipe(
          Effect.timeoutFail({
            duration: helloTimeoutMs,
            onTimeout: () => new AttachError({ message: `attach to ${options.path} timed out` }),
          }),
        );

        let acquired: AttachClientConnection | null = null;
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
            client._heartbeatEffect(options.pingSeconds ?? PING_SECONDS).pipe(Effect.forkScoped),
          ),
        );
      }),
    );
  });
};

/** Effect.Service tag. The scoped factory creates
 *  {@link AttachClientConnection} instances that own the socket and transport
 *  state. The socket is acquired and released with the layer, so a client
 *  cannot outlive the scope that owns its attachment. */
export class AttachClient extends Effect.Service<AttachClient>()("AttachClient", {
  scoped: (options: AttachClientOptions) => makeScoped(options),
}) {
  static layer(options: AttachClientOptions) {
    return Layer.scoped(AttachClient, makeScoped(options));
  }

  /** Promise adapter used by the SessionClient constructor. New callers should
   *  provide `AttachClient.layer` over the whole use span. */
  static connect(options: AttachClientOptions): Promise<AttachClientShape> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const client = yield* makeScoped(options).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        );
        const runtime = yield* Effect.runtime<never>();
        client._setScopeRelease(() => {
          void Runtime.runPromise(runtime)(Scope.close(scope, Exit.void));
        });
        return client;
      }),
    );
  }
}
