import { homedir } from "node:os";
import path from "node:path";
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
  Queue,
  Ref,
  Schema as S,
  Scope,
} from "effect";
import { FileSystem, SocketServer } from "@effect/platform";
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer";
import * as RpcServer from "@effect/rpc/RpcServer";
import { ControlError, ControlRpcs, ControlSerialization } from "./control.ts";
import { AttachHost, layerAttachHost, type AttachHostService } from "./effect/AttachHost.ts";
import { type PreparedSession } from "./effect/SessionSupervisor.ts";
import type { AttachServerError } from "./effect/AttachServer.ts";
import type { BufferEntry } from "./effect/BufferStore.ts";
import type { ManagedSession, SessionSpec } from "./effect/SessionRegistry.ts";
import {
  isSessionId,
  processAlive,
  Session,
  SessionEnv,
  sessionPaths,
  type SessionAttachment,
  type SessionLease,
  type SessionState,
  type SessionPaths,
} from "./session.ts";
import { command, COMMAND_META, decodeCommand, type Command } from "./commands.ts";
import {
  applyWorkspaceCommand,
  markAgentExited,
  parseWorkspaceCommandContext,
  workspaceFromSession,
  workspaceSession,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
  type WorkspaceSpace,
} from "./workspace.ts";
import {
  gitWorktreeAdd,
  gitWorktreeDirty,
  gitWorktreeExists,
  gitWorktreeRemove,
  type WorktreeSpec,
} from "./git.ts";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class SessionDaemonError extends S.TaggedError<SessionDaemonError>()("SessionDaemonError", {
  message: S.String,
}) {}

export class DaemonError extends S.TaggedError<DaemonError>()("DaemonError", {
  message: S.String,
}) {}

export interface SessionDaemonOptions {
  readonly saveState?: (state: SessionState) => Effect.Effect<void, unknown, Session>;
  readonly spawnAgent?: (spec: SessionSpec) => Effect.Effect<ManagedSession, unknown>;
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
  readonly spawnAgent: (spec: SessionSpec) => Effect.Effect<ManagedSession, DaemonError>;
  readonly killAgent: (id: string) => Effect.Effect<void, DaemonError>;
  readonly liveAgents: () => Effect.Effect<readonly string[], never>;
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

interface DaemonState {
  state: SessionState;
  workspace: WorkspaceSnapshot;
  attachments: Map<string, SessionAttachment>;
  heartbeatError: string | null;
  durableObligations: Map<symbol, string>;
  closing: boolean;
  cancelPersistence: boolean;
}

type Mutation = { effect: Effect.Effect<any, any, never>; done: Deferred.Deferred<any, any> };

function gitWorktreesFor(value: Command, next: WorkspaceSnapshot, current: WorkspaceSnapshot) {
  const none = { created: null, base: undefined, removed: [] as WorkspaceSpace["worktree"][] };
  if (value._tag === "space.new") {
    const created = next.spaces.find(
      (s) => s.worktree && !current.spaces.some((c) => c.id === s.id),
    );
    if (created?.worktree) {
      const base = (value as { base?: string }).base?.trim() || undefined;
      return { created: created.worktree, base, removed: [] as WorkspaceSpace["worktree"][] };
    }
    return none;
  }
  if (value._tag === "space.close") {
    const closedIds = new Set(next.spaces.map((s) => s.id));
    const removed = current.spaces
      .filter((s) => s.worktree && !closedIds.has(s.id))
      .map((s) => s.worktree!);
    return { created: null, base: undefined, removed };
  }
  return none;
}

const persistUntilSuccess = Effect.fnUntraced(function* (
  persistFn: (state: SessionState) => Effect.Effect<void, unknown>,
  daemonRef: Ref.Ref<DaemonState>,
  state: SessionState,
  reason: string,
  activeRef: { current: Fiber.RuntimeFiber<void, unknown> | null },
  scope: Scope.CloseableScope,
) {
  const obligation = Symbol(reason);
  yield* Ref.update(daemonRef, (s) => {
    s.durableObligations.set(obligation, `${reason} is waiting for durable storage`);
    return s;
  });
  let delay = 10;
  try {
    for (;;) {
      const cur = yield* Ref.get(daemonRef);
      if (cur.closing)
        throw new Error(`daemon shut down with outstanding durable obligation: ${reason}`);
      const result = yield* Effect.either(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(
            persistFn(state).pipe(Effect.mapError((e) => new Error(describe(e)))),
            scope,
          );
          activeRef.current = fiber;
          const value = yield* Fiber.join(fiber);
          activeRef.current = null;
          return value;
        }),
      );
      if (Either.isRight(result)) return;
      {
        const error = result.left;
        activeRef.current = null;
        yield* Ref.update(daemonRef, (s) => {
          s.durableObligations.set(
            obligation,
            `${reason} is waiting for durable storage: ${describe(error)}`,
          );
          return s;
        });
        if ((yield* Ref.get(daemonRef)).closing) throw error;
        yield* Effect.raceFirst(Effect.sleep(`${delay} millis`), Effect.never);
        delay = Math.min(delay * 2, 1_000);
      }
    }
  } finally {
    yield* Ref.update(daemonRef, (s) => {
      s.durableObligations.delete(obligation);
      return s;
    });
  }
});

