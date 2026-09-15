/**
 * The daemon's data plane, assembled and given a lifetime.
 *
 * Every piece of this existed already — the hub fans frames out, the registry
 * owns sessions (pty or agent), the supervisor pumps them, the server speaks
 * the protocol over a socket — but nothing put them in one scope and nothing
 * decided how long that scope lives. This does, and the answer is: as long
 * as the daemon.
 *
 * That answer is the whole point of the daemon. `SessionSupervisor.spawn` requires
 * a Scope, and *which* scope it gets is the difference between a multiplexer
 * and a terminal grid: give it a client's scope and every session dies when
 * the UI disconnects. Here it is given the host's, so the only things that end
 * a session are the process exiting, an explicit kill, or the daemon itself
 * going away. `spawn` below has no Scope in its signature at all, which makes
 * the wrong thing impossible to write rather than merely discouraged.
 */

import { captureRootRuntime } from "../env.ts";
import { Cause, Context, Deferred, Effect, Exit, Layer, Match, Schema as S, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { AttachHub } from "./AttachHub.ts";
import {
  AttachFrameAccumulator,
  SESSION_STATE_TOPIC,
  type AttachFrame,
  type PermissionAnswer,
  type RunRequest,
} from "./AttachProtocol.ts";
import { MAX_ATTACH_FRAME_BYTES } from "../limits.ts";
import { AgentLog, AgentLogDefault, type AgentLogError, type AgentLogService } from "./AgentLog.ts";
import { AttachServerError, startAttachServer } from "./AttachServer.ts";
import { PasteBuffers } from "./BufferStore.ts";
import { OpenDocumentStore } from "@danielfgray/amux-text-buffer";
import {
  SessionObserverError,
  SessionExitObserver,
  SessionStateObserver,
  SessionSupervisor,
  type PreparedSession,
} from "./SessionSupervisor.ts";
import type { ManagedSession, PromptOptions, SessionSpec } from "./SessionRegistry.ts";
import { PtyError } from "./SessionRegistry.ts";
import { errorMessage } from "../error-message.ts";
import { isSameUserPeer, socketFd } from "../peer-credentials.ts";
import {
  AgentLifecycleSchema,
  AgentSessionTable,
  type AgentSessionRecord,
} from "../agent-session.ts";
import { layoutRefs, OwnerJsonText } from "../layout.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { ProcessStateSchema } from "../process-state.ts";

/**
 * Requests a process may send over its daemon-private self-report socket.
 *
 * `process.state` is the generic idle/running/blocked/done self-report every
 * process integration already speaks. `topic.publish` is the same durable
 * door opened up: a namespaced topic name and an opaque JSON payload, so a
 * plugin can own a report's meaning without core naming it. Both resolve to
 * one call into the supervisor's topic-generic `report` — there is no second
 * ingestion path, only a second way to name the topic.
 *
 * `pane.report_agent_session` is the foreign-agent continuity verb: a hook
 * reports which conversation this pane is in. Validation (allowlist, seq,
 * subagent gate) lives in `agent-session.ts` because a stored ref becomes
 * restore argv — rejected reports never reach the table.
 */
const ProcessStateEnvelope = S.Struct({
  id: S.optional(S.String),
  method: S.Literals(["process.state"]),
  params: S.Struct({ session: S.String, state: ProcessStateSchema }),
});
const TopicPublishEnvelope = S.Struct({
  id: S.optional(S.String),
  method: S.Literals(["topic.publish"]),
  params: S.Struct({ session: S.String, topic: S.String, payload: OwnerJsonText }),
});
const ReportAgentSessionEnvelope = S.Struct({
  id: S.optional(S.String),
  method: S.Literals(["pane.report_agent_session"]),
  params: S.Struct({
    paneId: S.String,
    source: S.String,
    agent: S.String,
    seq: S.Finite,
    agentSessionId: S.optional(S.String),
    agentSessionPath: S.optional(S.String),
    agentId: S.optional(S.String),
    sessionStartSource: S.optional(S.String),
    lifecycle: S.optional(AgentLifecycleSchema),
    pid: S.optional(S.Int),
  }),
});
const PingEnvelope = S.Struct({
  id: S.optional(S.String),
  method: S.Literals(["ping"]),
});
const ProcessSocketRequest = S.Union([
  ProcessStateEnvelope,
  TopicPublishEnvelope,
  ReportAgentSessionEnvelope,
  PingEnvelope,
]);

export interface AttachHostOptions<
  AttachError = never,
  DetachError = never,
  ActivityError = never,
  SyncError = never,
  SessionExitError = never,
  SessionStateError = never,
> {
  /** Unix socket path for the attach stream (SessionPaths.attach). */
  readonly path: string;
  /** Plain-JSON endpoint for process self-reports (SessionPaths.processState). */
  readonly processStatePath?: string;
  readonly rpcPath?: string;
  readonly daemonSession?: string;
  readonly idleTimeoutSeconds?: number;
  /** Record or reject an attachment; failing rejects the client's hello. */
  readonly onAttach?: (client: string, connection: string) => Effect.Effect<void, AttachError>;
  /** An accepted client went away — EOF, error, or idle timeout. */
  readonly onDetach?: (client: string, connection: string) => Effect.Effect<void, DetachError>;
  /** Any inbound frame from an accepted client, pings included — the stream's
   *  proof that an attachment is still live. */
  readonly onActivity?: (client: string, connection: string) => Effect.Effect<void, ActivityError>;
  /** A client adopted a session and wants its screen replayed to it alone. */
  readonly onSync?: (
    client: string,
    connection: string,
    session: string,
    after?: number,
  ) => Effect.Effect<void, SyncError | AgentLogError>;
  /** A supervised backend actually terminated (not merely an observer detaching). */
  readonly onSessionExit?: (
    session: string,
    code: number | null,
  ) => Effect.Effect<void, SessionExitError>;
  readonly onSessionState?: (
    session: string,
    state: string,
  ) => Effect.Effect<void, SessionStateError>;
  /**
   * A trusted foreign-agent session ref was accepted. The daemon persists it
   * onto the pane in the layout snapshot; AttachHost only owns the live table.
   */
  readonly onAgentSession?: (record: AgentSessionRecord) => Effect.Effect<void, never>;
  /**
   * A resize named a session that is not live yet. Foreign-agent restore parks
   * the resume plan until the first client size arrives — return true if this
   * resize started that pending resume (herdr geometry settle).
   */
  readonly onDeferredResume?: (
    session: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<boolean, never>;
  /**
   * An attached client asked to run a command on this connection (run.request).
   * Return the Batch-shaped output, or fail with a message for run.response.error.
   */
  readonly onClientCommand?: (
    client: string,
    connection: string,
    request: RunRequest,
  ) => Effect.Effect<{ readonly result?: OwnerJsonText; readonly workspace?: string }, string>;
  readonly agentLog?: AgentLogService;
}

export class AttachHostCommandError extends S.TaggedError<AttachHostCommandError>()(
  "AttachHostCommandError",
  { message: S.String },
) {}

export interface AttachHostService {
  /**
   * Start a session owned by the daemon, not by whoever asked for it.
   *
   * No Scope parameter: the host's scope is already bound in. A caller cannot
   * accidentally tie a session's life to a request, a connection, or a client.
   */
  readonly spawn: (spec: SessionSpec) => Effect.Effect<ManagedSession, PtyError>;
  /** Start a reversible session whose exit remains private until activated. */
  readonly prepare: (spec: SessionSpec) => Effect.Effect<PreparedSession, PtyError>;
  /** Stop one session. Its exit frame reaches clients the usual way, through
   *  the supervisor's pump, so a kill and a natural exit look identical to
   *  them. */
  readonly kill: (id: string) => Effect.Effect<void, PtyError>;
  /** The session ids currently running, for a client deciding what to adopt. */
  readonly live: Effect.Effect<readonly string[]>;
  /** Each live session's leader pid, keyed by session id, for resource
   *  attribution (`pane.list`). Absent when a session's pid is not knowable. */
  readonly pids: Effect.Effect<ReadonlyMap<string, number>>;
  /** Send a frame to every attached client. */
  readonly publish: (frame: AttachFrame) => Effect.Effect<void>;
  /**
   * Write a server-owned buffer into a session, bracketed when the child asked
   * for it. The daemon-side paste path: the RPC paste-buffer verb reads a
   * buffer and hands it here.
   */
  readonly paste: (id: string, data: Uint8Array) => Effect.Effect<void, PtyError>;
  /** Raw child input used by daemon-side pane.send-keys. */
  readonly write: (id: string, data: string | Uint8Array) => Effect.Effect<void, PtyError>;
  readonly prompt: (
    id: string,
    text: string,
    options?: PromptOptions,
  ) => Effect.Effect<void, PtyError>;
  readonly message: (id: string, message: OwnerJsonText) => Effect.Effect<void, PtyError>;
  readonly interrupt: (id: string, reason?: string) => Effect.Effect<void, PtyError>;
  readonly decide: (id: string, answer: PermissionAnswer) => Effect.Effect<void, PtyError>;
  readonly capture: (id: string) => Effect.Effect<string, PtyError>;
  /**
   * Run a client-target command on one attached client's own registry.
   * Client-target handlers (core and plugin) still live only on the client;
   * this forwards opaque command JSON for that client to decode and run.
   * `client`/`connection` name a specific attachment (see
   * `DaemonModel.attachedConnections`); the caller decides who to ask. The
   * caller record travels on the wire so the client builds the same
   * invocation record key dispatch would.
   */
  readonly runOnClient: (
    client: string,
    connection: string,
    command: OwnerJsonText,
    invocation: {
      readonly source: "key" | "socket" | "cli";
      readonly pane?: string;
      readonly agent?: string;
    },
  ) => Effect.Effect<OwnerJsonText | undefined, AttachHostCommandError>;
  /**
   * The server's paste buffer stack. Owned here because it belongs to the
   * PTY plane: it dies with the daemon's attach scope, exactly as tmux's
   * buffers die with the server.
   */
  readonly buffers: PasteBuffers;
  /**
   * Open text documents shared by the editor and agent tools. Same lifetime
   * as paste buffers: daemon-scoped, not persisted across restart. Clients
   * reach this over RPC; the store itself is the sequenced authority.
   */
  readonly documents: OpenDocumentStore;
  /**
   * Trusted foreign-agent conversation refs reported over the process-state
   * socket. Keyed by pane id (conversation follows the pane). Seeded from the
   * layout snapshot on restore; updated when a hook reports.
   */
  readonly agentSession: (paneId: string) => AgentSessionRecord | undefined;
  /** Re-load trusted refs from a workspace snapshot (decode already re-validated). */
  readonly hydrateAgentSessions: (workspace: WorkspaceSnapshot) => void;
}

export class AttachHost extends Context.Service<AttachHost, AttachHostService>()("AttachHost") {}

export const makeAttachHost = <
  AttachError,
  DetachError,
  ActivityError,
  SyncError,
  SessionExitError,
  SessionStateError,
>(
  options: AttachHostOptions<
    AttachError,
    DetachError,
    ActivityError,
    SyncError,
    SessionExitError,
    SessionStateError
  >,
): Effect.Effect<
  AttachHostService,
  AttachServerError,
  Scope.Scope | AttachHub | SessionSupervisor | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const supervisor = yield* SessionSupervisor;
    const fs = yield* FileSystem.FileSystem;
    const host = yield* Effect.scope;
    const agentSessions = new AgentSessionTable();
    // Keyed by request id rather than by client: nothing else needs to find a
    // pending command by who it was asked of, only by which answer just came back.
    const pendingCommands = new Map<string, Deferred.Deferred<OwnerJsonText | undefined, string>>();
    // Register session teardown before the server resources below. Host scope
    // finalizers run in reverse order, so connections close and clients observe
    // detach before session shutdown can publish process exit frames.
    const sessions = yield* Scope.fork(host, "sequential");

    if (options.processStatePath) {
      const processStatePath = options.processStatePath;
      // This listener is a raw node:net callback, so it cannot `yield*` the
      // way the attach server's callbacks do. Without a runtime to run it in,
      // `onSessionState` would only ever be *constructed* here and discarded —
      // an Effect that is never run reports nothing.
      const runtime = yield* captureRootRuntime;
      yield* Effect.acquireRelease(
        Effect.callback<Server, AttachServerError>((resume) => {
          const value = createServer((socket) => {
            // 0600 on the socket file already turns another user away at
            // open(); this refuses one that got a descriptor anyway, which
            // the file mode alone cannot rule out.
            if (!isSameUserPeer(socketFd(socket))) {
              socket.destroy();
              return;
            }
            const buffer = new AttachFrameAccumulator();
            socket.on("data", (chunk: Buffer) => {
              if (buffer.byteLength + chunk.byteLength > MAX_ATTACH_FRAME_BYTES) {
                socket.destroy();
                return;
              }
              for (const frame of buffer.push(chunk)) {
                const line = Buffer.from(frame).toString("utf8").trimEnd();
                if (!line) continue;
                const decoded = S.decodeExit(S.fromJsonString(ProcessSocketRequest))(line);
                if (Exit.isFailure(decoded)) {
                  socket.write('{"ok":false,"error":"invalid request"}\n');
                  continue;
                }
                const request = decoded.value;
                if (request.method === "ping") {
                  socket.write(JSON.stringify({ id: request.id, ok: true }) + "\n");
                  continue;
                }
                if (request.method === "pane.report_agent_session") {
                  // Allowlist / seq / subagent gate — a rejected report must
                  // not become restore argv. Reply shape matches process.state:
                  // ok when accepted, rejected when the table refused it.
                  const result = agentSessions.report(request.params);
                  socket.write(
                    JSON.stringify(
                      result._tag === "accepted"
                        ? { id: request.id, ok: true }
                        : { id: request.id, ok: false, error: result.reason },
                    ) + "\n",
                  );
                  if (result._tag === "accepted" && options.onAgentSession) {
                    Effect.runForkWith(runtime)(options.onAgentSession(result.record));
                  }
                  continue;
                }
                // Built, not run: an Effect is a description, so this costs
                // nothing when the report turns out to be malformed.
                // Through the supervisor, not straight to the observer:
                // the receiving integration owns validation and durable
                // state handling before observers see this process fact.
                const report =
                  request.method === "process.state"
                    ? S.encodeEffect(S.fromJsonString(ProcessStateSchema))(
                        request.params.state,
                      ).pipe(
                        Effect.flatMap((payload) =>
                          supervisor.report(request.params.session, SESSION_STATE_TOPIC, payload),
                        ),
                      )
                    : supervisor.report(
                        request.params.session,
                        request.params.topic,
                        request.params.payload,
                      );
                Effect.runForkWith(runtime)(report);
                socket.write(JSON.stringify({ id: request.id, ok: true }) + "\n");
              }
            });
          });
          value.once("error", (error) =>
            resume(Effect.fail(new AttachServerError({ message: errorMessage(error) }))),
          );
          // A pane runs arbitrary commands, so the socket it dials must be
          // owner-only even when the daemon inherited a permissive umask —
          // nothing a pane process runs may fabricate another pane's report.
          // Resolve only once the mode is pinned, so a daemon that is up is
          // one whose process-state socket is already private.
          value.listen(processStatePath, () => {
            Effect.runForkWith(runtime)(
              fs.chmod(processStatePath, 0o600).pipe(
                Effect.matchCause({
                  onFailure: (cause) =>
                    resume(Effect.fail(new AttachServerError({ message: errorMessage(cause) }))),
                  onSuccess: () => resume(Effect.succeed(value)),
                }),
              ),
            );
          });
        }),
        (value) =>
          Effect.callback<void, never>((resume) => {
            value.close(() => resume(Effect.void));
          }),
      );
    }

    yield* startAttachServer({
      path: options.path,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      onAttach: options.onAttach,
      onDetach: options.onDetach,
      onActivity: options.onActivity,
      // The screen models live here, so replay is the data plane's job unless
      // an owner outside it says otherwise.
      onSync:
        options.onSync ??
        ((client, connection, session, after) =>
          supervisor.sync(client, connection, session, after)),
      // An input or resize naming a session that is already gone is a benign
      // race — the client had a keystroke in flight when the process exited —
      // not a protocol violation. Logging it keeps the attachment alive;
      // failing here would tear down the socket and every other session with
      // it.
      onFrame: (client, connection, frame) =>
        Match.value(frame).pipe(
          Match.tag("command.response", (frame) => {
            const pending = pendingCommands.get(frame.id);
            if (!pending) return Effect.void;
            pendingCommands.delete(frame.id);
            return frame.error !== undefined
              ? Deferred.fail(pending, frame.error)
              : Deferred.succeed(pending, frame.result);
          }),
          Match.tag("run.request", (request) =>
            // Fork: runRemote may call runOnClient and wait for command.response
            // on this same socket; holding the connection lane would deadlock.
            Effect.forkIn(
              Effect.gen(function* () {
                const reply = options.onClientCommand
                  ? yield* Effect.exit(options.onClientCommand(client, connection, request))
                  : Exit.fail("daemon is not accepting attach commands");
                const frame = Exit.isFailure(reply)
                  ? {
                      _tag: "run.response" as const,
                      id: request.id,
                      error: errorMessage(Cause.squash(reply.cause)),
                    }
                  : { _tag: "run.response" as const, id: request.id, ...reply.value };
                yield* hub.publishTo(client, connection, frame);
              }),
              host,
            ).pipe(Effect.asVoid),
          ),
          Match.tag("resize", (resize) =>
            Effect.gen(function* () {
              if (options.onDeferredResume) {
                const live = yield* supervisor.live;
                if (!live.includes(resize.session)) {
                  const started = yield* options.onDeferredResume(
                    resize.session,
                    resize.cols,
                    resize.rows,
                  );
                  if (started) return;
                }
              }
              yield* supervisor
                .handle(resize)
                .pipe(
                  Effect.catchTag("PtyError", (error) =>
                    Effect.logDebug(`attach frame ignored: ${error.operation}: ${error.message}`),
                  ),
                );
            }),
          ),
          Match.orElse((frame) =>
            supervisor
              .handle(frame)
              .pipe(
                Effect.catchTag("PtyError", (error) =>
                  Effect.logDebug(`attach frame ignored: ${error.operation}: ${error.message}`),
                ),
              ),
          ),
        ),
    });
    const runOnClient = (
      client: string,
      connection: string,
      command: OwnerJsonText,
      invocation: {
        readonly source: "key" | "socket" | "cli";
        readonly pane?: string;
        readonly agent?: string;
      },
    ): Effect.Effect<OwnerJsonText | undefined, AttachHostCommandError> =>
      Effect.gen(function* () {
        const id = randomUUID();
        const deferred = yield* Deferred.make<OwnerJsonText | undefined, string>();
        pendingCommands.set(id, deferred);
        const frame =
          invocation.pane !== undefined && invocation.agent !== undefined
            ? {
                _tag: "command.request" as const,
                id,
                command,
                source: invocation.source,
                pane: invocation.pane,
                agent: invocation.agent,
              }
            : invocation.pane !== undefined
              ? {
                  _tag: "command.request" as const,
                  id,
                  command,
                  source: invocation.source,
                  pane: invocation.pane,
                }
              : invocation.agent !== undefined
                ? {
                    _tag: "command.request" as const,
                    id,
                    command,
                    source: invocation.source,
                    agent: invocation.agent,
                  }
                : {
                    _tag: "command.request" as const,
                    id,
                    command,
                    source: invocation.source,
                  };
        yield* hub.publishTo(client, connection, frame);
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.fail("the client did not answer in time"),
          }),
          Effect.ensuring(Effect.sync(() => pendingCommands.delete(id))),
          Effect.mapError((message) => new AttachHostCommandError({ message })),
        );
      });
    const sessionSpec = (spec: SessionSpec): SessionSpec => {
      const next = { ...spec };
      if (options.rpcPath !== undefined) next.rpcPath = options.rpcPath;
      if (options.processStatePath !== undefined) next.processStatePath = options.processStatePath;
      if (options.daemonSession !== undefined) next.daemonSession = options.daemonSession;
      return next;
    };
    return {
      prepare: (spec) => Scope.provide(supervisor.prepare(sessionSpec(spec)), sessions),
      spawn: (spec) =>
        Scope.provide(supervisor.prepare(sessionSpec(spec)), sessions).pipe(
          Effect.tap((prepared) => prepared.activate),
          Effect.map((prepared) => prepared.session),
        ),
      kill: supervisor.kill,
      live: supervisor.live,
      pids: supervisor.pids,
      publish: hub.publish,
      paste: (id, data) => supervisor.paste(id, data),
      write: (id, data) =>
        supervisor.handle({
          _tag: "input",
          session: id,
          data: typeof data === "string" ? new TextEncoder().encode(data) : data,
        }),
      prompt: (id, text, options) =>
        Effect.gen(function* () {
          const message = yield* S.decodeEffect(OwnerJsonText)({
            _tag: "agent.prompt",
            text,
            ...options,
          }).pipe(
            Effect.mapError(
              (error) => new PtyError({ operation: "prompt", message: errorMessage(error) }),
            ),
          );
          yield* supervisor.handle({
            _tag: "session.message",
            session: id,
            message,
          });
        }),
      message: (id, message) =>
        supervisor.handle({ _tag: "session.message", session: id, message }),
      interrupt: (id, reason) =>
        Effect.gen(function* () {
          const message = yield* S.decodeEffect(OwnerJsonText)(
            reason === undefined
              ? { _tag: "agent.interrupt" }
              : { _tag: "agent.interrupt", reason },
          ).pipe(
            Effect.mapError(
              (error) => new PtyError({ operation: "interrupt", message: errorMessage(error) }),
            ),
          );
          yield* supervisor.handle({
            _tag: "session.message",
            session: id,
            message,
          });
        }),
      decide: (id, answer) =>
        Effect.gen(function* () {
          const message = yield* S.decodeEffect(OwnerJsonText)({
            _tag: "agent.permission",
            ...answer,
          }).pipe(
            Effect.mapError(
              (error) => new PtyError({ operation: "decide", message: errorMessage(error) }),
            ),
          );
          yield* supervisor.handle({
            _tag: "session.message",
            session: id,
            message,
          });
        }),
      capture: supervisor.capture,
      runOnClient,
      // One stack per daemon, living as long as the attach plane does.
      buffers: new PasteBuffers(),
      documents: new OpenDocumentStore(),
      agentSession: (paneId) => agentSessions.get(paneId),
      hydrateAgentSessions: (workspace) => {
        for (const space of workspace.spaces) {
          for (const window of space.windows) {
            for (const pane of layoutRefs(window.layout)) {
              if (pane.agentSession) agentSessions.load(pane.id, pane.agentSession);
            }
          }
        }
      },
    };
  });

