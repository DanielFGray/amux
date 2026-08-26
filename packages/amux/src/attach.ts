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
  AttachFrameAccumulator,
  AttachFrameTags,
  decodeAttachFrames,
  encodeAttachFrameBytes,
  type AttachFrame,
  type JsonValue,
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

/** Frames handled outside session streams never enter those streams. */
const EXCLUDED_SESSION_FRAME_TAGS: Set<AttachFrame["_tag"]> = new Set([
  "hello",
  "input",
  "resize",
  "sync",
  "agent.event",
  "agent.prompt",
  // Client -> daemon -> worker stdin only; the daemon never emits it here.
  "agent.interrupt",
  "agent.permission",
  "error",
  "ping",
  "pong",
  "workspace",
]);

const isDeliverableFrame = (
  frame: AttachFrame,
): frame is Extract<AttachFrame, { readonly session: string }> => {
  if (!AttachFrameTags.has(frame._tag) || EXCLUDED_SESSION_FRAME_TAGS.has(frame._tag)) return false;
  return "session" in frame && typeof frame.session === "string";
};

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

export interface AttachClientContract {
  readonly client: string;
  readonly closed: boolean;
  stream(session: string): Stream.Stream<AttachFrame, never, never>;
  /** Ordered daemon model generations, independent of terminal streams. */
  workspace(): Stream.Stream<WorkspaceSnapshot, never, never>;
  /** Plugin verbs the daemon is asking this client to run — see `respondCommand`. */
  commandRequests(): Stream.Stream<{ readonly id: string; readonly command: JsonValue }, never, never>;
  respondCommand(id: string, result?: JsonValue, error?: string): void;
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
 * {@link AttachClientContract} plus the internal `_`-prefixed methods that the
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
  private readonly _recvBuffer = new AttachFrameAccumulator();
  private readonly _runtime: Runtime.Runtime<never>;
  private _handshake: { nonce: string; accept: () => void } | null;
  private readonly _closedSignal: Deferred.Deferred<void>;
  private _releaseScope: (() => void) | null = null;
  private readonly _pongs = new Map<string, Deferred.Deferred<boolean>>();
  /**
   * A session's frames, fanned out to everyone watching it.
   *
   * One queue per subscriber, not one queue per session: taking from a queue
   * consumes the item, so subscribers sharing one would split the stream
   * between them rather than each see all of it — a pane's transcript and the
   * backend's status watch would get alternate halves of the same answer.
   *
   * `backlog` holds what arrives while nobody is watching, because a client
   * asks for a session's history before it subscribes and the replay must wait
   * rather than be dropped. The first subscriber drains it and from then on
   * every frame goes straight to every queue.
   */
  private readonly _queued = new Map<
    string,
    {
      readonly queues: Queue.Queue<AttachFrame>[];
      readonly backlog: AttachFrame[];
      terminal: boolean;
    }
  >();
  private readonly _workspaceQ: Queue.Queue<WorkspaceSnapshot>;
  private readonly _commandQ: Queue.Queue<{ readonly id: string; readonly command: JsonValue }>;
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
    this._commandQ = Effect.runSync(
      Queue.unbounded<{ readonly id: string; readonly command: JsonValue }>(),
    );
    this._writer = createSocketWriter(socket, () => {
      this._finish(new AttachError({ message: "attach client is too slow" }));
      socket.end();
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  stream(session: string): Stream.Stream<AttachFrame, never, never> {
    return Stream.unwrap(
      Effect.gen(this, function* () {
        if (this._queued.get(session)?.terminal) this._queued.delete(session);
        const entry = this._entryFor(session);
        const queue = yield* Queue.bounded<AttachFrame>(QUEUE_LIMIT);
        // Only the first subscriber finds anything here, and it is that
        // subscriber's history — later ones join live and call sync() instead.
        for (const frame of entry.backlog.splice(0)) yield* Queue.offer(queue, frame);
        entry.queues.push(queue);
        return Stream.unfoldEffect(false, (done) => {
          if (done) return Effect.succeed(Option.none());
          return Queue.take(queue).pipe(
            Effect.map((frame) => Option.some([frame, frame._tag === "exit"] as const)),
          );
        }).pipe(
          Stream.ensuring(
            Effect.suspend(() => {
              const current = this._queued.get(session);
              const index = current?.queues.indexOf(queue) ?? -1;
              if (current && index !== -1) current.queues.splice(index, 1);
              if (current && current.terminal && current.queues.length === 0)
                this._queued.delete(session);
              return Queue.shutdown(queue);
            }),
          ),
        );
      }),
    );
  }

  private _entryFor(session: string) {
    const existing = this._queued.get(session);
    if (existing) return existing;
    const entry = { queues: [], backlog: [], terminal: false };
    this._queued.set(session, entry);
    return entry;
  }

  workspace(): Stream.Stream<WorkspaceSnapshot, never, never> {
    return Stream.fromQueue(this._workspaceQ);
  }

  /** Commands the daemon is asking this client to run — a plugin verb the
   *  daemon cannot execute itself. Each one wants a matching {@link respondCommand}. */
  commandRequests(): Stream.Stream<{ readonly id: string; readonly command: JsonValue }, never, never> {
    return Stream.fromQueue(this._commandQ);
  }

  respondCommand(id: string, result?: JsonValue, error?: string): void {
    const base = { _tag: "command.response" as const, id };
    this._send(error !== undefined ? { ...base, error } : result !== undefined ? { ...base, result } : base);
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
    const frame: Extract<AttachFrame, { readonly _tag: "sync" }> =
      after === undefined ? { _tag: "sync", session } : { _tag: "sync", session, after };
    this._send(frame);
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
    const beat = Effect.gen(this, function* () {
      this._send({ _tag: "ping", nonce: `beat-${yield* Clock.currentTimeMillis}` });
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
    let decoded;
    try {
      decoded = this._recvBuffer
        .push(chunk)
        .flatMap((frame) => decodeAttachFrames(new TextDecoder().decode(frame)).frames);
    } catch (error) {
      const protocolError =
        error instanceof AttachError ? error : new AttachError({ message: errorMessage(error) });
      onProtocolError(protocolError);
      this._finish(protocolError);
      this._socket.end();
      return;
    }
    for (const frame of decoded) this._route(frame);
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
    for (const { queues } of this._queued.values())
      for (const queue of queues) this._shutdownQueue(queue);
    this._shutdownQueue(this._workspaceQ);
    this._queued.clear();
    this._onClose?.(error);
    scope?.();
  }

  private _send(frame: AttachFrame): void {
    if (this._closed) return;
    this._writer.send(encodeAttachFrameBytes(frame));
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
    if (frame._tag === "command.request") {
      this._commandQ.unsafeOffer({ id: frame.id, command: frame.command });
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
    if (!isDeliverableFrame(frame)) return;

    // A frame after `exit` belongs to the next session of that name, so the
    // entry rotates. The old subscribers keep their own queues and close them
    // when their streams end — the queues are theirs, not the entry's.
    if (this._queued.get(frame.session)?.terminal) this._queued.delete(frame.session);
    const entry = this._entryFor(frame.session);

    // Every subscriber sees every frame; with none, the backlog stands in for
    // the one they will each be given a copy of.
    const overloaded =
      entry.queues.length === 0
        ? (entry.backlog.push(frame), entry.backlog.length > QUEUE_LIMIT)
        : entry.queues.map((queue) => queue.unsafeOffer(frame)).includes(false);
    if (overloaded) {
      this._finish(new AttachError({ message: "attach receive queue is overloaded" }));
      this._socket.end();
      return;
    }
    entry.terminal ||= frame._tag === "exit";
    if (frame._tag === "exit" && entry.queues.length === 0) this._queued.delete(frame.session);
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
                    new Uint8Array([
                      ...encodeAttachFrameBytes({ _tag: "hello", client: options.client }),
                      ...encodeAttachFrameBytes({ _tag: "ping", nonce }),
                    ]),
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
  static connect(options: AttachClientOptions): Promise<AttachClientContract> {
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
