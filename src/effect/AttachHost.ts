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

import {
  Context,
  Effect,
  Either,
  ExecutionStrategy,
  Layer,
  Runtime,
  Schema as S,
  Scope,
} from "effect";
import { createServer, type Server } from "node:net";
import { chmod } from "node:fs/promises";
import { AttachHub } from "./AttachHub.ts";
import {
  AttachFrameAccumulator,
  JsonValueSchema,
  SESSION_STATE_TOPIC,
  type AttachFrame,
  type PermissionAnswer,
} from "./AttachProtocol.ts";
import { MAX_ATTACH_FRAME_BYTES } from "../limits.ts";
import { AgentLog, AgentLogDefault, type AgentLogError, type AgentLogService } from "./AgentLog.ts";
import { startAttachServer, type AttachServerError } from "./AttachServer.ts";
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
  method: S.Literal("process.state"),
  params: S.Struct({ session: S.String, state: S.String }),
});
const TopicPublishEnvelope = S.Struct({
  id: S.optional(S.String),
  method: S.Literal("topic.publish"),
  params: S.Struct({ session: S.String, topic: S.String, payload: JsonValueSchema }),
});
const PingEnvelope = S.Struct({
  id: S.optional(S.String),
  method: S.Literal("ping"),
});
const ProcessSocketRequest = S.Union(ProcessStateEnvelope, TopicPublishEnvelope, PingEnvelope);

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
  readonly interrupt: (id: string, reason?: string) => Effect.Effect<void, PtyError>;
  /** Answer a permission request a native agent session is blocked on. */
  readonly decide: (id: string, answer: PermissionAnswer) => Effect.Effect<void, PtyError>;
  readonly capture: (id: string) => Effect.Effect<string, PtyError>;
  /**
   * The server's paste buffer stack. Owned here because it belongs to the
   * PTY plane: it dies with the daemon's attach scope, exactly as tmux's
   * buffers die with the server.
   */
  readonly buffers: PasteBuffers;
}

export class AttachHost extends Context.Tag("AttachHost")<AttachHost, AttachHostService>() {}

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
  Scope.Scope | AttachHub | SessionSupervisor
> =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const supervisor = yield* SessionSupervisor;
    const host = yield* Effect.scope;
    // Register session teardown before the server resources below. Host scope
    // finalizers run in reverse order, so connections close and clients observe
    // detach before session shutdown can publish process exit frames.
    const sessions = yield* Scope.fork(host, ExecutionStrategy.sequential);

    if (options.processStatePath) {
      const processStatePath = options.processStatePath;
      // This listener is a raw node:net callback, so it cannot `yield*` the
      // way the attach server's callbacks do. Without a runtime to run it in,
      // `onSessionState` would only ever be *constructed* here and discarded —
      // an Effect that is never run reports nothing.
      const runtime = yield* Effect.runtime<never>();
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<Server>((resolve, reject) => {
              const value = createServer((socket) => {
                const buffer = new AttachFrameAccumulator();
                socket.on("data", (chunk: Buffer) => {
                  if (buffer.byteLength + chunk.byteLength > MAX_ATTACH_FRAME_BYTES) {
                    socket.destroy();
                    return;
                  }
                  for (const frame of buffer.push(chunk)) {
                    const line = Buffer.from(frame).toString("utf8").trimEnd();
                    if (!line) continue;
                    const decoded = S.decodeUnknownEither(S.parseJson(ProcessSocketRequest))(line);
                    if (Either.isLeft(decoded)) {
                      socket.write('{"ok":false,"error":"invalid request"}\n');
                      continue;
                    }
                    const request = decoded.right;
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
                    Runtime.runFork(runtime)(report);
                    socket.write(JSON.stringify({ id: request.id, ok: true }) + "\n");
                  }
                });
              });
              value.once("error", reject);
              // A pane runs arbitrary commands, so the socket it dials must be
              // owner-only even when the daemon inherited a permissive umask —
              // nothing a pane process runs may fabricate another pane's report.
              // Resolve only once the mode is pinned, so a daemon that is up is
              // one whose process-state socket is already private.
              value.listen(processStatePath, () => {
                chmod(processStatePath, 0o600).then(() => resolve(value), reject);
              });
            }),
        ),
        (value) =>
          Effect.promise(() => new Promise<void>((resolve) => value.close(() => resolve()))),
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
        supervisor
          .handle(frame)
          .pipe(
            Effect.catchTag("PtyError", (error) =>
              Effect.logDebug(`attach frame ignored: ${error.operation}: ${error.message}`),
            ),
          ),
    });
    const sessionSpec = (spec: SessionSpec): SessionSpec => {
      const next = { ...spec };
      if (options.rpcPath !== undefined) next.rpcPath = options.rpcPath;
      if (options.processStatePath !== undefined) next.processStatePath = options.processStatePath;
      if (options.daemonSession !== undefined) next.daemonSession = options.daemonSession;
      return next;
    };
    return {
      prepare: (spec) => Scope.extend(supervisor.prepare(sessionSpec(spec)), sessions),
      spawn: (spec) =>
        Scope.extend(supervisor.prepare(sessionSpec(spec)), sessions).pipe(
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
        supervisor.handle({ _tag: "agent.prompt", session: id, text, ...options }),
      interrupt: (id, reason) =>
        reason === undefined
          ? supervisor.handle({ _tag: "agent.interrupt", session: id })
          : supervisor.handle({ _tag: "agent.interrupt", session: id, reason }),
      decide: (id, answer) =>
        supervisor.handle({ _tag: "agent.permission", session: id, ...answer }),
      capture: supervisor.capture,
      // One stack per daemon, living as long as the attach plane does.
      buffers: new PasteBuffers(),
    };
  });

/**
 * The whole data plane as one layer.
 *
 * AttachHub is provided once at the bottom so the supervisor publishing
 * session output and the server subscribing clients to it are talking to the
 * same hub — layer memoization is doing load-bearing work here, not just
 * saving an allocation.
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
): Layer.Layer<AttachHost, AttachServerError> =>
  Layer.scoped(AttachHost, make(options)).pipe(
    Layer.provide(
      SessionSupervisor.Live.pipe(
        Layer.provide(
          options.agentLog ? Layer.succeed(AgentLog, options.agentLog) : AgentLogDefault,
        ),
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
      ),
    ),
    Layer.provide(AttachHub.Default),
  );