/** The options a supervisor reads, taken from the host's own so the two cannot drift. */
export type SessionSupervisorOptions<SessionExitError = never, SessionStateError = never> = Pick<
  AttachHostOptions<never, never, never, never, SessionExitError, SessionStateError>,
  "agentLog" | "onSessionExit" | "onSessionState"
>;

/**
 * The supervisor, with the observers and agent log it answers to.
 *
 * Built apart from the attach host because a supervisor nested inside the
 * host's layer graph is reachable only to the host, and a registry can mount
 * only what is a key. `layerAttachHost` still provides it, so who releases it
 * and in what order are unchanged.
 */
export const layerSessionSupervisor = <SessionExitError, SessionStateError>(
  options: SessionSupervisorOptions<SessionExitError, SessionStateError>,
) =>
  SessionSupervisor.layer.pipe(
    Layer.provide(options.agentLog ? Layer.succeed(AgentLog, options.agentLog) : AgentLogDefault),
    Layer.provide(
      Layer.succeed(SessionExitObserver, {
        beforePublish: (session, code) =>
          (options.onSessionExit?.(session, code) ?? Effect.void).pipe(
            Effect.mapError(
              (error) =>
                new SessionObserverError({ message: errorMessage(error), operation: "exit" }),
            ),
          ),
      }),
    ),
    Layer.provide(
      Layer.succeed(SessionStateObserver, {
        onState: (session, state) =>
          (options.onSessionState?.(session, state) ?? Effect.void).pipe(
            Effect.mapError(
              (error) =>
                new SessionObserverError({ message: errorMessage(error), operation: "state" }),
            ),
          ),
      }),
    ),
  );