export const makeDaemonService = Effect.fnUntraced(function* (
  id: string,
  options: SessionDaemonOptions,
) {
  if (!isSessionId(id))
    return yield* new SessionDaemonError({ message: `invalid session id ${JSON.stringify(id)}` });

  const env = yield* SessionEnv;
  const paths = yield* sessionPaths(id);
  const session = yield* Session;
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
  const workspace = workspaceFromSession(state);

  const daemonState = yield* Ref.make<DaemonState>({
    state,
    workspace,
    attachments: new Map(),
    heartbeatError: null,
    durableObligations: new Map(),
    closing: false,
    cancelPersistence: false,
  });

  const daemonScope = yield* Scope.make();
  const mutationQueue = Effect.runSync(Queue.unbounded<Mutation>());
  yield* Effect.forkIn(
    Effect.forever(
      Queue.take(mutationQueue).pipe(
        Effect.flatMap((m) =>
          Effect.exit(m.effect).pipe(Effect.flatMap((e) => Deferred.done(m.done, e))),
        ),
      ),
    ),
    daemonScope,
  );

  /** Holds the control-plane RPC server; its presence means `start` ran. */
  let controlScope: Scope.CloseableScope | null = null;
  let hostRuntime: ManagedRuntime.ManagedRuntime<AttachHost, AttachServerError> | null = null;
  let host: AttachHostService | null = null;
  let heartbeatFiber: Fiber.RuntimeFiber<unknown, never> | null = null;
  const activeSaveRef = { current: null as Fiber.RuntimeFiber<void, unknown> | null };
  const exitCommits = new Map<string, (code: number | null) => Promise<void>>();
  let terminationShared: Promise<void> | null = null;

  const requireHost = () => {
    if (!host) throw new Error("daemon not started");
    return host;
  };

  const persist = options.saveState
    ? (s: SessionState) => options.saveState!(s).pipe(Effect.provideService(Session, session))
    : (s: SessionState) => session.save(s);

  const attachInfo = (): Pick<SessionLease, "attachedSince" | "attachLastSeen" | "attachments"> => {
    const s = Effect.runSync(Ref.get(daemonState));
    const atts = [...s.attachments.values()];
    if (!atts.length) return {};
    return {
      attachedSince: Math.min(...atts.map((a) => a.attachedSince)),
      attachLastSeen: Math.max(...atts.map((a) => a.attachLastSeen)),
      attachments: atts.map((a) => ({ ...a })),
    };
  };

  /** The lease carries per-attachment detail; the control plane only reports times. */
  const attachTimes = (): { attachedSince?: number; attachLastSeen?: number } => {
    const { attachedSince, attachLastSeen } = attachInfo();
    return {
      ...(attachedSince !== undefined ? { attachedSince } : {}),
      ...(attachLastSeen !== undefined ? { attachLastSeen } : {}),
    };
  };

  const enqueue = <A, E>(effect: Effect.Effect<A, E, never>): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<A, E>();
      yield* Queue.offer(mutationQueue, {
        effect: effect as Effect.Effect<any, any, never>,
        done: done as Deferred.Deferred<any, any>,
      });
      return yield* Deferred.await(done);
    });

  const attachEffect = Effect.fnUntraced(function* (client: string, connection: string) {
    const cur = yield* Ref.get(daemonState);
    if (cur.attachments.has(connection))
      return yield* new DaemonError({ message: "attachment already registered" });
    const now = Date.now();
    const attachments = new Map(cur.attachments);
    attachments.set(connection, { client, attachedSince: now, attachLastSeen: now });
    const newState = { ...cur.state, attached: true, updatedAt: now };
    yield* persist(newState).pipe(
      Effect.mapError((e) => new DaemonError({ message: describe(e) })),
    );
    yield* Ref.set(daemonState, { ...cur, attachments, state: newState });
  }, enqueue);

  const detachEffect = Effect.fnUntraced(function* (client: string, connection: string) {
    const cur = yield* Ref.get(daemonState);
    const att = cur.attachments.get(connection);
    if (!att || att.client !== client) return;
    const attachments = new Map(cur.attachments);
    attachments.delete(connection);
    const newState = { ...cur.state, attached: attachments.size > 0, updatedAt: Date.now() };
    yield* persistUntilSuccess(
      persist,
      daemonState,
      newState,
      "attachment detach",
      activeSaveRef,
      daemonScope,
    );
    yield* Ref.set(daemonState, { ...cur, attachments, state: newState });
  }, enqueue);

  const touchEffect = (client: string, connection: string) =>
    Ref.modify(daemonState, (cur) => {
      const att = cur.attachments.get(connection);
      if (att?.client === client) {
        const attachments = new Map(cur.attachments);
        attachments.set(connection, { ...att, attachLastSeen: Date.now() });
        return [undefined as void, { ...cur, attachments }];
      }
      return [undefined as void, cur];
    });

  const sessionExitEffect = Effect.fnUntraced(function* (sid: string, code: number | null) {
    const cur = yield* Ref.get(daemonState);
    if (cur.closing) return;
    const commit = exitCommits.get(sid);
    if (commit) {
      exitCommits.delete(sid);
      yield* Effect.promise(() => commit(code));
      return;
    }
    yield* enqueue(
      Effect.gen(function* () {
        const cur2 = yield* Ref.get(daemonState);
        if (cur2.closing) return;
        const next = markAgentExited(cur2.workspace, sid, code);
        if (next === cur2.workspace) return;
        const newState = workspaceSession(next, cur2.state);
        yield* persistUntilSuccess(
          persist,
          daemonState,
          newState,
          `natural exit for '${sid}'`,
          activeSaveRef,
          daemonScope,
        );
        yield* Ref.set(daemonState, { ...cur2, workspace: next, state: newState });
        if (host)
          yield* host
            .publish({
              _tag: "workspace",
              revision: next.revision,
              state: JSON.stringify(next),
            })
            .pipe(Effect.ignore);
      }),
    );
  });

  let spawnAgent = (spec: SessionSpec): Effect.Effect<ManagedSession, DaemonError> =>
    (options.spawnAgent ? options.spawnAgent(spec) : requireHost().spawn(spec)).pipe(
      Effect.mapError((e) => new DaemonError({ message: describe(e) })),
    );
  let killAgent = (agentId: string): Effect.Effect<void, DaemonError> =>
    requireHost()
      .kill(agentId)
      .pipe(Effect.mapError((e) => new DaemonError({ message: describe(e) })));

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
      const cur = yield* Ref.get(daemonState);
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
        onAttach: attachEffect,
        onDetach: detachEffect,
        onActivity: touchEffect,
        onSessionExit: (sid, code) =>
          sessionExitEffect(sid, code).pipe(Effect.catchAll((e) => Effect.die(e))),
      }),
    );
    hostRuntime = rt;
    host = yield* Effect.promise(() => rt.runPromise(AttachHost));

    yield* Effect.gen(function* () {
      const cur = yield* Ref.get(daemonState);
      let next = cur.workspace;
      let changed = false;
      for (const space of next.spaces) {
        if (space.worktree) {
          const exists = yield* Effect.promise(() => gitWorktreeExists(space.worktree!.path));
          if (!exists) {
            for (const w of space.windows)
              for (const a of w.agents) {
                if (!a.exited) {
                  next = markAgentExited(next, a.id, null);
                  changed = true;
                }
              }
            continue;
          }
        }
        for (const w of space.windows) {
          for (const a of w.agents) {
            if (a.exited) continue;
            yield* spawnAgent(a).pipe(
              Effect.catchAll(() => {
                next = markAgentExited(next, a.id, null);
                changed = true;
                return Effect.void;
              }),
            );
          }
        }
      }
      const newState = workspaceSession(next, cur.state);
      if (changed) yield* persist(newState);
      yield* Ref.set(daemonState, { ...cur, workspace: next, state: newState });
    }).pipe(enqueue);

    const cur = Effect.runSync(Ref.get(daemonState));
    if (cur.workspace.spaces.length === 0) {
      yield* runWorkspaceCommand(command("space.new"), cur.workspace.revision, {
        size: { cols: 80, rows: 24 },
        shell: [env.SHELL || "bash"],
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
                const info = attachInfo();
                const hbAt = yield* Clock.currentTimeMillis;
                yield* session.writeLease({ ...lease, heartbeatAt: hbAt, ...info });
                yield* Ref.update(daemonState, (s) => ({ ...s, heartbeatError: null }));
              }),
            ),
          ),
          Effect.catchAllCause((c) =>
            Cause.isInterruptedOnly(c)
              ? Effect.interrupt
              : Ref.update(daemonState, (s) => ({
                  ...s,
                  heartbeatError: `lease heartbeat failed: ${Cause.pretty(c)}`,
                })),
          ),
        ),
      ),
      daemonScope,
    );
  }).pipe(Effect.mapError((e) => new DaemonError({ message: describe(e) })));

  const terminate = Effect.fnUntraced(
    function* (mode: "stop" | "close") {
      if (terminationShared) return;
      yield* Ref.update(daemonState, (s) => ({ ...s, closing: true }));
      terminationShared = Effect.runPromise(
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
            yield* Ref.update(daemonState, (s) => ({ ...s, cancelPersistence: true }));
            if (activeSaveRef.current)
              yield* Effect.promise(() =>
                Effect.runPromise(Fiber.interrupt(activeSaveRef.current!)).catch(() => {}),
              );
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
                const cur = yield* Ref.get(daemonState);
                const newState = { ...cur.state, attached: false, updatedAt: Date.now() };
                const result = yield* Effect.exit(
                  persist(newState).pipe(Effect.timeout(`${SHUTDOWN_SAVE_TIMEOUT_MS} millis`)),
                );
                if (Exit.isFailure(result)) finalFailure = Cause.squash(result.cause);
                yield* Ref.set(daemonState, { ...cur, state: newState, attachments: new Map() });
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

  const runWorkspaceCommand = (
    value: Command,
    expectedRevision: number,
    context: WorkspaceCommandContext,
  ): Effect.Effect<WorkspaceSnapshot, DaemonError> =>
    enqueue(
      Effect.gen(function* () {
        const cur = yield* Ref.get(daemonState);
        if (expectedRevision !== cur.workspace.revision) {
          return yield* new DaemonError({
            message: `stale workspace revision ${expectedRevision}; current revision is ${cur.workspace.revision}`,
          });
        }
        context = {
          ...context,
          worktreesRoot: path.join(
            env.XDG_STATE_HOME || path.join(env.HOME || homedir(), ".local", "state"),
            "amux",
            "worktrees",
          ),
        };
        if (COMMAND_META[value._tag].target !== "workspace") {
          return yield* new DaemonError({
            message: `command '${value._tag}' is not a workspace command`,
          });
        }
        const mutation = applyWorkspaceCommand(cur.workspace, value, context);
        const candidate = workspaceSession(mutation.snapshot, cur.state);
        const worktrees = gitWorktreesFor(value, mutation.snapshot, cur.workspace);
        const prepared: PreparedSession[] = [];
        const exitsSettled = Effect.runSync(Deferred.make<boolean>());
        const killed = mutation.actions.filter((a) => a._tag === "kill").map((a) => a.agent);
        let createdWt = false;

        try {
          if (worktrees.created) {
            const spec: WorktreeSpec = {
              branch: worktrees.created.branch,
              ...(worktrees.base ? { base: worktrees.base } : {}),
            };
            yield* Effect.promise(() =>
              gitWorktreeAdd(worktrees.created!.repo, spec, worktrees.created!.path),
            );
            createdWt = true;
          }
          for (const a of mutation.actions) {
            if (a._tag !== "spawn") continue;
            prepared.push(yield* requireHost().prepare(a.agent));
          }
          for (const agentId of killed) {
            exitCommits.set(agentId, async (code) => {
              if (!(await Effect.runPromise(Deferred.await(exitsSettled)))) {
                await Effect.runPromise(
                  sessionExitEffect(agentId, code).pipe(Effect.catchAll(() => Effect.void)),
                );
              }
            });
          }
          for (const a of mutation.actions) {
            if (a._tag === "kill") {
              const result = killAgent(a.agent) as unknown;
              yield* Effect.isEffect(result)
                ? (result as Effect.Effect<void, DaemonError, never>)
                : Effect.promise(() => Promise.resolve(result as void));
            }
            if (a._tag === "input") yield* requireHost().write(a.agent, a.data);
          }
          for (const wt of worktrees.removed) {
            const dirty = yield* Effect.promise(() => gitWorktreeDirty(wt!.path));
            if (dirty)
              return yield* new DaemonError({
                message: `worktree '${wt!.path}' has uncommitted changes`,
              });
          }
          if (mutation.changed) {
            if (killed.length > 0) {
              yield* persistUntilSuccess(
                persist,
                daemonState,
                candidate,
                "destructive workspace command",
                activeSaveRef,
                daemonScope,
              );
            } else {
              yield* persist(candidate);
            }
            yield* Ref.set(daemonState, {
              ...cur,
              workspace: mutation.snapshot,
              state: candidate,
            });
            yield* requireHost()
              .publish({
                _tag: "workspace",
                revision: mutation.snapshot.revision,
                state: JSON.stringify(mutation.snapshot),
              })
              .pipe(Effect.ignore);
          }
          for (const wt of worktrees.removed) {
            yield* Effect.promise(() => gitWorktreeRemove(wt!.repo, wt!.path));
          }
          Effect.runSync(Deferred.succeed(exitsSettled, true));
          for (const p of prepared) yield* p.activate;
          const final = yield* Ref.get(daemonState);
          return structuredClone(final.workspace);
        } catch (error) {
          Effect.runSync(Deferred.succeed(exitsSettled, false));
          for (const p of prepared) yield* p.abort.pipe(Effect.ignore);
          if (createdWt && worktrees.created)
            yield* Effect.promise(() =>
              gitWorktreeRemove(worktrees.created!.repo, worktrees.created!.path, true).catch(
                () => {},
              ),
            );
          if (error instanceof DaemonError) return yield* error;
          return yield* new DaemonError({ message: describe(error) });
        } finally {
          for (const agentId of killed) exitCommits.delete(agentId);
        }
      }) as Effect.Effect<WorkspaceSnapshot, DaemonError, never>,
    ).pipe(Effect.mapError((e) => new DaemonError({ message: describe(e) })));

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
          const cur = yield* Ref.get(daemonState);
          return { attached: cur.state.attached, ...attachTimes() };
        }),
      ),

    Status: () =>
      guard(
        Effect.gen(function* () {
          const cur = yield* Ref.get(daemonState);
          const obligation = cur.durableObligations.values().next().value as string | undefined;
          const degraded = obligation ?? cur.heartbeatError ?? undefined;
          const live = yield* liveAgents();
          return {
            attached: cur.state.attached,
            ...attachTimes(),
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
        Effect.forkDaemon(Effect.provideService(stop, Session, session).pipe(Effect.ignore)).pipe(
          Effect.asVoid,
        ),
      ),

    WorkspaceCommand: ({ value, expectedRevision, context }) =>
      guard(
        Effect.gen(function* () {
          const cur = yield* Ref.get(daemonState);
          const ctx = parseWorkspaceCommandContext(context, cur.workspace);
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
            const cur = yield* Ref.get(daemonState);
            const ctx = parseWorkspaceCommandContext(context ?? {}, cur.workspace);
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
                Effect.provideService(stop, Session, session).pipe(Effect.ignore),
              );
              return {};
            }
            return yield* controlFail(`server command '${value._tag}' is not implemented for run`);
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
  });

  const spawnAgentService = spawnAgent;

  const liveAgents = (): Effect.Effect<readonly string[], never> =>
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
    spawnAgent: spawnAgentService,
    get killAgent() {
      return killAgent;
    },
    set killAgent(value) {
      killAgent = value;
    },
    liveAgents,
    setBuffer,
    pasteBuffer,
    listBuffers,
    deleteBuffer,
    showBuffer,
    getState: Ref.get(daemonState).pipe(Effect.map((s) => structuredClone(s.state))),
    getWorkspace: Ref.get(daemonState).pipe(Effect.map((s) => structuredClone(s.workspace))),
    getAttachedClients: Ref.get(daemonState).pipe(
      Effect.map((s) => [...s.attachments.values()].map((a) => a.client)),
    ),
    getAttachedClient: Ref.get(daemonState).pipe(
      Effect.map((s) => s.attachments.values().next().value?.client ?? null),
    ),
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
