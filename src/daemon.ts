import { randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Request,
  Runtime,
  Schedule,
  Schema as S,
  Scope,
  Stream,
} from "effect";
import { Machine } from "@effect/experimental";
import { FileSystem, SocketServer } from "@effect/platform";
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer";
import * as RpcServer from "@effect/rpc/RpcServer";
import { ControlError, ControlRpcs, ControlSerialization } from "./control.ts";
import { AttachHost, layerAttachHost, type AttachHostService } from "./effect/AttachHost.ts";
import { makeAgentLog } from "./effect/AgentLog.ts";
import { EventBus } from "./effect/EventBus.ts";
import { DaemonModel, DaemonModelError, layerDaemonModel } from "./effect/DaemonModel.ts";
import {
  WorkspaceTransaction,
  WorkspaceTransactionLifecycle,
  WorkspaceTransactionPersistence,
  makeSessionOps,
  makeWorktreeOps,
  makePersistence,
  makeEvents,
  type WorkspaceTransactionResult,
} from "./effect/WorkspaceTransaction.ts";
import type { PlatformError } from "@effect/platform/Error";
import type { AttachServerError } from "./effect/AttachServer.ts";
import type { BufferEntry } from "./effect/BufferStore.ts";
import type { ManagedSession, PtyError, SessionSpec } from "./effect/SessionRegistry.ts";
import {
  isSessionId,
  processAlive,
  SessionStore,
  optionalEnvVar,
  sessionPaths,
  worktreesRoot,
  SessionIdError,
  SessionStateError,
  SessionSizeError,
  type SessionLease,
  type SessionState,
  type SessionPaths,
} from "./session.ts";
import { command, COMMAND_META, type Command } from "./commands.ts";
import {
  markSessionExited,
  markSessionUnavailable,
  parseWorkspaceCommandContext,
  workspaceFromSession,
  workspaceSession,
  workspaceSessions,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
} from "./workspace.ts";
import { gitWorktreeExists } from "./git.ts";
import { errorMessage } from "./error-message.ts";

const describe = errorMessage;

export class SessionDaemonError extends S.TaggedError<SessionDaemonError>()("SessionDaemonError", {
  message: S.String,
}) {}

export class DaemonError extends S.TaggedError<DaemonError>()("DaemonError", {
  message: S.String,
}) {}

/**
 * The daemon's lifecycle, as one tagged state.
 *
 * The attach runtime, the host service, the control server scope and the
 * heartbeat fiber were once four independently-nullable fields set and cleared
 * across start() and one teardown path; nothing enforced that they move
 * together. Now they exist together inside a single `running` tag or not at
 * all, and only the lifecycle machine's handlers may construct or discard
 * that tag.
 *
 * `starting` is the half-built state: the host (and its attach socket) exists,
 * but nothing is restored and no control plane listens yet. It exists because
 * startup's own second half — restore, the default space, the control server —
 * runs the workspace transaction, and that transaction reads the host off the
 * committed machine state. The mailbox cannot serve itself, so the host has to
 * be committed before the transaction can run.
 */
type DaemonPhase =
  | { readonly _tag: "stopped" }
  | {
      readonly _tag: "starting";
      readonly host: AttachHostService;
      readonly hostRuntime: ManagedRuntime.ManagedRuntime<AttachHost, AttachServerError>;
    }
  | {
      readonly _tag: "running";
      readonly host: AttachHostService;
      readonly hostRuntime: ManagedRuntime.ManagedRuntime<AttachHost, AttachServerError>;
      readonly controlScope: Scope.CloseableScope;
      readonly heartbeatFiber: Fiber.RuntimeFiber<unknown, never>;
    }
  | { readonly _tag: "closed" };

/** The host is live (and its attach socket is up) in both `starting` and
 *  `running`; the control plane and heartbeat are what distinguish them. */
const hostOf = (
  state: DaemonPhase,
): { host: AttachHostService; hostRuntime: ManagedRuntime.ManagedRuntime<AttachHost, AttachServerError> } | null =>
  state._tag === "starting" || state._tag === "running"
    ? { host: state.host, hostRuntime: state.hostRuntime }
    : null;

