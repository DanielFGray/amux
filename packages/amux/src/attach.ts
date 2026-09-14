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
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Match,
  Queue,
  Random,
  Schedule,
  Scope,
  Stream,
  Schema as S,
} from "effect";
import { createSocketWriter, type SocketWriter } from "./attach-write.ts";
import {
  parseWorkspaceJson,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
} from "./workspace.ts";
import { captureRootRuntime, type RootRuntimeContext, defaultRootRuntime } from "./env.ts";

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
  // Worker -> daemon: the request to commit an event. Clients see the
  // committed `agent.message` the daemon publishes in its place.
  "agent.emit",
  // Client -> daemon -> worker stdin only; the daemon never emits it here.
  "session.message",
  "error",
  "ping",
  "pong",
  "workspace",
  "command.request",
  "command.response",
  "run.request",
  "run.response",
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
  readonly workspace: Stream.Stream<WorkspaceSnapshot, never, never>;
  /** Plugin verbs the daemon is asking this client to run — see `respondCommand`. */
  readonly commandRequests: Stream.Stream<
    {
      readonly id: string;
      readonly command: JsonValue;
      readonly source: "key" | "socket" | "cli";
      readonly pane?: string;
      readonly agent?: string;
    },
    never,
    never
  >;
  respondCommand(id: string, result?: JsonValue, error?: string): void;
  /** Ask the daemon to run one command on this attach connection. */
  runCommand(
    command: JsonValue,
    options?: {
      readonly expectedRevision?: number;
      readonly context?: WorkspaceCommandContext;
    },
  ): Effect.Effect<{ readonly result?: JsonValue; readonly workspace?: string }, AttachError>;
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
 * `Context.Service` cannot itself be the runtime instance because
 * `Context.Service<T>()` produces a branded tag class whose constructor
 * expects a service key and identifier, not transport parameters. Two
 * objects that must be constructed differently cannot be the same class.
 * `AttachClientConnection` is the transport state class; the
 * `AttachClient` service tag wraps it through the scoped factory.
 */
class AttachClientConnection {
  readonly _tag = "AttachClient" as const;
  readonly client: string;

  private _closed = false;
  private readonly _recvBuffer = new AttachFrameAccumulator();
  private readonly _runtime: RootRuntimeContext;
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
  private readonly _commandQ: Queue.Queue<{
    readonly id: string;
    readonly command: JsonValue;
    readonly source: "key" | "socket" | "cli";
    readonly pane?: string;
    readonly agent?: string;
  }>;
  private readonly _pendingRuns = new Map<
    string,
    Deferred.Deferred<{ readonly result?: JsonValue; readonly workspace?: string }, AttachError>
  >();
  private _onClose: ((error: Error | null) => void) | undefined;
  private _onError: ((message: string) => void) | undefined;
  private readonly _socket: Bun.Socket<undefined>;
  readonly _writer: SocketWriter;
  private readonly _textEncoder = new TextEncoder();

