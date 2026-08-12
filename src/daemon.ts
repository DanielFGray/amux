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
  Runtime,
  Schedule,
  Schema as S,
  Scope,
  Stream,
} from "effect";
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
 * Raised inside the lock acquisition loop when the lock file exists but is
 * empty or unparseable — another process opened with `wx` but hasn't written
 * its PID yet.  Effect.retry with a spaced Schedule retries this for a
 * bounded period; once the bound is exceeded the unwritten lock is stale
 * (the process died) and gets recovered like any other stale lock.
 */
class LockContended extends S.TaggedError<LockContended>()("LockContended", {}) {}

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
  ) => Effect.Effect<WorkspaceSnapshot, DaemonError>;
  readonly spawnSession: (spec: SessionSpec) => Effect.Effect<ManagedSession, DaemonError>;
  killSession: (id: string) => Effect.Effect<void, DaemonError>;
  readonly liveSessions: () => Effect.Effect<readonly string[], never>;
  readonly setBuffer: (n: string | undefined, d: string) => Effect.Effect<string, never>;
  readonly pasteBuffer: (
    n: string | undefined,
    t: string,
    d: boolean,
  ) => Effect.Effect<void, DaemonError>;
  readonly listBuffers: () => Effect.Effect<readonly BufferEntry[], never>;
  readonly deleteBuffer: (n: string | undefined) => Effect.Effect<void, never>;
  readonly showBuffer: (n: string | undefined) => Effect.Effect<string, never>;
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
    return yield* new SessionDaemonError({ message: `invalid session id ${JSON.stringify(id)}` });

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

      for (;;) {
        const result = yield* Effect.either(
          Effect.gen(function* () {
            const file = yield* fs.open(paths.lock, { flag: "wx", mode: 0o600 });
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
          continue;
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
      }
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

  const daemonScope = yield* Scope.make();
  const eventBusContext = yield* Layer.build(EventBus.Default).pipe(Scope.extend(daemonScope));
  const eventBus = Context.get(eventBusContext, EventBus);
  const modelContext = yield* Layer.build(layerDaemonModel({ state, workspace })).pipe(
    Scope.extend(daemonScope),
  );
  const model = Context.get(modelContext, DaemonModel);

  /** Holds the control-plane RPC server; its presence means `start` ran. */
  let controlScope: Scope.CloseableScope | null = null;
  let hostRuntime: ManagedRuntime.ManagedRuntime<AttachHost, AttachServerError> | null = null;
  let host: AttachHostService | null = null;
  let heartbeatFiber: Fiber.RuntimeFiber<unknown, never> | null = null;
  const activeSaveRef = { current: null as Fiber.RuntimeFiber<void, unknown> | null };
  let terminationShared: Promise<void> | null = null;

  const hostRef = { current: null as AttachHostService | null };

  const requireHost = () => {
    if (!host) throw new Error("daemon not started");
    return host;
  };

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
      Layer.provide(makeSessionOps(hostRef, (id) => killSession(id))),
      Layer.provide(makeWorktreeOps()),
      Layer.provide(
        Layer.succeed(WorkspaceTransactionLifecycle, {
          onEmpty: Effect.suspend(() => stopWhenEmpty),
        }),
      ),
      Layer.provide(
        makeEvents((snapshot) =>
          Effect.suspend(() => {
            if (!hostRef.current) return Effect.die(new Error("host not started"));
            return hostRef.current
              .publish({
                _tag: "workspace" as const,
                revision: snapshot.revision,
                state: JSON.stringify(snapshot),
              } as any)
              .pipe(Effect.ignore);
          }),
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
    (options.spawnSession ? options.spawnSession(spec) : requireHost().spawn(spec)).pipe(
      Effect.mapError((e) => new DaemonError({ message: describe(e) })),
    );
  let killSession = (sessionId: string): Effect.Effect<void, DaemonError> =>
    requireHost()
      .kill(sessionId)
      .pipe(Effect.mapError((e) => new DaemonError({ message: describe(e) })));
  let stopWhenEmpty: Effect.Effect<void> = Effect.void;

  const start = Effect.gen(function* () {
    if (controlScope) return;
    const lease: SessionLease = {
      version: 1,
      session: id,
      pid: process.pid,
      socket: paths.socket,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };

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
        onAgentState: (sid, state) =>
          eventBus.publish({ _tag: "agent.state", session: sid, state }),
        agentLog,
      }),
    );
    hostRuntime = rt;
    host = yield* Effect.promise(() => rt.runPromise(AttachHost));
    hostRef.current = host;

    yield* Effect.gen(function* () {
      const cur = yield* model.get;
      let next = cur.workspace;
      let changed = false;
      for (const space of next.spaces) {
        if (space.worktree) {
          const exists = yield* Effect.promise(() => gitWorktreeExists(space.worktree!.path));
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
            if (a.exited) continue;
            yield* spawnSession({
              kind: a.kind,
              ...(a.agent ? { agent: a.agent } : {}),
              id: a.id,
              cmd: a.cmd,
              cwd: a.cwd,
              rpcPath: paths.socket,
              daemonSession: id,
              cols: a.cols,
              rows: a.rows,
            }).pipe(
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

    const scope = yield* Scope.make();
    controlScope = scope;
    const socketServer = yield* NodeSocketServer.make({ path: paths.socket }).pipe(
      Scope.extend(scope),
    );
    yield* Layer.build(
      RpcServer.layer(ControlRpcs, { disableTracing: true }).pipe(
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(ControlSerialization),
        Layer.provide(Layer.succeed(SocketServer.SocketServer, socketServer)),
        Layer.provide(controlHandlers),
      ),
    ).pipe(Scope.extend(scope));

    heartbeatFiber = yield* Effect.forkIn(
      Effect.forever(
        Effect.sleep("1 second").pipe(
          Effect.zipRight(
            enqueue(
              Effect.gen(function* () {
                const info = yield* attachInfo();
                const hbAt = yield* Clock.currentTimeMillis;
                yield* session.writeLease({ ...lease, heartbeatAt: hbAt, ...info });
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
  }).pipe(Effect.mapError((e) => new DaemonError({ message: describe(e) })));

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
      terminationShared = Runtime.runPromise(runtime)(
        Effect.gen(function* () {
          let finalFailure: unknown = undefined;
          if (heartbeatFiber) {
            yield* Fiber.interrupt(heartbeatFiber);
            heartbeatFiber = null;
          }
          if (controlScope) {
            const scope = controlScope;
            controlScope = null;
            yield* Scope.close(scope, Exit.void);
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

          if (hostRuntime) {
            yield* Effect.promise(() => hostRuntime!.dispose().catch(() => {}));
            hostRuntime = null;
            host = null;
            yield* fs.remove(paths.attach).pipe(Effect.ignore);
          }

          if (mode === "stop") {
            yield* session.remove(id);
          } else {
            yield* enqueue(
              Effect.gen(function* () {
                const cur = yield* model.get;
                const newState = { ...cur.state, attached: false, updatedAt: Date.now() };
                const result = yield* Effect.exit(
                  persist(newState).pipe(Effect.timeout(`${SHUTDOWN_SAVE_TIMEOUT_MS} millis`)),
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
          yield* Scope.close(daemonScope, Exit.void);
          yield* Deferred.succeed(closed, undefined);
          if (finalFailure !== undefined) return yield* Effect.fail(finalFailure);
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
  ): Effect.Effect<WorkspaceSnapshot, DaemonError> => {
    return transaction
      .run(value, expectedRevision, { ...context, worktreesRoot: daemonWorktreesRoot })
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
        const ws = yield* runWorkspaceCommand(
          value,
          expectedRevision ?? cur.workspace.revision,
          ctx,
        );
        return { workspace: JSON.stringify(ws) };
      }
      if (meta.target === "buffers") {
        const h = requireHost();
        switch (value._tag) {
          case "buffer.set":
            return { result: h.buffers.set(value.name, value.data) };
          case "buffer.list":
            return { result: h.buffers.list().map((buffer) => ({ ...buffer })) };
          case "buffer.show":
            return { result: new TextDecoder().decode(h.buffers.show(value.name)) };
          case "buffer.delete":
            h.buffers.delete(value.name);
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
          yield* requireHost().prompt(value.target, value.text);
          return {};
        }
        if (value._tag === "pane.capture") {
          if (!value.session) return yield* controlFail("pane.capture requires a session id");
          return { result: yield* requireHost().capture(value.session) };
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
            if (output.workspace !== undefined) {
              revision = JSON.parse(output.workspace).revision;
            }
          }
          return { outputs };
        }),
      ),

    SetBuffer: ({ name, data }) => guard(Effect.sync(() => requireHost().buffers.set(name, data))),

    PasteBuffer: ({ name, target, deleteAfter }) =>
      guard(
        Effect.gen(function* () {
          const h = requireHost();
          yield* h.paste(target, h.buffers.show(name));
          if (deleteAfter === true) h.buffers.delete(name);
        }),
      ),

    ListBuffers: () =>
      guard(
        Effect.sync(() =>
          requireHost()
            .buffers.list()
            .map((b) => ({ ...b })),
        ),
      ),

    DeleteBuffer: ({ name }) => guard(Effect.sync(() => requireHost().buffers.delete(name))),

    ShowBuffer: ({ name }) =>
      guard(Effect.sync(() => new TextDecoder().decode(requireHost().buffers.show(name)))),

    Events: () =>
      Stream.concat(
        Stream.succeed({ sequence: 0, event: { _tag: "events.ready" } } as const),
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
    host ? host.live : Effect.succeed([]);

  const setBuffer = (n: string | undefined, d: string): Effect.Effect<string, never> =>
    Effect.sync(() => requireHost().buffers.set(n, d));

  const pasteBuffer = (
    n: string | undefined,
    t: string,
    d: boolean,
  ): Effect.Effect<void, DaemonError> =>
    Effect.gen(function* () {
      const h = requireHost();
      yield* h.paste(t, h.buffers.show(n));
      if (d) h.buffers.delete(n);
    }).pipe(Effect.mapError((e) => new DaemonError({ message: describe(e) })));

  const listBuffers = (): Effect.Effect<readonly BufferEntry[], never> =>
    Effect.sync(() => requireHost().buffers.list());

  const deleteBuffer = (n: string | undefined): Effect.Effect<void, never> =>
    Effect.sync(() => requireHost().buffers.delete(n));

  const showBuffer = (n: string | undefined): Effect.Effect<string, never> =>
    Effect.sync(() => new TextDecoder().decode(requireHost().buffers.show(n)));

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