// The mailbox requests that drive the lifecycle and every host-bound verb.
// The seven host operations are procedures, not guards: outside the live
// states their handlers reject with "daemon not started" instead of a
// scattered nullable-field check.
class DaemonStart extends Request.TaggedClass("daemonStart")<void, DaemonError, {}> {}
class DaemonFinishStartup extends Request.TaggedClass("daemonFinishStartup")<void, DaemonError, {}> {}
class DaemonShutdown extends Request.TaggedClass("daemonShutdown")<
  void,
  DaemonError,
  { mode: "stop" | "close" }
> {}
class DaemonSpawn extends Request.TaggedClass("daemonSpawn")<
  ManagedSession,
  DaemonError,
  { spec: SessionSpec }
> {}
class DaemonKill extends Request.TaggedClass("daemonKill")<void, DaemonError, { id: string }> {}
class DaemonLive extends Request.TaggedClass("daemonLive")<readonly string[], never, {}> {}
class DaemonSetBuffer extends Request.TaggedClass("daemonSetBuffer")<
  string,
  DaemonError,
  { name: string | undefined; data: string }
> {}
class DaemonPasteBuffer extends Request.TaggedClass("daemonPasteBuffer")<
  void,
  DaemonError,
  { name: string | undefined; target: string; deleteAfter: boolean }
> {}
class DaemonListBuffers extends Request.TaggedClass("daemonListBuffers")<
  readonly BufferEntry[],
  DaemonError,
  {}
> {}
class DaemonDeleteBuffer extends Request.TaggedClass("daemonDeleteBuffer")<
  void,
  DaemonError,
  { name: string | undefined }
> {}
class DaemonShowBuffer extends Request.TaggedClass("daemonShowBuffer")<
  string,
  DaemonError,
  { name: string | undefined }
> {}

type DaemonRequest =
  | DaemonStart
  | DaemonFinishStartup
  | DaemonShutdown
  | DaemonSpawn
  | DaemonKill
  | DaemonLive
  | DaemonSetBuffer
  | DaemonPasteBuffer
  | DaemonListBuffers
  | DaemonDeleteBuffer
  | DaemonShowBuffer;

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
  readonly liveSessions: () => Effect.Effect<readonly string[], never>;
  readonly setBuffer: (n: string | undefined, d: string) => Effect.Effect<string, DaemonError>;
  readonly pasteBuffer: (
    n: string | undefined,
    t: string,
    d: boolean,
  ) => Effect.Effect<void, DaemonError>;
  readonly listBuffers: () => Effect.Effect<readonly BufferEntry[], DaemonError>;
  readonly deleteBuffer: (n: string | undefined) => Effect.Effect<void, DaemonError>;
  readonly showBuffer: (n: string | undefined) => Effect.Effect<string, DaemonError>;
  readonly getState: Effect.Effect<SessionState, never>;
  readonly getWorkspace: Effect.Effect<WorkspaceSnapshot, never>;
  readonly getAttachedClients: Effect.Effect<string[], never>;
  readonly getAttachedClient: Effect.Effect<string | null, never>;
}

export const SessionDaemon = Context.GenericTag<SessionDaemonService>("@amux/SessionDaemon");

const SHUTDOWN_SAVE_TIMEOUT_MS = 500;