  constructor(
    client: string,
    socket: Bun.Socket<undefined>,
    runtime: RootRuntimeContext,
    handshake: { nonce: string; accept: () => void },
    queues: {
      readonly workspace: Queue.Queue<WorkspaceSnapshot>;
      readonly command: Queue.Queue<{
        readonly id: string;
        readonly command: JsonValue;
        readonly source: "key" | "socket" | "cli";
        readonly pane?: string;
        readonly agent?: string;
      }>;
    },
  ) {
    this.client = client;
    this._socket = socket;
    this._runtime = runtime;
    this._handshake = handshake;
    this._closedSignal = Deferred.makeUnsafe<void>();
    this._workspaceQ = queues.workspace;
    this._commandQ = queues.command;
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
      Effect.gen({ self: this }, function* () {
        if (this._queued.get(session)?.terminal) this._queued.delete(session);
        const entry = this._entryFor(session);
        const queue = yield* Queue.bounded<AttachFrame>(QUEUE_LIMIT);
        // Only the first subscriber finds anything here, and it is that
        // subscriber's history — later ones join live and call sync() instead.
        for (const frame of entry.backlog.splice(0)) yield* Queue.offer(queue, frame);
        entry.queues.push(queue);
        return Stream.unfold(false, (done) => {
          if (done) return Effect.as(Effect.void, undefined);
          return Queue.take(queue).pipe(
            Effect.map((frame) => [frame, frame._tag === "exit"] as const),
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

  get workspace(): Stream.Stream<WorkspaceSnapshot, never, never> {
    return Stream.fromQueue(this._workspaceQ);
  }

  /** Commands the daemon is asking this client to run — a plugin verb the
   *  daemon cannot execute itself. Each one wants a matching {@link respondCommand}. */
  get commandRequests(): Stream.Stream<
    {
      readonly id: string;
      readonly command: JsonValue;
      readonly source: "key" | "socket" | "cli";
      readonly pane?: string;
      readonly agent?: string;
    },
    never,
    never
  > {
    return Stream.fromQueue(this._commandQ);
  }

  respondCommand(id: string, result?: JsonValue, error?: string): void {
    const base = { _tag: "command.response" as const, id };
    this._send(
      error !== undefined ? { ...base, error } : result !== undefined ? { ...base, result } : base,
    );
  }

  runCommand(
    command: JsonValue,
    options?: {
      readonly expectedRevision?: number;
      readonly context?: WorkspaceCommandContext;
    },
  ): Effect.Effect<{ readonly result?: JsonValue; readonly workspace?: string }, AttachError> {
    return Effect.gen({ self: this }, function* () {
      if (this._closed) return yield* new AttachError({ message: "attach client is closed" });
      const id = `run-${(yield* Random.next).toString(36).slice(2)}`;
      const done = yield* Deferred.make<
        { readonly result?: JsonValue; readonly workspace?: string },
        AttachError
      >();
      this._pendingRuns.set(id, done);
      this._send({
        _tag: "run.request" as const,
        id,
        command,
        ...options,
      } as Extract<AttachFrame, { readonly _tag: "run.request" }>);
      return yield* Deferred.await(done).pipe(
        Effect.ensuring(Effect.sync(() => this._pendingRuns.delete(id))),
      );
    });
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
    // Random + await live in one Effect: ping is already a Promise boundary
    // (Bun/UI callers), so fold the nonce into that rather than runSync(Random).
    return Effect.runPromiseWith(this._runtime)(
      Effect.gen({ self: this }, function* () {
        const nonce = `ping-${(yield* Random.next).toString(36)}`;
        const pong = Deferred.makeUnsafe<boolean>();
        this._pongs.set(nonce, pong);
        this._send({ _tag: "ping", nonce });
        return yield* Deferred.await(pong).pipe(
          Effect.timeout(timeoutMs),
          Effect.orElseSucceed(() => false),
          Effect.ensuring(Effect.sync(() => this._pongs.delete(nonce))),
        );
      }),
    );
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
    const beat = Effect.gen({ self: this }, function* () {
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

  /**
   * The raw socket ended or errored without this connection asking it to.
   *
   * Distinct from the public `close()`, which a deliberate local release
   * (detach, scope teardown) calls with no error to report. Conflating the
   * two — as calling `close()` here once did — reports every unsolicited
   * daemon-side hangup as an unexplained, error-free disconnect: the app has
   * no way to tell "the user left" from "the transport broke" apart.
   */
  _remoteClosed(error?: Error): void {
    this._finish(error ?? new AttachError({ message: "the daemon closed the attachment socket" }));
  }

  _receive(chunk: Buffer, onProtocolError: (error: Error) => void): void {
    let decoded;
    try {
      decoded = this._recvBuffer
        .push(chunk)
        .flatMap((frame) => decodeAttachFrames(new TextDecoder().decode(frame)).frames);
    } catch (error) {
      const protocolError = S.is(AttachError)(error)
        ? error
        : new AttachError({ message: errorMessage(error) });
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
    Deferred.doneUnsafe(this._closedSignal, Effect.void);
    for (const pong of this._pongs.values()) Deferred.doneUnsafe(pong, Effect.succeed(false));
    this._pongs.clear();
    const closed = new AttachError({ message: "attach client is closed" });
    for (const pending of this._pendingRuns.values())
      Deferred.doneUnsafe(pending, Effect.fail(closed));
    this._pendingRuns.clear();
    for (const { queues } of this._queued.values())
      for (const queue of queues) this._shutdownQueue(queue);
    this._shutdownQueue(this._workspaceQ);
    this._shutdownQueue(this._commandQ);
    this._queued.clear();
    this._onClose?.(error);
    scope?.();
  }

  private _send(frame: AttachFrame): void {
    if (this._closed) return;
    this._writer.send(encodeAttachFrameBytes(frame));
  }

  private _route(frame: AttachFrame): void {
    Match.value(frame).pipe(
      Match.tag("pong", (frame) => {
        if (this._handshake?.nonce === frame.nonce) {
          const accept = this._handshake.accept;
          this._handshake = null;
          accept();
          return;
        }
        const pong = this._pongs.get(frame.nonce);
        if (pong) Deferred.doneUnsafe(pong, Effect.succeed(true));
        this._pongs.delete(frame.nonce);
      }),
      Match.tag("error", (frame) => {
        this._onError?.(frame.message);
      }),
      Match.tag("command.request", (frame) => {
        const request =
          frame.pane !== undefined && frame.agent !== undefined
            ? {
                id: frame.id,
                command: frame.command,
                source: frame.source,
                pane: frame.pane,
                agent: frame.agent,
              }
            : frame.pane !== undefined
              ? {
                  id: frame.id,
                  command: frame.command,
                  source: frame.source,
                  pane: frame.pane,
                }
              : frame.agent !== undefined
                ? {
                    id: frame.id,
                    command: frame.command,
                    source: frame.source,
                    agent: frame.agent,
                  }
                : { id: frame.id, command: frame.command, source: frame.source };
        Queue.offerUnsafe(this._commandQ, request);
      }),
      Match.tag("run.response", (frame) => {
        const pending = this._pendingRuns.get(frame.id);
        if (!pending) return;
        this._pendingRuns.delete(frame.id);
        const { _tag: _, id: __, error, ...output } = frame;
        if (error !== undefined) {
          Deferred.doneUnsafe(pending, Effect.fail(new AttachError({ message: error })));
          return;
        }
        Deferred.doneUnsafe(pending, Effect.succeed(output));
      }),
      Match.tag("workspace", (frame) => {
        try {
          // Bun socket `data` is synchronous and must keep frame order inside
          // one chunk — parseWorkspaceJson is Effect-only (schema + session
          // validation), so this is the one remaining sync boundary in attach.
          const workspace = Effect.runSyncWith(this._runtime)(parseWorkspaceJson(frame.state));
          if (workspace.revision !== frame.revision)
            throw new AttachError({ message: "workspace revision does not match frame" });
          Queue.offerUnsafe(this._workspaceQ, workspace);
        } catch (error) {
          this._finish(
            S.is(AttachError)(error) ? error : new AttachError({ message: errorMessage(error) }),
          );
          this._socket.end();
        }
      }),
      Match.orElse((frame) => {
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
            : entry.queues.map((queue) => Queue.offerUnsafe(queue, frame)).includes(false);
        if (overloaded) {
          this._finish(new AttachError({ message: "attach receive queue is overloaded" }));
          this._socket.end();
          return;
        }
        entry.terminal ||= frame._tag === "exit";
        if (frame._tag === "exit" && entry.queues.length === 0) this._queued.delete(frame.session);
      }),
    );
  }

  private _shutdownQueue<A>(queue: Queue.Queue<A>): void {
    // Mirror Queue.shutdown's interrupt finalize without runSync — Bun socket
    // close is sync and must wake waiters before the connection drops.
    Queue.failCauseUnsafe(queue, Cause.interrupt());
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
    const n = yield* Random.next;
    const nonce = `hello-${n.toString(36).slice(2)}`;
    const workspaceQ = yield* Queue.sliding<WorkspaceSnapshot>(1);
    const commandQ = yield* Queue.unbounded<{
      readonly id: string;
      readonly command: JsonValue;
      readonly source: "key" | "socket" | "cli";
      readonly pane?: string;
      readonly agent?: string;
    }>();
    return yield* captureRootRuntime.pipe(
      Effect.flatMap((runtime) => {
        const acquire = Effect.callback<AttachClientConnection, AttachError>((resume) => {
          let attached: AttachClientConnection | null = null;
          let socketRef: Bun.Socket<undefined> | null = null;
          let settled = false;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            attached?.close();
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
                const client = new AttachClientConnection(
                  options.client,
                  socket,
                  runtime,
                  {
                    nonce,
                    accept: () => {
                      if (settled) return;
                      settled = true;
                      resume(Effect.succeed(client));
                    },
                  },
                  { workspace: workspaceQ, command: commandQ },
                );
                attached = client;
                if (
                  !client._writer.send(
                    new Uint8Array([
                      ...encodeAttachFrameBytes({ _tag: "hello", client: options.client }),
                      ...encodeAttachFrameBytes({ _tag: "ping", nonce }),
                    ]),
                  )
                )
                  fail(new AttachError({ message: "attach handshake could not write" }));
              },
              data(_socket, data) {
                attached?._receive(data, fail);
              },
              close() {
                if (!settled)
                  fail(
                    new AttachError({
                      message: "daemon closed the attachment before accepting it",
                    }),
                  );
                else attached?._remoteClosed();
              },
              error(_socket, error) {
                if (!settled) fail(error);
                else attached?._remoteClosed(error);
              },
              drain() {
                attached?._writer.drain();
              },
            },
          }).catch(fail);

          return Effect.sync(() => {
            if (settled) return;
            settled = true;
            attached?.close();
            socketRef?.end();
          });
        }).pipe(
          Effect.timeoutOrElse({
            duration: helloTimeoutMs,
            orElse: () =>
              Effect.fail(new AttachError({ message: `attach to ${options.path} timed out` })),
          }),
        );

        // Release receives the acquired client — no fill-later slot needed.
        return Effect.acquireRelease(acquire, (client) => Effect.sync(() => client.close()), {
          interruptible: true,
        }).pipe(
          Effect.tap((client) =>
            client._heartbeatEffect(options.pingSeconds ?? PING_SECONDS).pipe(Effect.forkScoped),
          ),
        );
      }),
    );
  });
};

/** Service tag. The scoped factory creates
 *  {@link AttachClientConnection} instances that own the socket and transport
 *  state. The socket is acquired and released with the layer, so a client
 *  cannot outlive the scope that owns its attachment. */
export class AttachClient extends Context.Service<AttachClient>()("AttachClient", {
  make: (options: AttachClientOptions) => makeScoped(options),
}) {
  static layer(options: AttachClientOptions) {
    return Layer.effect(AttachClient, makeScoped(options));
  }

  /** Promise adapter for tests and remaining sync callers. Owns an orphaned
   *  scope released when the connection closes — prefer `AttachClient.make` /
   *  `AttachClient.layer` inside an Effect `Scope` (see SessionClient). */
  static connect(options: AttachClientOptions): Promise<AttachClientContract> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const client = yield* makeScoped(options).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        );
        const runtime = defaultRootRuntime();
        client._setScopeRelease(() => {
          void Effect.runPromiseWith(runtime)(Scope.close(scope, Exit.void));
        });
        return client;
      }),
    );
  }
}
