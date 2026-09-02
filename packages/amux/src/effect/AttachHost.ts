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

import { Context, Deferred, Effect, Exit, Layer, Match, Schema as S, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { AttachHub } from "./AttachHub.ts";
import {
  AttachFrameAccumulator,
  JsonValueSchema,
  SESSION_STATE_TOPIC,
  type AttachFrame,
  type PermissionAnswer,
  type JsonValue,
} from "./AttachProtocol.ts";
import { MAX_ATTACH_FRAME_BYTES } from "../limits.ts";
import { AgentLog, AgentLogDefault, type AgentLogError, type AgentLogService } from "./AgentLog.ts";
import { AttachServerError, startAttachServer } from "./AttachServer.ts";
import { PasteBuffers } from "./BufferStore.ts";
import {
  SessionObserverError,
  SessionExitObserver,
  SessionStateObserver,
  SessionSupervisor,
  type PreparedSession,
} from "./SessionSupervisor.ts";
import type { ManagedSession, PromptOptions, PtyError, SessionSpec } from "./SessionRegistry.ts";
import { errorMessage } from "../error-message.ts";
import { isSameUserPeer, socketFd } from "../peer-credentials.ts";

/**
 * Requests a process may send over its daemon-private self-report socket.
 *
 * `process.state` is the generic idle/running/blocked/done self-report every
 * process integration already speaks. `topic.publish` is the same durable
 * door opened up: a namespaced topic name and an opaque JSON payload, so a
 * plugin can own a report's meaning without core naming it. Both resolve to
 * one call into the supervisor's topic-generic `report` — there is no second
 * ingestion path, only a second way to name the topic.
 */
const ProcessStateEnvelope = S.Struct({
  id: S.optional(S.String),
  method: S.Literals(["process.state"]),
  params: S.Struct({ session: S.String, state: S.String }),
});
const TopicPublishEnvelope = S.Struct({
  id: S.optional(S.String),
  method: S.Literals(["topic.publish"]),
  params: S.Struct({ session: S.String, topic: S.String, payload: JsonValueSchema }),
});
const PingEnvelope = S.Struct({
  id: S.optional(S.String),
  method: S.Literals(["ping"]),
});
const ProcessSocketRequest = S.Union([ProcessStateEnvelope, TopicPublishEnvelope, PingEnvelope]);

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
  readonly message: (id: string, message: JsonValue) => Effect.Effect<void, PtyError>;
  readonly interrupt: (id: string, reason?: string) => Effect.Effect<void, PtyError>;
  readonly decide: (id: string, answer: PermissionAnswer) => Effect.Effect<void, PtyError>;
  readonly capture: (id: string) => Effect.Effect<string, PtyError>;
  /**
   * Run a plugin-registered command on one attached client's own registry —
   * the daemon runs no plugins, so this is the only way a plugin verb can
   * execute at all. `client`/`connection` name a specific attachment (see
   * `DaemonModel.attachedConnections`); the caller decides who to ask.
   */
  readonly runOnClient: (
    client: string,
    connection: string,
    command: JsonValue,
  ) => Effect.Effect<JsonValue | undefined, AttachHostCommandError>;
  /**
   * The server's paste buffer stack. Owned here because it belongs to the
   * PTY plane: it dies with the daemon's attach scope, exactly as tmux's
   * buffers die with the server.
   */
  readonly buffers: PasteBuffers;
}

export class AttachHost extends Context.Service<AttachHost, AttachHostService>()("AttachHost") {}

const make = <
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
    // Keyed by request id rather than by client: nothing else needs to find a
    // pending command by who it was asked of, only by which answer just came back.
    const pendingCommands = new Map<string, Deferred.Deferred<JsonValue | undefined, string>>();
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
      const runtime = yield* Effect.context<never>();
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
                // Built, not run: an Effect is a description, so this costs
                // nothing when the report turns out to be malformed.
                // Through the supervisor, not straight to the observer:
                // the receiving integration owns validation and durable
                // state handling before observers see this process fact.
                const report =
                  request.method === "process.state"
                    ? supervisor.report(
                        request.params.session,
                        SESSION_STATE_TOPIC,
                        request.params.state,
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
      onFrame: (_client, frame) =>
        Match.value(frame).pipe(
          Match.tag("command.response", (frame) => {
            const pending = pendingCommands.get(frame.id);
            if (!pending) return Effect.void;
            pendingCommands.delete(frame.id);
            return frame.error !== undefined
              ? Deferred.fail(pending, frame.error)
              : Deferred.succeed(pending, frame.result);
          }),
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
      command: JsonValue,
    ): Effect.Effect<JsonValue | undefined, AttachHostCommandError> =>
      Effect.gen(function* () {
        const id = randomUUID();
        const deferred = yield* Deferred.make<JsonValue | undefined, string>();
        pendingCommands.set(id, deferred);
        yield* hub.publishTo(client, connection, { _tag: "command.request", id, command });
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
      publish: hub.publish,
      paste: (id, data) => supervisor.paste(id, data),
      write: (id, data) =>
        supervisor.handle({
          _tag: "input",
          session: id,
          data: typeof data === "string" ? new TextEncoder().encode(data) : data,
        }),
      prompt: (id, text, options) =>
        supervisor.handle({
          _tag: "session.message",
          session: id,
          message: { _tag: "agent.prompt", text, ...options },
        }),
      message: (id, message) =>
        supervisor.handle({ _tag: "session.message", session: id, message }),
      interrupt: (id, reason) =>
        supervisor.handle({
          _tag: "session.message",
          session: id,
          message:
            reason === undefined
              ? { _tag: "agent.interrupt" }
              : { _tag: "agent.interrupt", reason },
        }),
      decide: (id, answer) =>
        supervisor.handle({
          _tag: "session.message",
          session: id,
          message: { _tag: "agent.permission", ...answer },
        }),
      capture: supervisor.capture,
      runOnClient,
      // One stack per daemon, living as long as the attach plane does.
      buffers: new PasteBuffers(),
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
  Layer.effect(AttachHost, make(options)).pipe(
    Layer.provideMerge(layerSessionSupervisor(options)),
    Layer.provide(AttachHub.layer),
  );
