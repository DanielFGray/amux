import { randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Runtime,
  Schema as S,
  Scope,
  Stream,
} from "effect";
import { FileSystem, SocketServer } from "@effect/platform";
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer";
import * as RpcServer from "@effect/rpc/RpcServer";
import { ControlError, ControlRpcs, ControlSerialization } from "./control.ts";
import { AttachHost, layerAttachHost, type AttachHostService } from "./effect/AttachHost.ts";
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
  const fs = yield* FileSystem.FileSystem;

  yield* fs.makeDirectory(paths.root, { recursive: true, mode: 0o700 });

  yield* Effect.gen(function* () {
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
      const content = yield* fs.readFileString(paths.lock).pipe(Effect.orElseSucceed(() => "0"));
      const owner = Number.parseInt(content, 10);
      if (processAlive(owner))
        return yield* new DaemonError({ message: `session '${id}' is already being opened` });
      const lease = yield* session.readLease(id);
      if (lease && processAlive(lease.pid))
        return yield* new DaemonError({
          message: `session '${id}' is already owned by pid ${lease.pid}`,
        });
      yield* fs.remove(paths.lock, { recursive: true });
    }
  }).pipe(
    Effect.mapError((e) =>
      e instanceof DaemonError ? e : new DaemonError({ message: describe(e) }),
    ),
  );

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
      .attach(client, connection, persist, (event) =>
        eventBus.publish(event).pipe(Effect.catchAllCause(() => Effect.void)),
      )
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
    model.detach(
      client,
      connection,
      (newState) => persistence.persistUntilSuccess(newState, "attachment detach"),
      (event) => eventBus.publish(event).pipe(Effect.catchAllCause(() => Effect.void)),
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
          onEmpty: Effect.suspend(() => closeWhenEmpty),
        }),
      ),
      Layer.provide(
        makeEvents(
          (event) => eventBus.publish(event as any).pipe(Effect.catchAllCause(() => Effect.void)),
          (snapshot) =>
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
    yield* eventBus.publish({ _tag: "pane.exited", session: sid, code });
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
  let closeWhenEmpty: Effect.Effect<void> = Effect.void;

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
        controlPath: paths.control,
        rpcPath: paths.socket,
        daemonSession: id,
        onAttach: attachEffect,
        onDetach: detachEffect,
        onActivity: touchEffect,
        onSessionExit: (sid, code) => sessionExitEffect(sid, code),
        onAgentState: (sid, state) =>
          eventBus.publish({ _tag: "agent.state", session: sid, state }),
        onAgentFrame: (sid, frame) =>
          eventBus.publish({ _tag: "agent.frame", session: sid, frame }),
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
              id: a.id,
              cmd: a.cmd,
              cwd: a.cwd,
              rpcPath: paths.socket,
              daemonSession: id,
              cols: a.cols,
              rows: a.rows,
            }).pipe(
              Effect.catchAll(() => {
                next = markSessionExited(next, a.id, null);
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
          yield* fs.remove(paths.lock).pipe(Effect.ignore);
          yield* Scope.close(daemonScope, Exit.void);
          if (finalFailure !== undefined) return yield* Effect.fail(finalFailure);
        }),
      );
      yield* Effect.promise(() => terminationShared!);
    },
    Effect.mapError((e) => new DaemonError({ message: describe(e) })),
  );

  const stop = terminate("stop");
  const close = terminate("close");
  closeWhenEmpty = Effect.forkDaemon(close).pipe(Effect.asVoid);

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
        Effect.forkDaemon(Effect.provideService(stop, SessionStore, session).pipe(Effect.ignore)).pipe(
          Effect.asVoid,
        ),
      ),

    WorkspaceCommand: ({ value, expectedRevision, context }) =>
      guard(
        Effect.gen(function* () {
          const cur = yield* model.get;
          const ctx = yield* parseWorkspaceCommandContext(context, cur.workspace);
          const ws = yield* runWorkspaceCommand(value, expectedRevision, ctx);
          return JSON.stringify(ws);
        }),
      ),

    Run: ({ value, expectedRevision, context }) =>
      guard(
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
                return { result: h.buffers.list().map((b) => ({ ...b })) };
              case "buffer.show":
                return { result: new TextDecoder().decode(h.buffers.show(value.name)) };
              case "buffer.delete":
                h.buffers.delete(value.name);
                return {};
            }
            return yield* controlFail(`buffer command '${value._tag}' is not implemented for run`);
          }
          if (meta.target === "server") {
            if (value._tag === "app.quit") {
              yield* Effect.forkDaemon(
                Effect.provideService(stop, SessionStore, session).pipe(Effect.ignore),
              );
              return {};
            }
            return yield* controlFail(`server command '${value._tag}' is not implemented for run`);
          }
          if (meta.target === "session") {
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
            return yield* controlFail(`session command '${value._tag}' is not implemented for run`);
          }
          return yield* controlFail("session commands are not yet implemented for run");
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
