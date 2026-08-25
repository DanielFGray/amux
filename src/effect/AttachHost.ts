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

import { Context, Effect, ExecutionStrategy, Layer, Runtime, Schema as S, Scope } from "effect";
import { createServer, type Server } from "node:net";
import { chmod } from "node:fs/promises";
import { AttachHub } from "./AttachHub.ts";
import type { AttachFrame, PermissionAnswer } from "./AttachProtocol.ts";
import { AgentLog, AgentLogDefault, type AgentLogService } from "./AgentLog.ts";
import { startAttachServer, type AttachServerError } from "./AttachServer.ts";
import { PasteBuffers } from "./BufferStore.ts";
import {
  SessionExitObserver,
  SessionStateObserver,
  SessionSupervisor,
  type PreparedSession,
} from "./SessionSupervisor.ts";
import type { ManagedSession, PromptOptions, PtyError, SessionSpec } from "./SessionRegistry.ts";

const ProcessStateReport = S.Struct({
  id: S.optional(S.String),
  method: S.String,
  params: S.optional(S.Struct({ session: S.optional(S.String), state: S.optional(S.String) })),
});

export interface AttachHostOptions {
  /** Unix socket path for the attach stream (SessionPaths.attach). */
  readonly path: string;
  /** Plain-JSON endpoint for process self-reports (SessionPaths.processState). */
  readonly processStatePath?: string;
  readonly rpcPath?: string;
  readonly daemonSession?: string;
  readonly idleTimeoutSeconds?: number;
  /** Record or reject an attachment; failing rejects the client's hello. */
  readonly onAttach?: (client: string, connection: string) => Effect.Effect<void, unknown>;
  /** An accepted client went away — EOF, error, or idle timeout. */
  readonly onDetach?: (client: string, connection: string) => Effect.Effect<void, unknown>;
  /** Any inbound frame from an accepted client, pings included — the stream's
   *  proof that an attachment is still live. */
  readonly onActivity?: (client: string, connection: string) => Effect.Effect<void, unknown>;
  /** A client adopted a session and wants its screen replayed to it alone. */
  readonly onSync?: (
    client: string,
    connection: string,
    session: string,
    after?: number,
  ) => Effect.Effect<void, unknown>;
  /** A supervised backend actually terminated (not merely an observer detaching). */
  readonly onSessionExit?: (session: string, code: number | null) => Effect.Effect<void, unknown>;
  readonly onSessionState?: (session: string, state: string) => Effect.Effect<void, unknown>;
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

const make = (
  options: AttachHostOptions,
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
                let buffer = "";
                socket.on("data", (chunk) => {
                  buffer += chunk.toString("utf8");
                  const lines = buffer.split("\n");
                  buffer = lines.pop() ?? "";
                  for (const line of lines) {
                    if (!line) continue;
                    try {
                      const request = S.decodeUnknownSync(ProcessStateReport)(JSON.parse(line));
                      const session = request.params?.session;
                      const state = request.params?.state;
                      // Built, not run: an Effect is a description, so this costs
                      // nothing when the report turns out to be malformed.
                      // Through the supervisor, not straight to the observer:
                      // the receiving integration owns validation and durable
                      // state handling before observers see this process fact.
                      const report =
                        request.method === "process.state" && session && state
                          ? supervisor.report(session, state)
                          : undefined;
                      const ok = request.method === "ping" || report !== undefined;
                      if (report) Runtime.runFork(runtime)(report);
                      socket.write(
                        JSON.stringify({
                          id: request.id,
                          ok,
                          ...(ok ? {} : { error: "unknown request" }),
                        }) + "\n",
                      );
                    } catch {
                      socket.write('{"ok":false,"error":"invalid request"}\n');
                    }
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
    return {
      prepare: (spec) =>
        Scope.extend(
          supervisor.prepare({
            ...spec,
            ...(options.rpcPath ? { rpcPath: options.rpcPath } : {}),
            ...(options.processStatePath ? { processStatePath: options.processStatePath } : {}),
            ...(options.daemonSession ? { daemonSession: options.daemonSession } : {}),
          }),
          sessions,
        ),
      spawn: (spec) =>
        Scope.extend(
          supervisor.prepare({
            ...spec,
            ...(options.rpcPath ? { rpcPath: options.rpcPath } : {}),
            ...(options.processStatePath ? { processStatePath: options.processStatePath } : {}),
            ...(options.daemonSession ? { daemonSession: options.daemonSession } : {}),
          }),
          sessions,
        ).pipe(
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
        supervisor.handle({ _tag: "agent.interrupt", session: id, ...(reason ? { reason } : {}) }),
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
export const layerAttachHost = (
  options: AttachHostOptions,
): Layer.Layer<AttachHost, AttachServerError> =>
  Layer.scoped(AttachHost, make(options)).pipe(
    Layer.provide(
      SessionSupervisor.Live.pipe(
        Layer.provide(
          options.agentLog ? Layer.succeed(AgentLog, options.agentLog) : AgentLogDefault,
        ),
        Layer.provide(
          Layer.succeed(SessionExitObserver, {
            beforePublish: options.onSessionExit ?? (() => Effect.void),
          }),
        ),
        Layer.provide(
          Layer.succeed(SessionStateObserver, {
            onState: options.onSessionState ?? (() => Effect.void),
          }),
        ),
      ),
    ),
    Layer.provide(AttachHub.Default),
  );
