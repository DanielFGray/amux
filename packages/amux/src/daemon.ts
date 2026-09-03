import { randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Match,
  Option,
  Ref,
  Result,
  Schedule,
  Schema as S,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer";
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import { isSameUserPeer, socketFd } from "./peer-credentials.ts";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { ControlError, ControlRpcs, ControlSerialization } from "./control.ts";
import { AttachHost, layerAttachHost, type AttachHostService } from "./effect/AttachHost.ts";
import { SessionSupervisor } from "./effect/SessionSupervisor.ts";
import type { AttachFrame, JsonValue } from "./effect/AttachProtocol.ts";
import { makeAgentLog } from "./effect/AgentLog.ts";
import { EventBus } from "./effect/EventBus.ts";
import { DaemonModel, DaemonModelError, layerDaemonModel } from "./effect/DaemonModel.ts";
import {
  WorkspaceTransaction,
  WorkspaceTransactionError,
  WorkspaceTransactionLifecycle,
  WorkspaceTransactionPersistence,
  makeSessionOps,
  makeWorktreeOps,
  makePersistence,
  makeEvents,
  type WorkspaceTransactionResult,
} from "./effect/WorkspaceTransaction.ts";
import type { PlatformError } from "effect/PlatformError";
import type { AttachServerError } from "./effect/AttachServer.ts";
import type { BufferEntry } from "./effect/BufferStore.ts";
import type {
  ManagedSession,
  PromptOptions,
  PtyError,
  SessionSpec,
} from "./effect/SessionRegistry.ts";
import {
  isSessionId,
  processAlive,
  SessionStore,
  optionalEnvVar,
  sessionPaths,
  ensurePrivateDirectory,
  worktreesRoot,
  SessionIdError,
  SessionStateError,
  SessionSizeError,
  type SessionLease,
  type SessionState,
  type SessionPaths,
} from "./session.ts";

const encodeJson = S.encodeSync(S.fromJsonString(S.Unknown));
const decodeJson = S.decodeSync(S.fromJsonString(S.Unknown));
import {
  command,
  COMMAND_META,
  type Command,
  type CommandMeta,
  type RuntimeCommand,
} from "./commands.ts";
import {
  findPaneBySession,
  markSessionExited,
  markSessionUnavailable,
  parseWorkspaceCommandContext,
  workspaceFromSession,
  workspacePaneOf,
  workspaceSession,
  workspaceSessions,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
} from "./workspace.ts";
import { gitWorktreeExists } from "./git.ts";
import { paneSession } from "./layout.ts";
import { errorMessage } from "./error-message.ts";
import { identifyAgent } from "@danielfgray/amux-agent-awareness/identify.ts";
import { readHarnessLog } from "@danielfgray/amux-agent-awareness/harness-log.ts";
import { DEFAULT_HARNESS_LOG_LINES } from "./limits.ts";

const describe = errorMessage;

export class SessionDaemonError extends S.TaggedError<SessionDaemonError>()("SessionDaemonError", {
  message: S.String,
}) {}

export class DaemonError extends S.TaggedError<DaemonError>()("DaemonError", {
  message: S.String,
}) {}

/** The data plane the daemon holds open: the attach host and the supervisor it
 *  is built over, which is a key of its own so a registry can reach it. */
type HostRuntime = ManagedRuntime.ManagedRuntime<AttachHost | SessionSupervisor, AttachServerError>;

/**
 * The daemon's lifecycle, as one tagged state.
 *
 * The attach runtime, the host service, the control server scope and the
 * heartbeat fiber were once four independently-nullable fields set and cleared
 * across start() and one teardown path; nothing enforced that they move
 * together. Now they exist together inside a single `running` tag or not at
 * all, and only `dispatch`'s handlers below may construct or discard that tag.
 *
 * `starting` is the half-built state: the host (and its attach socket) exists,
 * but nothing is restored and no control plane listens yet. It exists because
 * startup's own second half — restore, the default space, the control server —
 * runs the workspace transaction, and that transaction reads the host off the
 * committed state. Dispatch cannot serve itself, so the host has to be
 * committed before the transaction can run.
 */
type DaemonPhase =
  | { readonly _tag: "stopped" }
  | {
      readonly _tag: "starting";
      readonly host: AttachHostService;
      readonly hostRuntime: HostRuntime;
    }
  | {
      readonly _tag: "running";
      readonly host: AttachHostService;
      readonly hostRuntime: HostRuntime;
      readonly controlScope: Scope.Closeable;
      readonly heartbeatFiber: Fiber.Fiber<void, never>;
    }
  | { readonly _tag: "closed" };

type WorkspaceCommandRequestContext = Omit<WorkspaceCommandContext, "shell"> & {
  readonly shell: readonly string[];
};

/** The host is live (and its attach socket is up) in both `starting` and
 *  `running`; the control plane and heartbeat are what distinguish them. */
const hostOf = (
  state: DaemonPhase,
): {
  host: AttachHostService;
  hostRuntime: HostRuntime;
} | null =>
  state._tag === "starting" || state._tag === "running"
    ? { host: state.host, hostRuntime: state.hostRuntime }
    : null;

/**
 * Raised inside the lock acquisition loop when the lock file exists but is
 * empty or unparseable — another process opened with `wx` but hasn't written
 * its PID yet.  Effect.retry with a spaced Schedule retries this for a
 * bounded period; once the bound is exceeded the unwritten lock is stale
 * (the process died) and gets recovered like any other stale lock.
 */
class LockContended extends S.TaggedError<LockContended>()("LockContended", {}) {}

class StaleLock extends S.TaggedError<StaleLock>()("StaleLock", {}) {}

export interface SessionDaemonOptions {
  readonly saveState?: (
    state: SessionState,
  ) => Effect.Effect<
    void,
    SessionIdError | SessionStateError | SessionSizeError | PlatformError | DaemonError,
    SessionStore
  >;
  readonly spawnSession?: (
    spec: SessionSpec,
  ) => Effect.Effect<ManagedSession, PtyError | DaemonError>;
}

export interface SessionDaemonService {
  readonly id: string;
  readonly paths: SessionPaths;
  readonly start: Effect.Effect<void, DaemonError>;
  readonly stop: Effect.Effect<void, DaemonError>;
  readonly close: Effect.Effect<void, DaemonError>;
  /** Completes when stop or close has finished releasing daemon resources. */
  readonly closed: Effect.Effect<void>;
  readonly runWorkspaceCommand: (
    value: Command,
    expectedRevision: number,
    context: WorkspaceCommandContext,
  ) => Effect.Effect<WorkspaceTransactionResult, DaemonError>;
  readonly spawnSession: (spec: SessionSpec) => Effect.Effect<ManagedSession, DaemonError>;
  killSession: (id: string) => Effect.Effect<void, DaemonError>;
  readonly liveSessions: Effect.Effect<readonly string[], never>;
  readonly setBuffer: (n: string | undefined, d: string) => Effect.Effect<string, DaemonError>;
  readonly pasteBuffer: (
    n: string | undefined,
    t: string,
    d: boolean,
  ) => Effect.Effect<void, DaemonError>;
  readonly listBuffers: Effect.Effect<readonly BufferEntry[], DaemonError>;
  readonly deleteBuffer: (n: string | undefined) => Effect.Effect<void, DaemonError>;
  readonly showBuffer: (n: string | undefined) => Effect.Effect<string, DaemonError>;
  readonly getState: Effect.Effect<SessionState, never>;
  readonly getWorkspace: Effect.Effect<WorkspaceSnapshot, never>;
  readonly getAttachedClients: Effect.Effect<string[], never>;
  readonly getAttachedClient: Effect.Effect<string | null, never>;
}

export const SessionDaemon = Context.Service<SessionDaemonService>("@amux/SessionDaemon");

const SHUTDOWN_SAVE_TIMEOUT_MS = 500;

export const makeDaemonService = Effect.fnUntraced(function* (
  id: string,
  options: SessionDaemonOptions,
) {
  if (!isSessionId(id))
    return yield* new SessionDaemonError({
      message: `invalid session id ${encodeJson(id)}`,
    });

  const paths = yield* sessionPaths(id);
  const daemonWorktreesRoot = yield* worktreesRoot;
  const defaultShell = Option.getOrElse(yield* optionalEnvVar("SHELL"), () => "bash");
  const session = yield* SessionStore;
  const closed = yield* Deferred.make<void>();
  const fs = yield* FileSystem.FileSystem;
  const agentLog = yield* makeAgentLog(paths.root);

  yield* ensurePrivateDirectory(paths.root);

  // `lockScope` owns the lock file.  It is closed by `terminate` on normal
  // shutdown and by an ambient-scope finalizer on failure or interrupt.
  // `acquireRelease` registers the lock removal exactly once — when
  // `lockScope` closes — so there is no second release path.
  const lockScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(lockScope, Exit.void));

  // The `wx` open is the atomic claim — only one process can succeed.
  // `acquireRelease` ties the lock removal to successful acquisition: it
  // only fires when `wx` actually succeeded.  Paths that detect a live
  // owner (live pid, live lease) fail the acquire — the release never
  // runs, so a live daemon's lock file cannot be deleted by a competing
  // process.
  //
  // An empty or unparseable lock means a concurrent process opened `wx` but
  // has not written its PID yet, so `lockOwner` waits one out.  A
  // write-after-open takes <10µs; 500ms is a 1000× margin, and a lock still
  // unwritten past it belongs to a process that died in that window.  The
  // retry only delays a lock that is actually unwritten — a lock naming a
  // dead owner is read once and recovered with no wait.
  yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const lockOwner = Effect.gen(function* () {
        const content = yield* fs.readFileString(paths.lock).pipe(Effect.orElseSucceed(() => ""));
        const owner = Number.parseInt(content, 10);
        if (Number.isInteger(owner) && owner > 0) return owner;
        return yield* new LockContended();
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "LockContended",
          schedule: Schedule.spaced("10 millis").pipe(Schedule.upTo({ duration: "500 millis" })),
        }),
      );

      const acquire = Effect.gen(function* () {
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const file = yield* fs.open(paths.lock, {
              flag: "wx",
              mode: 0o600,
            });
            yield* file.write(new TextEncoder().encode(`${process.pid}\n`));
            return file;
          }),
        );
        if (Result.isSuccess(result)) return result.success;
        const error = result.failure;
        if (error.reason._tag !== "AlreadyExists") return yield* Effect.die(error);

        const owner = yield* Effect.result(lockOwner);
        if (Result.isFailure(owner)) {
          // Never written: the claimant died between the open and the write.
          yield* fs.remove(paths.lock).pipe(Effect.ignore);
          return yield* new StaleLock();
        }
        if (processAlive(owner.success))
          return yield* new DaemonError({
            message: `session '${id}' is already being opened`,
          });

        const lease = yield* session.readLease(id);
        if (lease && processAlive(lease.pid))
          return yield* new DaemonError({
            message: `session '${id}' is already owned by pid ${lease.pid}`,
          });

        // A dead owner's lock is stale; recover it and reclaim immediately.
        yield* fs.remove(paths.lock);
        return yield* new StaleLock();
      }).pipe(
        Effect.retry({
          schedule: Schedule.forever,
          while: (error) => error._tag === "StaleLock",
        }),
      );

      return yield* acquire;
    }).pipe(
      Effect.mapError((e) =>
        S.is(DaemonError)(e) ? e : new DaemonError({ message: describe(e) }),
      ),
    ),
    () => fs.remove(paths.lock).pipe(Effect.ignore),
  ).pipe(Effect.provideService(Scope.Scope, lockScope));

  // Lock acquired. Verify the lease one more time — the lock could have
  // been absent while a daemon with a valid lease is still running.
  const existing = yield* session.readLease(id);
  if (existing && processAlive(existing.pid))
    return yield* new DaemonError({
      message: `session '${id}' is already owned by pid ${existing.pid}`,
    });

  const loaded = yield* session.load(id);
  const state: SessionState = loaded ?? {
    version: 1,
    id,
    createdAt: yield* Clock.currentTimeMillis,
    updatedAt: yield* Clock.currentTimeMillis,
    attached: false,
    spaces: [],
  };
  state.attached = false;
  const workspace = yield* workspaceFromSession(state);

  // The lifecycle actor is spawned unscoped, deliberately not tied to the
  // daemon scope: shutdown dismantles the daemon scope while its `shutdown`
  // event is still in flight, and after it returns the service must still
  // answer — reading `liveSessions` after stop still resolves, to `[]` off the closed state,
  // and asking a dead actor would hang. Nothing ever stops this actor; it
  // idles on its mailbox until the process ends.
  const daemonScope = yield* Scope.make();
  const eventBusContext = yield* Layer.build(EventBus.layer).pipe(Scope.provide(daemonScope));
  const eventBus = Context.get(eventBusContext, EventBus);
  const modelContext = yield* Layer.build(layerDaemonModel({ state, workspace })).pipe(
    Scope.provide(daemonScope),
  );
  const model = Context.get(modelContext, DaemonModel);

  const activeSaveRef = {
    current: null as Fiber.Fiber<void, WorkspaceTransactionError> | null,
  };
  let terminationShared: Promise<void> | null = null;

  const persist = options.saveState
    ? (s: SessionState) => options.saveState!(s).pipe(Effect.provideService(SessionStore, session))
    : (s: SessionState) => session.save(s);

  const attachInfo = (): Effect.Effect<
    Pick<SessionLease, "attachedSince" | "attachLastSeen" | "attachments">,
    never,
    never
  > =>
    Effect.gen(function* () {
      const s = yield* model.get;
      const atts = [...s.attachments.values()];
      if (!atts.length) return {};
      return {
        attachedSince: Math.min(...atts.map((a) => a.attachedSince)),
        attachLastSeen: Math.max(...atts.map((a) => a.attachLastSeen)),
        attachments: atts.map((a) => ({ ...a })),
      };
    });

  /** The lease carries per-attachment detail; the control plane only reports times. */
  const attachTimes = (): Effect.Effect<
    { attachedSince?: number; attachLastSeen?: number },
    never,
    never
  > =>
    Effect.gen(function* () {
      const { attachedSince, attachLastSeen } = yield* attachInfo();
      if (attachedSince === undefined)
        return attachLastSeen === undefined ? {} : { attachLastSeen };
      return attachLastSeen === undefined ? { attachedSince } : { attachedSince, attachLastSeen };
    });

  const enqueue = model.enqueue;

  const attachEffect = (client: string, connection: string) =>
    model
      .attach(client, connection, (newState) =>
        persist(newState).pipe(
          Effect.mapError((error) => new DaemonModelError({ message: describe(error) })),
        ),
      )
      .pipe(
        Effect.mapError((e) => new DaemonError({ message: e.message })),
        Effect.ignore,
      );

  /**
   * Spawn a session against a specific host. The one place the injected
   * `options.spawnSession` override is honored, so both the lifecycle Start
   * handler (resuming persisted sessions) and the `spawn` procedure (the
   * public verb) share one spawn rule.
   */
  const rawSpawn = (
    spec: SessionSpec,
    host: AttachHostService,
  ): Effect.Effect<ManagedSession, DaemonError> =>
    (options.spawnSession ? options.spawnSession(spec) : host.spawn(spec)).pipe(
      Effect.mapError((e) => new DaemonError({ message: describe(e) })),
    );

  /** Lift a synchronous host call (buffers throw on a missing target) into
   *  the daemon's typed error channel. */
  const bufferOp = <A>(op: () => A): Effect.Effect<A, DaemonError> =>
    Effect.try({
      try: op,
      catch: (e) => new DaemonError({ message: describe(e) }),
    });

  const toDaemonError = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, DaemonError, R> =>
    effect.pipe(
      Effect.mapError((e) =>
        S.is(DaemonError)(e) ? e : new DaemonError({ message: describe(e) }),
      ),
    );

  // `runStart` and `runShutdown` build and dismantle the `running` tag; the
  // other host verbs read their resources straight off that tag. The heavy
  // lifting (lease, attach runtime, control server, heartbeat, restore,
  // drain, final persistence) lives in these handlers because the state
  // transition and the work it represents must not be able to drift apart.

  // Shared by the two startup halves: the lease is written when the host
  // comes up and refreshed by the heartbeat after the daemon is running.
  const lease: SessionLease = {
    version: 1,
    session: id,
    pid: process.pid,
    socket: paths.socket,
    startedAt: yield* Clock.currentTimeMillis,
    heartbeatAt: yield* Clock.currentTimeMillis,
  };

  const stateRef = yield* Ref.make<DaemonPhase>({ _tag: "stopped" });
  const daemonLock = yield* Semaphore.make(1);

  /** Runs `handler` against the current lifecycle state with exclusive
   *  access, committing the returned next-state only on success — so no
   *  request ever observes the daemon half-started or half-torn-down, and a
   *  failed procedure leaves the state exactly as it found it. */
  const dispatch = <A, E, R>(
    handler: (state: DaemonPhase) => Effect.Effect<readonly [A, DaemonPhase], E, R>,
  ): Effect.Effect<A, E, R> =>
    daemonLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const [value, next] = yield* handler(state);
        yield* Ref.set(stateRef, next);
        return value;
      }),
    );

  // The seven host operations below are procedures, not guards: outside the
  // live states their handlers reject with "daemon not started" instead of a
  // scattered nullable-field check.

  const runStart: Effect.Effect<void, DaemonError> = dispatch((state) =>
    Effect.gen(function* () {
      if (state._tag !== "stopped") return [void 0, state] as const;

      yield* Effect.gen(function* () {
        const cur = yield* model.get;
        yield* persist(cur.state);
      }).pipe(enqueue);

      yield* session.writeLease(lease);

      yield* fs
        .remove(paths.attach)
        .pipe(
          Effect.catchTag("PlatformError", (e) =>
            e.reason._tag === "NotFound" ? Effect.void : Effect.die(e),
          ),
        );

      // node:net's Server.listen(path) does not unlink a stale socket
      // file the way a listener whose owner exited cleanly would; a
      // daemon that died without running its finalizers (a crash, a
      // kill -9) leaves this file behind, and every future start then
      // fails bind with EADDRINUSE forever until it is removed.
      yield* fs
        .remove(paths.processState)
        .pipe(
          Effect.catchTag("PlatformError", (e) =>
            e.reason._tag === "NotFound" ? Effect.void : Effect.die(e),
          ),
        );

      const rt = ManagedRuntime.make(
        layerAttachHost({
          path: paths.attach,
          processStatePath: paths.processState,
          rpcPath: paths.socket,
          daemonSession: id,
          onAttach: attachEffect,
          onDetach: detachEffect,
          onActivity: touchEffect,
          onSessionExit: (sid, code) => sessionExitEffect(sid, code).pipe(Effect.ignore),
          onSessionState: (sid, s) =>
            eventBus.publish({ _tag: "session.state", session: sid, state: s }),
          agentLog,
        }).pipe(Layer.provide(BunFileSystem.layer)),
      );
      const host = yield* Effect.promise(() => rt.runPromise(AttachHost));

      // The host and its attach socket are committed here, in the
      // `starting` state: the rest of startup runs the workspace
      // transaction, which reads the host off the dispatch state, and
      // dispatch cannot serve itself.
      return [void 0, { _tag: "starting", host, hostRuntime: rt }] as const;
    }).pipe(toDaemonError),
  );

  const runFinishStartup: Effect.Effect<void, DaemonError> = dispatch((state) =>
    Effect.gen(function* () {
      if (state._tag !== "starting") return [void 0, state] as const;
      const { host, hostRuntime } = state;

      yield* Effect.gen(function* () {
        const cur = yield* model.get;
        let next = cur.workspace;
        let changed = false;
        for (const space of next.spaces) {
          if (space.worktree) {
            const exists = yield* Effect.promise(() => gitWorktreeExists(space.worktree!.path));
            if (!exists) {
              for (const w of space.windows)
                for (const a of w.sessions) {
                  if (!a.exited) {
                    next = markSessionExited(next, a.id, null);
                    changed = true;
                  }
                }
              continue;
            }
          }
          for (const w of space.windows) {
            for (const a of w.sessions) {
              if (a.exited || a.kind === "component") continue;
              const pane = findPaneBySession(next, a.id);
              const spec: SessionSpec = {
                kind: a.kind,
                id: a.id,
                cmd: a.cmd ?? [],
                cwd: a.cwd,
                rpcPath: paths.socket,
                daemonSession: id,
                cols: a.cols,
                rows: a.rows,
              };
              const withAgent =
                a.declaredAgent === undefined ? spec : { ...spec, agent: a.declaredAgent };
              const finalSpec = pane === null ? withAgent : { ...withAgent, paneId: pane.id };
              yield* rawSpawn(finalSpec, host).pipe(
                Effect.catch((error) => {
                  next = markSessionUnavailable(next, a.id, describe(error));
                  changed = true;
                  return Effect.void;
                }),
              );
            }
          }
        }
        const newState = workspaceSession(next, cur.state);
        if (changed) yield* persist(newState);
        yield* model.commitWorkspace(next, newState);
      }).pipe(enqueue);

      const curSpace = yield* model.workspace;
      if (curSpace.spaces.length === 0) {
        yield* runWorkspaceCommand(command("space.new"), curSpace.revision, {
          size: { cols: 80, rows: 24 },
          shell: [defaultShell],
          cwd: process.cwd(),
        });
      }

      yield* fs
        .remove(paths.socket)
        .pipe(
          Effect.catchTag("PlatformError", (e) =>
            e.reason._tag === "NotFound" ? Effect.void : Effect.die(e),
          ),
        );

      const controlScope = yield* Scope.make();
      const socketServer = yield* NodeSocketServer.make({
        path: paths.socket,
      }).pipe(Scope.provide(controlScope));
      const controlSocketServer = SocketServer.SocketServer.of({
        ...socketServer,
        run: (handler) =>
          socketServer.run((socket) =>
            // The control socket is the boundary that matters: anything that
            // reaches the RPC handler can Run commands as this user. The peer's
            // uid comes from the kernel, so it is the one claim about a caller
            // the caller cannot make up.
            // `NetSocket` is placed in the connection's context by the node
            // socket server but absent from `run`'s signature, so it is read as
            // an option. Absent means the peer cannot be identified, which is
            // refused for the same reason an unreadable uid is.
            Effect.flatMap(Effect.serviceOption(NodeSocket.NetSocket), (conn) =>
              Option.isNone(conn) || !isSameUserPeer(socketFd(conn.value))
                ? Effect.sync(() => {
                    if (Option.isSome(conn)) conn.value.destroy();
                  })
                : handler(socket).pipe(
                    Effect.catchCause((cause) => {
                      const error = Cause.squash(cause);
                      return Socket.SocketError.is(error) && error.reason._tag === "SocketReadError"
                        ? Effect.void
                        : Effect.failCause(cause);
                    }),
                  ),
            ),
          ),
      });
      yield* Layer.build(
        RpcServer.layer(ControlRpcs, { disableTracing: true }).pipe(
          Layer.provide(RpcServer.layerProtocolSocketServer),
          Layer.provide(ControlSerialization),
          Layer.provide(Layer.succeed(SocketServer.SocketServer, controlSocketServer)),
          Layer.provide(controlHandlers),
        ),
      ).pipe(Scope.provide(controlScope));

      const heartbeatFiber = yield* Effect.forkIn(
        Effect.forever(
          Effect.sleep("1 second").pipe(
            Effect.andThen(
              enqueue(
                Effect.gen(function* () {
                  const info = yield* attachInfo();
                  const hbAt = yield* Clock.currentTimeMillis;
                  yield* session.writeLease({
                    ...lease,
                    heartbeatAt: hbAt,
                    ...info,
                  });
                  yield* model.setHeartbeatError(null);
                }),
              ),
            ),
            Effect.catchCause((c) =>
              Cause.hasInterruptsOnly(c)
                ? Effect.interrupt
                : model.setHeartbeatError(`lease heartbeat failed: ${Cause.pretty(c)}`),
            ),
          ),
        ),
        daemonScope,
      );

      return [
        void 0,
        { _tag: "running", host, hostRuntime, controlScope, heartbeatFiber },
      ] as const;
    }).pipe(toDaemonError),
  );

  const runShutdown = (mode: "stop" | "close"): Effect.Effect<void, DaemonError> =>
    dispatch((state) =>
      Effect.gen(function* () {
        if (state._tag === "closed") return [void 0, state] as const;
        let finalFailure: string | null = null;
        if (state._tag === "running") {
          yield* Fiber.interrupt(state.heartbeatFiber);
          yield* Scope.close(state.controlScope, Exit.void);
        }

        const drained = yield* Effect.raceFirst(
          enqueue(Effect.void).pipe(Effect.as(true)),
          Effect.sleep(`${SHUTDOWN_SAVE_TIMEOUT_MS} millis`).pipe(Effect.as(false)),
        );
        if (!drained) {
          yield* model.markCancelPersistence;
          if (activeSaveRef.current) yield* Fiber.interrupt(activeSaveRef.current!);
          yield* Effect.raceFirst(
            enqueue(Effect.void),
            Effect.sleep(`${SHUTDOWN_SAVE_TIMEOUT_MS} millis`),
          );
        }

        const live = hostOf(state);
        if (live) {
          yield* Effect.promise(() => live.hostRuntime.dispose().catch(() => {}));
          yield* fs.remove(paths.attach).pipe(Effect.ignore);
        }

        if (mode === "stop") {
          yield* session.remove(id);
        } else {
          yield* enqueue(
            Effect.gen(function* () {
              const cur = yield* model.get;
              const newState = {
                ...cur.state,
                attached: false,
                updatedAt: yield* Clock.currentTimeMillis,
              };
              const result = yield* Effect.exit(
                persist(newState).pipe(Effect.timeout(`${SHUTDOWN_SAVE_TIMEOUT_MS} millis`)),
              );
              if (Exit.isFailure(result)) finalFailure = describe(Cause.squash(result.cause));
              yield* model.updateState(newState);
              yield* model.setAttachments(new Map());
              yield* model.commitWorkspace(cur.workspace, newState);
            }),
          );
        }

        yield* fs.remove(paths.socket).pipe(Effect.ignore);
        yield* fs.remove(paths.lease).pipe(Effect.ignore);
        yield* Scope.close(lockScope, Exit.void);
        if (finalFailure !== null) return yield* new DaemonError({ message: finalFailure });
        return [void 0, { _tag: "closed" }] as const;
      }).pipe(toDaemonError),
    );

  const spawnEvent = (spec: SessionSpec): Effect.Effect<ManagedSession, DaemonError> =>
    dispatch((state) => {
      const live = hostOf(state);
      return live
        ? rawSpawn(spec, live.host).pipe(Effect.map((session) => [session, state] as const))
        : Effect.fail(new DaemonError({ message: "daemon not started" }));
    });

  const killEvent = (sessionId: string): Effect.Effect<void, DaemonError> =>
    dispatch((state) => {
      const live = hostOf(state);
      return live
        ? live.host.kill(sessionId).pipe(
            toDaemonError,
            Effect.map(() => [void 0, state] as const),
          )
        : Effect.fail(new DaemonError({ message: "daemon not started" }));
    });

  // A stopped daemon answers `live` with nothing running rather than an
  // error: after stop, callers may still ask what is left to adopt.
  // A stopped daemon answers `live` with nothing running rather than an
  // error: after stop, callers may still ask what is left to adopt.
  const liveEvent = (): Effect.Effect<readonly string[], never> =>
    dispatch((state) => {
      const live = hostOf(state);
      return live
        ? live.host.live.pipe(Effect.map((sessions) => [sessions, state] as const))
        : Effect.succeed([[] as readonly string[], state] as const);
    });

  const setBufferEvent = (
    name: string | undefined,
    data: string,
  ): Effect.Effect<string, DaemonError> =>
    dispatch((state) => {
      const live = hostOf(state);
      return live
        ? bufferOp(() => live.host.buffers.set(name, data)).pipe(
            Effect.map((n) => [n, state] as const),
          )
        : Effect.fail(new DaemonError({ message: "daemon not started" }));
    });

  const pasteBufferEvent = (
    name: string | undefined,
    target: string,
    deleteAfter: boolean,
  ): Effect.Effect<void, DaemonError> =>
    dispatch((state) => {
      const live = hostOf(state);
      return live
        ? Effect.gen(function* () {
            const bytes = yield* bufferOp(() => live.host.buffers.show(name));
            yield* live.host.paste(target, bytes).pipe(toDaemonError);
            if (deleteAfter) yield* bufferOp(() => live.host.buffers.delete(name));
            return [void 0, state] as const;
          }).pipe(toDaemonError)
        : Effect.fail(new DaemonError({ message: "daemon not started" }));
    });

  const listBuffersEvent = (): Effect.Effect<readonly BufferEntry[], DaemonError> =>
    dispatch((state) => {
      const live = hostOf(state);
      return live
        ? bufferOp(() => live.host.buffers.list()).pipe(
            Effect.map((buffers) => [buffers, state] as const),
          )
        : Effect.fail(new DaemonError({ message: "daemon not started" }));
    });

  const deleteBufferEvent = (name: string | undefined): Effect.Effect<void, DaemonError> =>
    dispatch((state) => {
      const live = hostOf(state);
      return live
        ? bufferOp(() => live.host.buffers.delete(name)).pipe(
            Effect.map(() => [void 0, state] as const),
          )
        : Effect.fail(new DaemonError({ message: "daemon not started" }));
    });

  const showBufferEvent = (name: string | undefined): Effect.Effect<string, DaemonError> =>
    dispatch((state) => {
      const live = hostOf(state);
      return live
        ? bufferOp(() => new TextDecoder().decode(live.host.buffers.show(name))).pipe(
            Effect.map((text) => [text, state] as const),
          )
        : Effect.fail(new DaemonError({ message: "daemon not started" }));
    });

  const requireHost: Effect.Effect<AttachHostService, DaemonError> = Effect.flatMap(
    Ref.get(stateRef),
    (state) => {
      const live = hostOf(state);
      return live
        ? Effect.succeed(live.host)
        : Effect.fail(new DaemonError({ message: "daemon not started" }));
    },
  );

  const persistenceContext = yield* Layer.build(
    makePersistence(persist, activeSaveRef, daemonScope).pipe(
      Layer.provide(Layer.succeed(DaemonModel, model)),
    ),
  ).pipe(Scope.provide(daemonScope));
  const persistence = Context.get(persistenceContext, WorkspaceTransactionPersistence);

  const detachEffect = (client: string, connection: string) =>
    model
      .detach(client, connection, (newState) =>
        persistence
          .persistUntilSuccess(newState, "attachment detach")
          .pipe(Effect.mapError((error) => new DaemonModelError({ message: error.message }))),
      )
      .pipe(
        Effect.mapError((error) => new DaemonModelError({ message: error.message })),
        Effect.ignore,
      );

  const touchEffect = (client: string, connection: string) => model.touch(client, connection);

  const transactionContext = yield* Layer.build(
    WorkspaceTransaction.layer.pipe(
      Layer.provide(Layer.succeed(DaemonModel, model)),
      Layer.provide(Layer.succeed(WorkspaceTransactionPersistence, persistence)),
      Layer.provide(makeSessionOps(requireHost, (id) => killSession(id))),
      Layer.provide(makeWorktreeOps),
      Layer.provide(
        Layer.succeed(WorkspaceTransactionLifecycle, {
          onEmpty: Effect.suspend(() => stopWhenEmpty),
        }),
      ),
      Layer.provide(
        makeEvents((snapshot) =>
          requireHost.pipe(
            Effect.flatMap((h) =>
              h.publish({
                _tag: "workspace" as const,
                revision: snapshot.revision,
                state: encodeJson(snapshot),
              } satisfies AttachFrame),
            ),
            Effect.ignore,
          ),
        ),
      ),
    ),
  ).pipe(Scope.provide(daemonScope));
  const transaction = Context.get(transactionContext, WorkspaceTransaction);

  const sessionExitEffect = Effect.fnUntraced(function* (sid: string, code: number | null) {
    const cur = yield* model.get;
    if (cur.closing) return;
    yield* transaction.onSessionExit(sid, code);
  });

  let spawnSession = (spec: SessionSpec): Effect.Effect<ManagedSession, DaemonError> =>
    spawnEvent(spec);
  let killSession = (sessionId: string): Effect.Effect<void, DaemonError> => killEvent(sessionId);
  let stopWhenEmpty: Effect.Effect<void> = Effect.void;

  // Two requests, strictly ordered: the host must be committed in `starting`
  // before the transaction-driven restore half can run under it.
  const start = Effect.all([runStart, runFinishStartup]).pipe(Effect.asVoid);

  /**
   * Shuts the daemon down, in one of two modes that differ only in what
   * survives on disk.
   *
   * `stop` ends the session: its directory goes, layout and agent-event logs
   * with it. That is what the user asked for when they closed the last pane or
   * ran `amux stop`, and nothing else may assume it.
   *
   * `close` ends the process and leaves the session to be restored. It is what
   * a signal means — a reboot, an OOM kill, a stray `kill` — because none of
   * those carry any intent about the session. Persisting every authoritative
   * revision only buys anything if the state outlives the process that held it.
   *
   * Both remove the lock, lease and socket: those describe a running daemon,
   * not a session, and a later `startDaemon` recovers a dead owner's lock on
   * its own.
   */
  const terminate = Effect.fnUntraced(
    function* (mode: "stop" | "close") {
      if (terminationShared) return;
      yield* model.markClosing;
      const context = yield* Effect.context<never>();
      // The teardown runs detached: it must survive even when the caller is a
      // fiber the daemon scope owns (the last-pane stop is forked from inside
      // the model queue), because closing the daemon scope interrupts exactly
      // those fibers.
      terminationShared = Effect.runPromiseWith(context)(
        Effect.gen(function* () {
          const exit = yield* Effect.exit(runShutdown(mode));
          yield* Scope.close(daemonScope, Exit.void);
          yield* Deferred.succeed(closed, undefined);
          if (Exit.isFailure(exit)) return yield* Exit.failCause(exit.cause);
        }),
      );
      yield* Effect.promise(() => terminationShared!);
    },
    Effect.mapError((e) => new DaemonError({ message: describe(e) })),
  );

  const stop = terminate("stop");
  const close = terminate("close");
  stopWhenEmpty = Effect.forkDetach(
    Effect.gen(function* () {
      // The empty snapshot is published before this runs. Keep the session
      // directory until every projection has received it and detached; stop
      // removes that directory as part of its intentional session teardown.
      while ((yield* model.attachedClients).length > 0) yield* Effect.sleep("10 millis");
      yield* stop;
    }),
  ).pipe(Effect.asVoid);

  const runWorkspaceCommand = (
    value: Command,
    expectedRevision: number,
    context: WorkspaceCommandContext,
  ): Effect.Effect<WorkspaceTransactionResult, DaemonError> => {
    return transaction
      .run(value, expectedRevision, {
        ...context,
        worktreesRoot: daemonWorktreesRoot,
      })
      .pipe(Effect.mapError((e) => new DaemonError({ message: e.message })));
  };

  /**
   * Every control-plane procedure. `guard` turns failures *and* defects
   * (notably `requireHost` before `start`) into the typed ControlError, so a
   * bad request answers the caller instead of tearing the connection down.
   */
  const guard = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, ControlError> =>
    effect.pipe(
      Effect.catchCause((cause: Cause.Cause<E>) =>
        Effect.fail(new ControlError({ message: describe(Cause.squash(cause)) })),
      ),
    );

  const controlFail = (message: string) => Effect.fail(new ControlError({ message }));

  /**
   * Which session `pane.capture` reads: the one named directly, or the one a
   * named pane shows, or — for `--current` — the one the calling pane shows.
   * Resolved here, on the daemon, never substituted by the CLI. The context is
   * consulted only when the target is the caller, so a capture named by
   * session id needs no workspace command context at all.
   */
  const resolveCaptureSession = (
    value: Extract<Command, { _tag: "pane.capture" }>,
    context: WorkspaceCommandRequestContext | undefined,
    workspace: WorkspaceSnapshot,
  ): Effect.Effect<string, ControlError> =>
    Effect.gen(function* () {
      if (value.session) return value.session;
      if (value.pane) {
        const found = workspacePaneOf(workspace, value.pane);
        const session = found ? paneSession(found.pane.content) : null;
        if (!session)
          return yield* new ControlError({ message: `pane '${value.pane}' has no session` });
        return session;
      }
      if (value.current) {
        const ctx = yield* parseWorkspaceCommandContext(context ?? {}, workspace).pipe(
          Effect.mapError((e) => new ControlError({ message: e.message })),
        );
        if (ctx.agent) return ctx.agent;
        if (ctx.pane) {
          const found = workspacePaneOf(workspace, ctx.pane);
          const session = found ? paneSession(found.pane.content) : null;
          if (session) return session;
        }
        return yield* new ControlError({
          message: "pane.capture --current needs a managed pane",
        });
      }
      return yield* new ControlError({
        message: "pane.capture requires a session id or a pane",
      });
    });

  const runRemote = Effect.fnUntraced(function* (
    value: Command | RuntimeCommand,
    expectedRevision?: number,
    context?: WorkspaceCommandRequestContext,
  ) {
    const meta = (COMMAND_META as Record<string, CommandMeta>)[value._tag];
    if (!meta) {
      // Not a core command: only a plugin verb reaches here (the control
      // socket's wire schema admits nothing else), and the daemon runs no
      // plugins — the tag can only mean something to a client that loaded
      // it. Any attached one will do: see runOnClient's doc comment.
      const connections = yield* model.attachedConnections;
      const first = connections[0];
      if (!first) return yield* controlFail(`no client attached, cannot run '${value._tag}'`);
      const host = yield* requireHost;
      const result = yield* host.runOnClient(first.client, first.connection, value as JsonValue);
      return result === undefined ? {} : { result };
    }
    const command = value as Command;
    if (meta.target === "view")
      return yield* controlFail(
        `command '${command._tag}' is a view command, not remotely invocable`,
      );
    if (meta.target === "workspace") {
      const cur = yield* model.get;
      const ctx = yield* parseWorkspaceCommandContext(context ?? {}, cur.workspace);
      const output = yield* runWorkspaceCommand(
        command,
        expectedRevision ?? cur.workspace.revision,
        ctx,
      );
      if (output.result === undefined) return { workspace: encodeJson(output.snapshot) };
      return { workspace: encodeJson(output.snapshot), result: output.result };
    }
    if (meta.target === "buffers") {
      switch (command._tag) {
        case "buffer.set":
          return { result: yield* setBuffer(command.name, command.data) };
        case "buffer.list":
          return { result: yield* listBuffers };
        case "buffer.show":
          return { result: yield* showBuffer(command.name) };
        case "buffer.delete":
          yield* deleteBuffer(command.name);
          return {};
      }
      return yield* controlFail(`buffer command '${command._tag}' is not implemented for batch`);
    }
    if (meta.target === "server") {
      // The daemon runs no plugins; it only tells the clients that do.
      return yield* Match.value(command).pipe(
        Match.tag("plugin.reload", (command) =>
          Effect.gen(function* () {
            if (command.plugin === undefined) yield* eventBus.publish({ _tag: "plugins.reload" });
            else yield* eventBus.publish({ _tag: "plugins.reload", plugin: command.plugin });
            return {};
          }),
        ),
        Match.orElse((command) =>
          controlFail(`server command '${command._tag}' is not implemented for batch`),
        ),
      );
    }
    if (meta.target === "session") {
      return yield* Match.value(command).pipe(
        Match.tag("session.message", (command) =>
          requireHost.pipe(
            Effect.flatMap((h) => h.message(command.target, command.message)),
            Effect.as({}),
          ),
        ),
        Match.tag("agent.prompt", (command) =>
          Effect.gen(function* () {
            let promptOptions: PromptOptions = {};
            if (command.id !== undefined) promptOptions = { ...promptOptions, id: command.id };
            if (command.delivery !== undefined)
              promptOptions = { ...promptOptions, delivery: command.delivery };
            if (command.resume !== undefined)
              promptOptions = { ...promptOptions, resume: command.resume };
            yield* requireHost.pipe(
              Effect.flatMap((h) => h.prompt(command.target, command.text, promptOptions)),
            );
            return {};
          }),
        ),
        Match.tag("pane.capture", (command) =>
          // The capture target is a session: named directly, or a named or
          // calling pane resolved server-side to the session it shows.
          Effect.gen(function* () {
            const cur = yield* model.get;
            const session = yield* resolveCaptureSession(command, context, cur.workspace);
            return { result: yield* requireHost.pipe(Effect.flatMap((h) => h.capture(session))) };
          }),
        ),
        Match.tag("agent.logs", (command) =>
          // Reads the harness's own durable log fresh, on demand; amux never
          // stores a copy of it. The session's cwd and its declared/detected
          // harness id are what a per-harness adapter needs to find it.
          Effect.gen(function* () {
            const cur = yield* model.get;
            const found = [...workspaceSessions(cur.workspace)].find(
              ({ session }) => session.id === command.target,
            );
            if (!found) return yield* controlFail(`session '${command.target}' does not exist`);
            const harness = found.session.declaredAgent ?? identifyAgent(found.session.cmd ?? []);
            const result = yield* readHarnessLog(
              harness ?? undefined,
              found.session.cwd,
              command.lines ?? DEFAULT_HARNESS_LOG_LINES,
            ).pipe(Effect.provide(BunFileSystem.layer.pipe(Layer.provideMerge(BunPath.layer))));
            return { result };
          }),
        ),
        Match.tag("notify", (command) =>
          eventBus
            .publish({
              _tag: "notification",
              session: id,
              title: command.title,
              body: command.body,
            })
            .pipe(Effect.as({})),
        ),
        Match.orElse((command) =>
          controlFail(`session command '${command._tag}' is not implemented for batch`),
        ),
      );
    }
    return yield* controlFail("session commands are not yet implemented for batch");
  });

  const controlHandlers = ControlRpcs.toLayer({
    Ping: () =>
      guard(
        Effect.gen(function* () {
          const cur = yield* model.get;
          return { attached: cur.state.attached, ...(yield* attachTimes()) };
        }),
      ),

    Status: () =>
      guard(
        Effect.gen(function* () {
          const cur = yield* model.get;
          const obligation = cur.durableObligations.values().next().value as string | undefined;
          const degraded = obligation ?? cur.heartbeatError ?? undefined;
          const live = yield* liveSessions;
          const baseStatus = {
            attached: cur.state.attached,
            ...(yield* attachTimes()),
            session: structuredClone(cur.state),
            workspace: encodeJson(cur.workspace),
            agents: [...live],
          };
          return degraded === undefined ? baseStatus : { ...baseStatus, degraded };
        }),
      ),

    // The response must be written before shutdown closes the server that is
    // serving this very request, so the stop runs on a detached fiber.
    Stop: () =>
      guard(
        Effect.forkDetach(
          Effect.provideService(stop, SessionStore, session).pipe(Effect.ignore),
        ).pipe(Effect.asVoid),
      ),

    Batch: ({ values, expectedRevision, context }) =>
      guard(
        Effect.gen(function* () {
          if (values.length === 0) return yield* controlFail("command batch must not be empty");
          const outputs: Array<{ result?: unknown; workspace?: string }> = [];
          let revision = expectedRevision;
          for (const value of values) {
            const output = yield* runRemote(value, revision, context);
            outputs.push(output);
            if ("workspace" in output && output.workspace !== undefined) {
              revision = (decodeJson(output.workspace) as { revision: number }).revision;
            }
          }
          return { outputs };
        }),
      ),

    ResumeAgent: ({ session: sessionId, provider, argv, env, stripEnv }) =>
      guard(
        enqueue(
          Effect.gen(function* () {
            const cur = yield* model.get;
            const found = [...workspaceSessions(cur.workspace)].find(
              ({ session }) => session.id === sessionId,
            );
            if (!found) return yield* controlFail(`session '${sessionId}' does not exist`);
            if (found.session.exited)
              return yield* controlFail(`session '${sessionId}' has exited`);
            if (found.session.provider !== provider)
              return yield* controlFail(`session '${sessionId}' provider does not match`);
            if ((yield* liveSessions).includes(sessionId)) return;
            if (!argv) {
              const next = markSessionUnavailable(
                cur.workspace,
                sessionId,
                `provider '${provider}' is unavailable`,
              );
              const state = workspaceSession(next, cur.state);
              yield* persist(state);
              yield* model.commitWorkspace(next, state);
              yield* requireHost.pipe(
                Effect.flatMap((h) =>
                  h.publish({
                    _tag: "workspace",
                    revision: next.revision,
                    state: encodeJson(next),
                  } satisfies AttachFrame),
                ),
              );
              return;
            }
            const pane = findPaneBySession(cur.workspace, sessionId);
            const spec: SessionSpec = {
              kind: found.session.kind,
              agent: found.session.declaredAgent,
              id: found.session.id,
              cmd: argv,
              env,
              stripEnv,
              cwd: found.session.cwd,
              rpcPath: paths.socket,
              daemonSession: id,
              cols: found.session.cols,
              rows: found.session.rows,
            };
            const finalSpec = pane === null ? spec : { ...spec, paneId: pane.id };
            yield* spawnSession(finalSpec).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const next = markSessionUnavailable(cur.workspace, sessionId, describe(error));
                  const state = workspaceSession(next, cur.state);
                  yield* persist(state);
                  yield* model.commitWorkspace(next, state);
                  yield* requireHost.pipe(
                    Effect.flatMap((h) =>
                      h.publish({
                        _tag: "workspace",
                        revision: next.revision,
                        state: encodeJson(next),
                      } satisfies AttachFrame),
                    ),
                  );
                  return yield* controlFail(describe(error));
                }),
              ),
            );
          }),
        ),
      ),

    SetBuffer: ({ name, data }) => guard(setBuffer(name, data)),

    PasteBuffer: ({ name, target, deleteAfter }) =>
      guard(pasteBuffer(name, target, deleteAfter === true)),

    ListBuffers: () => guard(listBuffers),

    DeleteBuffer: ({ name }) => guard(deleteBuffer(name)),

    ShowBuffer: ({ name }) => guard(showBuffer(name)),

    Events: () =>
      Stream.concat(
        Stream.succeed({
          sequence: 0,
          event: { _tag: "events.ready" },
        } as const),
        Stream.unwrap(eventBus.subscribe),
      ),

    AgentCursor: ({ session }) =>
      guard(agentLog.bounds(session).pipe(Effect.map(({ latest }) => latest))),

    AgentWatch: ({ session, after }) =>
      Stream.unwrap(
        agentLog.watch(session, after).pipe(
          Effect.map((eventStream) => Stream.catch(eventStream, () => Stream.empty)),
          Effect.orElseSucceed(() => Stream.empty),
        ),
      ),
  });

  const spawnSessionService = spawnSession;

  const liveSessions = liveEvent();

  const setBuffer = (n: string | undefined, d: string): Effect.Effect<string, DaemonError> =>
    setBufferEvent(n, d);

  const pasteBuffer = (
    n: string | undefined,
    t: string,
    d: boolean,
  ): Effect.Effect<void, DaemonError> => pasteBufferEvent(n, t, d);

  const listBuffers = listBuffersEvent();

  const deleteBuffer = (n: string | undefined): Effect.Effect<void, DaemonError> =>
    deleteBufferEvent(n);

  const showBuffer = (n: string | undefined): Effect.Effect<string, DaemonError> =>
    showBufferEvent(n);

  const service: SessionDaemonService = {
    id,
    paths,
    start,
    stop,
    close,
    closed: Deferred.await(closed),
    runWorkspaceCommand,
    spawnSession: spawnSessionService,
    get killSession() {
      return killSession;
    },
    set killSession(value) {
      killSession = value;
    },
    liveSessions,
    setBuffer,
    pasteBuffer,
    listBuffers,
    deleteBuffer,
    showBuffer,
    getState: model.state,
    getWorkspace: model.workspace,
    getAttachedClients: model.attachedClients,
    getAttachedClient: model.attachedClients.pipe(Effect.map((clients) => clients[0] ?? null)),
  };
  return service;
});

export const startDaemon = Effect.fnUntraced(function* (
  id = randomUUID(),
  options: SessionDaemonOptions = {},
) {
  const daemon = yield* makeDaemonService(id, options);
  yield* daemon.start;
  return daemon;
});