export const makeDaemonService = Effect.fnUntraced(function* (
  id: string,
  options: SessionDaemonOptions,
) {
  if (!isSessionId(id))
    return yield* new SessionDaemonError({
      message: `invalid session id ${JSON.stringify(id)}`,
    });

  const paths = yield* sessionPaths(id);
  const daemonWorktreesRoot = yield* worktreesRoot();
  const defaultShell = Option.getOrElse(yield* optionalEnvVar("SHELL"), () => "bash");
  const session = yield* SessionStore;
  const closed = yield* Deferred.make<void>();
  const fs = yield* FileSystem.FileSystem;
  const agentLog = yield* makeAgentLog(paths.root);

  yield* fs.makeDirectory(paths.root, { recursive: true, mode: 0o700 });

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
          schedule: Schedule.spaced("10 millis").pipe(Schedule.upTo("500 millis")),
        }),
      );

      const acquire = Effect.gen(function* () {
        const result = yield* Effect.either(
          Effect.gen(function* () {
            const file = yield* fs.open(paths.lock, {
              flag: "wx",
              mode: 0o600,
            });
            yield* file.write(new TextEncoder().encode(`${process.pid}\n`));
            return file;
          }),
        );
        if (Either.isRight(result)) return result.right;
        const error = result.left;
        if (error._tag !== "SystemError" || error.reason !== "AlreadyExists")
          return yield* Effect.die(error);

        const owner = yield* Effect.either(lockOwner);
        if (Either.isLeft(owner)) {
          // Never written: the claimant died between the open and the write.
          yield* fs.remove(paths.lock).pipe(Effect.ignore);
          return yield* new StaleLock();
        }
        if (processAlive(owner.right))
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
        e instanceof DaemonError ? e : new DaemonError({ message: describe(e) }),
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attached: false,
    spaces: [],
  };
  state.attached = false;
  const workspace = yield* workspaceFromSession(state);

  // The lifecycle actor lives in its own scope, deliberately not the daemon
  // scope: shutdown dismantles the daemon scope while its `Shutdown` request is
  // still in flight, and after it returns the service must still answer — a
  // `liveSessions()` after stop reads `[]` off the closed state, and sending to
  // a dead actor would hang. Nothing closes this scope; the actor idles on its
  // mailbox until the process ends.
  const machineScope = yield* Scope.make();
  const daemonScope = yield* Scope.make();
  const eventBusContext = yield* Layer.build(EventBus.Default).pipe(Scope.extend(daemonScope));
  const eventBus = Context.get(eventBusContext, EventBus);
  const modelContext = yield* Layer.build(layerDaemonModel({ state, workspace })).pipe(
    Scope.extend(daemonScope),
  );
  const model = Context.get(modelContext, DaemonModel);

  const activeSaveRef = {
    current: null as Fiber.RuntimeFiber<void, unknown> | null,
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
      return {
        ...(attachedSince !== undefined ? { attachedSince } : {}),
        ...(attachLastSeen !== undefined ? { attachLastSeen } : {}),
      };
    });

  const enqueue = model.enqueue;

  const attachEffect = (client: string, connection: string) =>
    model
      .attach(client, connection, persist)
      .pipe(
        Effect.mapError((e) =>
          e instanceof DaemonModelError
            ? new DaemonError({ message: e.message })
            : new DaemonError({ message: describe(e) }),
        ),
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

  /** Lift a synchronous host call (buffers throw on a missing target) into the
   *  machine's typed error channel. A defect here would kill the actor. */
  const bufferOp = <A>(op: () => A): Effect.Effect<A, DaemonError> =>
    Effect.try({
      try: op,
      catch: (e) => new DaemonError({ message: describe(e) }),
    });

  const toDaemonError = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, DaemonError> =>
    effect.pipe(
      Effect.mapError((e) =>
        e instanceof DaemonError ? e : new DaemonError({ message: describe(e) }),
      ),
    );

  /**
   * The lifecycle machine. Requests are serialized through the mailbox, so no
   * request ever observes the daemon half-started or half-torn-down: a host
   * verb either runs against a complete `running` state or is rejected.
   *
   * `Start` and `Shutdown` build and dismantle the `running` tag; the host
   * verbs read their resources straight off that tag. The heavy lifting
   * (lease, attach runtime, control server, heartbeat, restore, drain, final
   * persistence) lives in these handlers because the state transition and the
   * work it represents must not be able to drift apart.
   */
  const daemonMachine = Machine.make<
    DaemonPhase,
    DaemonRequest,
    never,
    never,
    never
  >(
    Effect.gen(function* () {
      // Shared by the two startup halves: the lease is written when the host
      // comes up and refreshed by the heartbeat after the daemon is running.
      const lease: SessionLease = {
        version: 1,
        session: id,
        pid: process.pid,
        socket: paths.socket,
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      };
      return Machine.procedures
        .make<DaemonPhase>({ _tag: "stopped" }, { identifier: "SessionDaemon" })
        .pipe(
          Machine.procedures.add<DaemonStart>()("daemonStart", ({ state }) =>
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
                  Effect.catchTag("SystemError", (e) =>
                    e.reason === "NotFound" ? Effect.void : Effect.die(e),
                  ),
                );

              const rt = ManagedRuntime.make(
                layerAttachHost({
                  path: paths.attach,
                  agentStatePath: paths.agentState,
                  rpcPath: paths.socket,
                  daemonSession: id,
                  onAttach: attachEffect,
                  onDetach: detachEffect,
                  onActivity: touchEffect,
                  onSessionExit: (sid, code) => sessionExitEffect(sid, code),
                  onAgentState: (sid, s) =>
                    eventBus.publish({ _tag: "agent.state", session: sid, state: s }),
                  agentLog,
                }),
              );
              const host = yield* Effect.promise(() => rt.runPromise(AttachHost));

              // The host and its attach socket are committed here, in the
              // `starting` state: the rest of startup runs the workspace
              // transaction, which reads the host off the machine state, and
              // the mailbox cannot serve itself.
              return [void 0, { _tag: "starting", host, hostRuntime: rt }] as const;
            }).pipe(toDaemonError),
          ),

          Machine.procedures.add<DaemonFinishStartup>()("daemonFinishStartup", ({ state }) =>
            Effect.gen(function* () {
              if (state._tag !== "starting") return [void 0, state] as const;
              const { host, hostRuntime } = state;

              yield* Effect.gen(function* () {
                const cur = yield* model.get;
                let next = cur.workspace;
                let changed = false;
                for (const space of next.spaces) {
                  if (space.worktree) {
                    const exists = yield* Effect.promise(() =>
                      gitWorktreeExists(space.worktree!.path),
                    );
                    if (!exists) {
                      for (const w of space.windows)
                        for (const a of w.agents) {
                          if (!a.exited) {
                            next = markSessionExited(next, a.id, null);
                            changed = true;
                          }
                        }
                      continue;
                    }
                  }
                  for (const w of space.windows) {
                    for (const a of w.agents) {
                      if (a.exited || a.kind === "component") continue;
                      yield* rawSpawn(
                        {
                          kind: a.kind,
                          ...(a.agent ? { agent: a.agent } : {}),
                          id: a.id,
                          cmd: a.cmd ?? [],
                          cwd: a.cwd,
                          rpcPath: paths.socket,
                          daemonSession: id,
                          cols: a.cols,
                          rows: a.rows,
                        },
                        host,
                      ).pipe(
                        Effect.catchAll((error) => {
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
                  Effect.catchTag("SystemError", (e) =>
                    e.reason === "NotFound" ? Effect.void : Effect.die(e),
                  ),
                );

              const controlScope = yield* Scope.make();
              const socketServer = yield* NodeSocketServer.make({
                path: paths.socket,
              }).pipe(Scope.extend(controlScope));
              yield* Layer.build(
                RpcServer.layer(ControlRpcs, { disableTracing: true }).pipe(
                  Layer.provide(RpcServer.layerProtocolSocketServer),
                  Layer.provide(ControlSerialization),
                  Layer.provide(Layer.succeed(SocketServer.SocketServer, socketServer)),
                  Layer.provide(controlHandlers),
                ),
              ).pipe(Scope.extend(controlScope));

              const heartbeatFiber = yield* Effect.forkIn(
                Effect.forever(
                  Effect.sleep("1 second").pipe(
                    Effect.zipRight(
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
                    Effect.catchAllCause((c) =>
                      Cause.isInterruptedOnly(c)
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
          ),

          Machine.procedures.add<DaemonShutdown>()("daemonShutdown", ({ state, request }) =>
            Effect.gen(function* () {
              if (state._tag === "closed") return [void 0, state] as const;
              let finalFailure: unknown = undefined;
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

              if (request.mode === "stop") {
                yield* session.remove(id);
              } else {
                yield* enqueue(
                  Effect.gen(function* () {
                    const cur = yield* model.get;
                    const newState = {
                      ...cur.state,
                      attached: false,
                      updatedAt: Date.now(),
                    };
                    const result = yield* Effect.exit(
                      persist(newState).pipe(
                        Effect.timeout(`${SHUTDOWN_SAVE_TIMEOUT_MS} millis`),
                      ),
                    );
                    if (Exit.isFailure(result)) finalFailure = Cause.squash(result.cause);
                    yield* model.updateState(newState);
                    yield* model.setAttachments(new Map());
                    yield* model.commitWorkspace(cur.workspace, newState);
                  }),
                );
              }

              yield* fs.remove(paths.socket).pipe(Effect.ignore);
              yield* fs.remove(paths.lease).pipe(Effect.ignore);
              yield* Scope.close(lockScope, Exit.void);
              if (finalFailure !== undefined)
                return yield* new DaemonError({ message: describe(finalFailure) });
              return [void 0, { _tag: "closed" }] as const;
            }).pipe(toDaemonError),
          ),

          Machine.procedures.add<DaemonSpawn>()("daemonSpawn", ({ state, request }) => {
            const live = hostOf(state);
            return live
              ? rawSpawn(request.spec, live.host).pipe(
                  Effect.map((session) => [session, state] as const),
                )
              : Effect.fail(new DaemonError({ message: "daemon not started" }));
          }),

          Machine.procedures.add<DaemonKill>()("daemonKill", ({ state, request }) => {
            const live = hostOf(state);
            return live
              ? live.host.kill(request.id).pipe(
                  toDaemonError,
                  Effect.map((_) => [void 0, state] as const),
                )
              : Effect.fail(new DaemonError({ message: "daemon not started" }));
          }),

          // A stopped daemon answers `live` with nothing running rather than an
          // error: after stop, callers may still ask what is left to adopt.
          Machine.procedures.add<DaemonLive>()("daemonLive", ({ state }) => {
            const live = hostOf(state);
            return live
              ? live.host.live.pipe(Effect.map((sessions) => [sessions, state] as const))
              : Effect.succeed([[] as readonly string[], state] as const);
          }),

          Machine.procedures.add<DaemonSetBuffer>()("daemonSetBuffer", ({ state, request }) => {
            const live = hostOf(state);
            return live
              ? bufferOp(() => live.host.buffers.set(request.name, request.data)).pipe(
                  Effect.map((name) => [name, state] as const),
                )
              : Effect.fail(new DaemonError({ message: "daemon not started" }));
          }),

          Machine.procedures.add<DaemonPasteBuffer>()("daemonPasteBuffer", ({ state, request }) => {
            const live = hostOf(state);
            return live
              ? Effect.gen(function* () {
                  const bytes = yield* bufferOp(() => live.host.buffers.show(request.name));
                  yield* live.host.paste(request.target, bytes).pipe(toDaemonError);
                  if (request.deleteAfter)
                    yield* bufferOp(() => live.host.buffers.delete(request.name));
                  return [void 0, state] as const;
                }).pipe(toDaemonError)
              : Effect.fail(new DaemonError({ message: "daemon not started" }));
          }),

          Machine.procedures.add<DaemonListBuffers>()("daemonListBuffers", ({ state }) => {
            const live = hostOf(state);
            return live
              ? bufferOp(() => live.host.buffers.list()).pipe(
                  Effect.map((buffers) => [buffers, state] as const),
                )
              : Effect.fail(new DaemonError({ message: "daemon not started" }));
          }),

          Machine.procedures.add<DaemonDeleteBuffer>()("daemonDeleteBuffer", ({ state, request }) => {
            const live = hostOf(state);
            return live
              ? bufferOp(() => live.host.buffers.delete(request.name)).pipe(
                  Effect.map((_) => [void 0, state] as const),
                )
              : Effect.fail(new DaemonError({ message: "daemon not started" }));
          }),

          Machine.procedures.add<DaemonShowBuffer>()("daemonShowBuffer", ({ state, request }) => {
            const live = hostOf(state);
            return live
              ? bufferOp(() => new TextDecoder().decode(live.host.buffers.show(request.name))).pipe(
                  Effect.map((text) => [text, state] as const),
                )
              : Effect.fail(new DaemonError({ message: "daemon not started" }));
          }),
        );
    }),
  );

  const actor = yield* Machine.boot(daemonMachine).pipe(
    Effect.provideService(Scope.Scope, machineScope),
  );

  const requireHost: Effect.Effect<AttachHostService, DaemonError> = Effect.flatMap(
    actor.get,
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
  ).pipe(Scope.extend(daemonScope));
  const persistence = Context.get(persistenceContext, WorkspaceTransactionPersistence);

  const detachEffect = (client: string, connection: string) =>
    model.detach(client, connection, (newState) =>
      persistence.persistUntilSuccess(newState, "attachment detach"),
    );

  const touchEffect = (client: string, connection: string) => model.touch(client, connection);

  const transactionContext = yield* Layer.build(
    WorkspaceTransaction.Default.pipe(
      Layer.provide(Layer.succeed(DaemonModel, model)),
      Layer.provide(Layer.succeed(WorkspaceTransactionPersistence, persistence)),
      Layer.provide(makeSessionOps(requireHost, (id) => killSession(id))),
      Layer.provide(makeWorktreeOps()),
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
                state: JSON.stringify(snapshot),
              } as any),
            ),
            Effect.ignore,
          ),
        ),
      ),
    ),
  ).pipe(Scope.extend(daemonScope));
  const transaction = Context.get(transactionContext, WorkspaceTransaction);

  const sessionExitEffect = Effect.fnUntraced(function* (sid: string, code: number | null) {
    const cur = yield* model.get;
    if (cur.closing) return;
    yield* transaction.onSessionExit(sid, code);
  });

  let spawnSession = (spec: SessionSpec): Effect.Effect<ManagedSession, DaemonError> =>
    actor.send(new DaemonSpawn({ spec }));
  let killSession = (sessionId: string): Effect.Effect<void, DaemonError> =>
    actor.send(new DaemonKill({ id: sessionId }));
  let stopWhenEmpty: Effect.Effect<void> = Effect.void;

  const start = Effect.gen(function* () {
    yield* actor.send(new DaemonStart());
    yield* actor.send(new DaemonFinishStartup());
  });

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
      const runtime = yield* Effect.runtime<never>();
      // The teardown runs detached: it must survive even when the caller is a
      // fiber the daemon scope owns (the last-pane stop is forked from inside
      // the model queue), because closing the daemon scope interrupts exactly
      // those fibers.
      terminationShared = Runtime.runPromise(runtime)(
        Effect.gen(function* () {
          const exit = yield* Effect.exit(actor.send(new DaemonShutdown({ mode })));
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
  stopWhenEmpty = Effect.forkDaemon(stop).pipe(Effect.asVoid);

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
  const guard = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, ControlError> =>
    effect.pipe(
      Effect.catchAllDefect((defect) => Effect.fail(defect)),
      Effect.mapError((error) => new ControlError({ message: describe(error) })),
    );

  const controlFail = (message: string) => Effect.fail(new ControlError({ message }));

  const runRemote = (value: Command, expectedRevision?: number, context?: unknown) =>
    Effect.gen(function* () {
      const meta = COMMAND_META[value._tag]!;
      if (meta.target === "view")
        return yield* controlFail(
          `command '${value._tag}' is a view command, not remotely invocable`,
        );
      if (meta.target === "workspace") {
        const cur = yield* model.get;
        const ctx = yield* parseWorkspaceCommandContext(context ?? {}, cur.workspace);
        const output = yield* runWorkspaceCommand(
          value,
          expectedRevision ?? cur.workspace.revision,
          ctx,
        );
        return {
          workspace: JSON.stringify(output.snapshot),
          ...(output.result === undefined ? {} : { result: output.result }),
        };
      }
      if (meta.target === "buffers") {
        switch (value._tag) {
          case "buffer.set":
            return { result: yield* setBuffer(value.name, value.data) };
          case "buffer.list":
            return { result: yield* listBuffers() };
          case "buffer.show":
            return { result: yield* showBuffer(value.name) };
          case "buffer.delete":
            yield* deleteBuffer(value.name);
            return {};
        }
        return yield* controlFail(`buffer command '${value._tag}' is not implemented for batch`);
      }
      if (meta.target === "server") {
        // The daemon runs no plugins; it only tells the clients that do.
        if (value._tag === "plugin.reload") {
          yield* eventBus.publish({
            _tag: "plugins.reload",
            ...(value.plugin === undefined ? {} : { plugin: value.plugin }),
          });
          return {};
        }
        return yield* controlFail(`server command '${value._tag}' is not implemented for batch`);
      }
      if (meta.target === "session") {
        if (value._tag === "agent.prompt") {
          yield* requireHost.pipe(Effect.flatMap((h) => h.prompt(value.target, value.text)));
          return {};
        }
        if (value._tag === "pane.capture") {
          const session = value.session;
          if (!session) return yield* controlFail("pane.capture requires a session id");
          return { result: yield* requireHost.pipe(Effect.flatMap((h) => h.capture(session))) };
        }
        if (value._tag === "notify") {
          yield* eventBus.publish({
            _tag: "notification",
            session: id,
            title: value.title,
            body: value.body,
          });
          return {};
        }
        return yield* controlFail(`session command '${value._tag}' is not implemented for batch`);
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
          const live = yield* liveSessions();
          return {
            attached: cur.state.attached,
            ...(yield* attachTimes()),
            session: structuredClone(cur.state),
            workspace: JSON.stringify(cur.workspace),
            agents: [...live],
            ...(degraded ? { degraded } : {}),
          };
        }),
      ),

    // The response must be written before shutdown closes the server that is
    // serving this very request, so the stop runs on a detached fiber.
    Stop: () =>
      guard(
        Effect.forkDaemon(
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
              revision = JSON.parse(output.workspace).revision;
            }
          }
          return { outputs };
        }),
      ),

    ResumeAgent: ({ session: sessionId, provider, argv, env }) =>
      guard(
        enqueue(
          Effect.gen(function* () {
            const cur = yield* model.get;
            const found = [...workspaceSessions(cur.workspace)].find(
              ({ agent }) => agent.id === sessionId,
            );
            if (!found) return yield* controlFail(`session '${sessionId}' does not exist`);
            if (found.agent.exited) return yield* controlFail(`session '${sessionId}' has exited`);
            if (found.agent.provider !== provider)
              return yield* controlFail(`session '${sessionId}' provider does not match`);
            if ((yield* liveSessions()).includes(sessionId)) return;
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
                    state: JSON.stringify(next),
                  } as never),
                ),
              );
              return;
            }
            yield* spawnSession({
              kind: found.agent.kind,
              agent: found.agent.agent,
              id: found.agent.id,
              cmd: argv,
              env,
              cwd: found.agent.cwd,
              rpcPath: paths.socket,
              daemonSession: id,
              cols: found.agent.cols,
              rows: found.agent.rows,
            }).pipe(
              Effect.catchAll((error) =>
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
                        state: JSON.stringify(next),
                      } as never),
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

    ListBuffers: () => guard(listBuffers()),

    DeleteBuffer: ({ name }) => guard(deleteBuffer(name)),

    ShowBuffer: ({ name }) => guard(showBuffer(name)),

    Events: () =>
      Stream.concat(
        Stream.succeed({
          sequence: 0,
          event: { _tag: "events.ready" },
        } as const),
        Stream.unwrapScoped(eventBus.subscribe()),
      ),

    AgentCursor: ({ session }) =>
      guard(agentLog.bounds(session).pipe(Effect.map(({ latest }) => latest))),

    AgentWatch: ({ session, after }) =>
      Stream.unwrapScoped(
        agentLog.watch(session, after).pipe(Effect.map(Stream.orDie), Effect.orDie),
      ),
  });

  const spawnSessionService = spawnSession;

  const liveSessions = (): Effect.Effect<readonly string[], never> =>
    actor.send(new DaemonLive());

  const setBuffer = (n: string | undefined, d: string): Effect.Effect<string, DaemonError> =>
    actor.send(new DaemonSetBuffer({ name: n, data: d }));

  const pasteBuffer = (
    n: string | undefined,
    t: string,
    d: boolean,
  ): Effect.Effect<void, DaemonError> => actor.send(new DaemonPasteBuffer({ name: n, target: t, deleteAfter: d }));

  const listBuffers = (): Effect.Effect<readonly BufferEntry[], DaemonError> =>
    actor.send(new DaemonListBuffers());

  const deleteBuffer = (n: string | undefined): Effect.Effect<void, DaemonError> =>
    actor.send(new DaemonDeleteBuffer({ name: n }));

  const showBuffer = (n: string | undefined): Effect.Effect<string, DaemonError> =>
    actor.send(new DaemonShowBuffer({ name: n }));

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
  id = process.argv[2] || randomUUID(),
  options: SessionDaemonOptions = {},
) {
  const daemon = yield* makeDaemonService(id, options);
  yield* daemon.start;
  return daemon;
});