/**
 * The whole data plane as one layer.
 *
 * AttachHub is provided once at the bottom so the supervisor publishing
 * session output and the server subscribing clients to it are talking to the
 * same hub — layer memoization is doing load-bearing work here, not just
 * saving an allocation.
 *
 * The supervisor is merged rather than provided, so it leaves as a key of its
 * own. Merging changes what the layer exposes, not how it is built or torn
 * down: the host's finalizers still run before the supervisor's, and the hub's
 * after both.
 */
export const layerAttachHost = <
  AttachError,
  DetachError,
  ActivityError,
  SyncError,
  SessionExitError,
  SessionStateError,
>(
  options: AttachHostOptions<
    AttachError,
    DetachError,
    ActivityError,
    SyncError,
    SessionExitError,
    SessionStateError
  >,
): Layer.Layer<AttachHost | SessionSupervisor, AttachServerError, FileSystem.FileSystem> =>
  layerAttachServer(options).pipe(
    Layer.provideMerge(layerSessionSupervisor(options)),
    Layer.provide(AttachHub.layer),
  );

/** The listener alone: kernel components provide the shared hub and supervisor. */
export const layerAttachServer = <
  AttachError,
  DetachError,
  ActivityError,
  SyncError,
  SessionExitError,
  SessionStateError,
>(
  options: AttachHostOptions<
    AttachError,
    DetachError,
    ActivityError,
    SyncError,
    SessionExitError,
    SessionStateError
  >,
): Layer.Layer<
  AttachHost,
  AttachServerError,
  AttachHub | SessionSupervisor | FileSystem.FileSystem
> => Layer.effect(AttachHost, makeAttachHost(options));
