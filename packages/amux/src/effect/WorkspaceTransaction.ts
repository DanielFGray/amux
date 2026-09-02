import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Schema as S,
  Schedule,
  Scope,
  Option,
} from "effect";
import { DaemonModel } from "./DaemonModel.ts";
import {
  applyWorkspaceCommand,
  markSessionExited,
  workspaceSession,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
  type WorkspaceSpace,
} from "../workspace.ts";
import { COMMAND_META, type AnyCommandResult, type Command } from "../commands.ts";
import type { PaneEntry } from "../read-model.ts";
import type { PersistedSession, SessionState } from "../session.ts";
import type { PreparedSession } from "./SessionSupervisor.ts";
import type { PtyError, SessionSpec } from "./SessionRegistry.ts";
import type { PermissionAnswer } from "./AttachProtocol.ts";
import type { WorktreeSpec } from "../git.ts";
import { errorMessage } from "../error-message.ts";

const describe = errorMessage;

export class WorkspaceTransactionError extends S.TaggedError<WorkspaceTransactionError>()(
  "WorkspaceTransactionError",
  { message: S.String },
) {}

const transactionError = <E>(error: E): WorkspaceTransactionError =>
  S.is(WorkspaceTransactionError)(error)
    ? error
    : new WorkspaceTransactionError({ message: describe(error) });

interface SessionOps {
  readonly prepare: (
    session: PersistedSession,
    paneId?: string,
  ) => Effect.Effect<PreparedSession, WorkspaceTransactionError>;
  readonly kill: (id: string) => Effect.Effect<void, WorkspaceTransactionError>;
  readonly write: (id: string, data: string) => Effect.Effect<void, WorkspaceTransactionError>;
  readonly prompt: (id: string, text: string) => Effect.Effect<void, WorkspaceTransactionError>;
  readonly interrupt: (
    id: string,
    reason?: string,
  ) => Effect.Effect<void, WorkspaceTransactionError>;
  readonly decide: (
    id: string,
    answer: PermissionAnswer,
  ) => Effect.Effect<void, WorkspaceTransactionError>;
  /** Each live session's leader pid, for enriching `pane.list`/`pane.current`. */
  readonly pids: Effect.Effect<ReadonlyMap<string, number>, WorkspaceTransactionError>;
}

const withPanePid = (entry: PaneEntry, pids: ReadonlyMap<string, number>): PaneEntry =>
  entry.session === undefined ? entry : { ...entry, pid: pids.get(entry.session) };

/** `pane.list`/`pane.current` answer from the pure workspace reducer, which
 *  knows nothing live — pid comes from the daemon's session registry, so it
 *  is stitched on here rather than threaded through `applyWorkspaceCommand`. */
const withPanePids = (
  tag: Command["_tag"],
  result: AnyCommandResult,
  sessionOps: SessionOps,
): Effect.Effect<AnyCommandResult, WorkspaceTransactionError> => {
  if (tag !== "pane.list" && tag !== "pane.current") return Effect.succeed(result);
  return sessionOps.pids.pipe(
    Effect.map((pids) =>
      Array.isArray(result)
        ? result.map((entry) => withPanePid(entry as PaneEntry, pids))
        : result === null
          ? result
          : withPanePid(result as PaneEntry, pids),
    ),
  );
};

interface SessionHost {
  readonly prepare: (spec: SessionSpec) => Effect.Effect<PreparedSession, PtyError>;
  readonly write: (id: string, data: string | Uint8Array) => Effect.Effect<void, PtyError>;
  readonly prompt: (id: string, text: string) => Effect.Effect<void, PtyError>;
  readonly interrupt: (id: string, reason?: string) => Effect.Effect<void, PtyError>;
  readonly decide: (id: string, answer: PermissionAnswer) => Effect.Effect<void, PtyError>;
  readonly pids: Effect.Effect<ReadonlyMap<string, number>>;
}

interface WorktreeOps {
  readonly add: (
    repo: string,
    spec: WorktreeSpec,
    path: string,
  ) => Effect.Effect<void, WorkspaceTransactionError>;
  readonly remove: (
    repo: string,
    path: string,
    force?: boolean,
  ) => Effect.Effect<void, WorkspaceTransactionError>;
  readonly isDirty: (path: string) => Effect.Effect<boolean, WorkspaceTransactionError>;
}

interface Persistence {
  readonly persist: (state: SessionState) => Effect.Effect<void, WorkspaceTransactionError>;
  readonly persistUntilSuccess: (
    state: SessionState,
    reason: string,
  ) => Effect.Effect<void, WorkspaceTransactionError>;
}

interface Events {
  readonly publishWorkspaceFrame: (snapshot: WorkspaceSnapshot) => Effect.Effect<void>;
}

interface Lifecycle {
  readonly onEmpty: Effect.Effect<void>;
}

export class WorkspaceTransactionSessionOps extends Context.Service<
  WorkspaceTransactionSessionOps,
  SessionOps
>()("WorkspaceTransaction/SessionOps") {}

export class WorkspaceTransactionWorktreeOps extends Context.Service<
  WorkspaceTransactionWorktreeOps,
  WorktreeOps
>()("WorkspaceTransaction/WorktreeOps") {}

export class WorkspaceTransactionPersistence extends Context.Service<
  WorkspaceTransactionPersistence,
  Persistence
>()("WorkspaceTransaction/Persistence") {}

export class WorkspaceTransactionEvents extends Context.Service<
  WorkspaceTransactionEvents,
  Events
>()("WorkspaceTransaction/Events") {}

export class WorkspaceTransactionLifecycle extends Context.Service<
  WorkspaceTransactionLifecycle,
  Lifecycle
>()("WorkspaceTransaction/Lifecycle") {}

export interface WorkspaceTransactionService {
  readonly run: (
    value: Command,
    expectedRevision: number,
    context: WorkspaceCommandContext,
  ) => Effect.Effect<WorkspaceTransactionResult, WorkspaceTransactionError>;
  readonly onSessionExit: (
    sid: string,
    code: number | null,
  ) => Effect.Effect<void, WorkspaceTransactionError>;
}

export interface WorkspaceTransactionResult {
  readonly snapshot: WorkspaceSnapshot;
  readonly result?: AnyCommandResult;
}

export class WorkspaceTransaction extends Context.Service<WorkspaceTransaction>()(
  "WorkspaceTransaction",
  {
    make: Effect.gen(function* () {
      const model = yield* DaemonModel;
      const sessionOps = yield* WorkspaceTransactionSessionOps;
      const worktreeOps = yield* WorkspaceTransactionWorktreeOps;
      const persistence = yield* WorkspaceTransactionPersistence;
      const events = yield* WorkspaceTransactionEvents;
      const lifecycle = yield* Effect.serviceOption(WorkspaceTransactionLifecycle);
      const closeIfEmpty = lifecycle.pipe(
        Option.match({
          onNone: () => Effect.void,
          onSome: (value) => value.onEmpty,
        }),
      );

      const exitCommits = new Map<string, (code: number | null) => Promise<void>>();

      const onSessionExit = Effect.fnUntraced(function* (sid: string, code: number | null) {
        const cur = yield* model.get;
        if (cur.closing) return;
        const commit = exitCommits.get(sid);
        if (commit) {
          exitCommits.delete(sid);
          yield* Effect.promise(() => commit(code));
          return;
        }
        yield* model.enqueue(
          Effect.gen(function* () {
            const cur2 = yield* model.get;
            if (cur2.closing) return;
            const next = markSessionExited(cur2.workspace, sid, code);
            if (next === cur2.workspace) return;
            const newState = workspaceSession(next, cur2.state);
            yield* persistence.persistUntilSuccess(newState, `natural exit for '${sid}'`);
            yield* model.commitWorkspace(next, newState);
            yield* events.publishWorkspaceFrame(next);
            if (next.spaces.length === 0) yield* closeIfEmpty;
          }),
        );
      });

      const run = (
        value: Command,
        expectedRevision: number,
        context: WorkspaceCommandContext,
      ): Effect.Effect<WorkspaceTransactionResult, WorkspaceTransactionError> =>
        model
          .enqueue(
            Effect.gen(function* () {
              const cur = yield* model.get;
              if (expectedRevision !== cur.workspace.revision) {
                return yield* new WorkspaceTransactionError({
                  message: `stale workspace revision ${expectedRevision}; current revision is ${cur.workspace.revision}`,
                });
              }
              if (COMMAND_META[value._tag].target !== "workspace") {
                return yield* new WorkspaceTransactionError({
                  message: `command '${value._tag}' is not a workspace command`,
                });
              }

              const mutation = applyWorkspaceCommand(cur.workspace, value, context);
              const candidate = workspaceSession(mutation.snapshot, cur.state);
              const worktrees = gitWorktreesFor(value, mutation.snapshot, cur.workspace);
              const prepared: PreparedSession[] = [];
              const exitsSettled = yield* Deferred.make<boolean>();
              const killed = mutation.actions.filter((a) => a._tag === "kill").map((a) => a.agent);

              for (const agentId of killed) {
                const exitRuntime = yield* Effect.context<never>();
                exitCommits.set(agentId, (code) =>
                  Effect.runPromiseWith(exitRuntime)(Deferred.await(exitsSettled)).then(
                    (settled) =>
                      settled
                        ? undefined
                        : Effect.runPromiseWith(exitRuntime)(onSessionExit(agentId, code)),
                  ),
                );
              }

              const bodyResult = yield* Effect.exit(
                Effect.gen(function* () {
                  if (worktrees.created) {
                    const spec: WorktreeSpec = {
                      branch: worktrees.created.branch,
                    };
                    if (worktrees.base) spec.base = worktrees.base;
                    yield* worktreeOps.add(worktrees.created.repo, spec, worktrees.created.path);
                  }
                  for (const a of mutation.actions) {
                    if (a._tag !== "spawn") continue;
                    if (a.agent.kind === "component") continue;
                    prepared.push(yield* sessionOps.prepare(a.agent, a.pane));
                  }
                  for (const a of mutation.actions) {
                    yield* Match.value(a).pipe(
                      Match.tag("kill", (a) => sessionOps.kill(a.agent)),
                      Match.tag("input", (a) => sessionOps.write(a.agent, a.data)),
                      Match.orElse(() => Effect.void),
                    );
                  }
                  for (const wt of worktrees.removed) {
                    const dirty = yield* worktreeOps.isDirty(wt!.path);
                    if (dirty)
                      return yield* new WorkspaceTransactionError({
                        message: `worktree '${wt!.path}' has uncommitted changes`,
                      });
                  }
                  if (mutation.changed) {
                    if (killed.length > 0) {
                      yield* persistence.persistUntilSuccess(
                        candidate,
                        "destructive workspace command",
                      );
                    } else {
                      yield* persistence.persist(candidate);
                    }
                    yield* model.commitWorkspace(mutation.snapshot, candidate);
                    yield* events.publishWorkspaceFrame(mutation.snapshot);
                    if (mutation.snapshot.spaces.length === 0) yield* closeIfEmpty;
                  }
                  for (const wt of worktrees.removed) {
                    yield* worktreeOps.remove(wt!.repo, wt!.path);
                  }
                  yield* Deferred.succeed(exitsSettled, true);
                  for (const p of prepared) yield* p.activate;
                  for (const a of mutation.actions) {
                    yield* Match.value(a).pipe(
                      Match.tag("prompt", (a) => sessionOps.prompt(a.agent, a.text)),
                      Match.tag("interrupt", (a) => sessionOps.interrupt(a.agent, a.reason)),
                      Match.tag("decide", (a) => sessionOps.decide(a.agent, a.answer)),
                      Match.orElse(() => Effect.void),
                    );
                  }
                  const final = yield* model.get;
                  const committed = {
                    snapshot: structuredClone(final.workspace),
                  };
                  if (mutation.result !== undefined) {
                    const result = yield* withPanePids(value._tag, mutation.result, sessionOps);
                    return { ...committed, result };
                  }
                  return committed;
                }),
              );

              for (const agentId of killed) exitCommits.delete(agentId);

              if (Exit.isFailure(bodyResult)) {
                const error = Cause.squash(bodyResult.cause);
                yield* Deferred.succeed(exitsSettled, false);
                for (const p of prepared) yield* p.abort.pipe(Effect.ignore);
                if (worktrees.created)
                  yield* worktreeOps
                    .remove(worktrees.created.repo, worktrees.created.path, true)
                    .pipe(Effect.ignore);
                if (S.is(WorkspaceTransactionError)(error)) return yield* error;
                return yield* new WorkspaceTransactionError({
                  message: describe(error),
                });
              }

              return bodyResult.value;
            }),
          )
          .pipe(
            Effect.mapError((e) =>
              S.is(WorkspaceTransactionError)(e)
                ? e
                : new WorkspaceTransactionError({ message: describe(e) }),
            ),
          );

      return { run, onSessionExit } satisfies WorkspaceTransactionService;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

interface GitWorktreePlan {
  created: WorkspaceSpace["worktree"] | null;
  base: string | undefined;
  removed: WorkspaceSpace["worktree"][];
}

export function gitWorktreesFor(
  value: Command,
  next: WorkspaceSnapshot,
  current: WorkspaceSnapshot,
): GitWorktreePlan {
  const none: GitWorktreePlan = {
    created: null,
    base: undefined,
    removed: [],
  };
  return Match.value(value).pipe(
    Match.tag("space.new", (value): GitWorktreePlan => {
      const created = next.spaces.find(
        (s) => s.worktree && !current.spaces.some((c) => c.id === s.id),
      );
      if (!created?.worktree) return none;
      const base = (value as { base?: string }).base?.trim() || undefined;
      return { created: created.worktree, base, removed: [] };
    }),
    Match.tag("space.close", (): GitWorktreePlan => {
      const closedIds = new Set(next.spaces.map((s) => s.id));
      const removed = current.spaces
        .filter((s) => s.worktree && !closedIds.has(s.id))
        .map((s) => s.worktree!);
      return { created: null, base: undefined, removed };
    }),
    Match.orElse(() => none),
  );
}

export const makeSessionOps = <HostError, KillError>(
  getHost: Effect.Effect<SessionHost, HostError>,
  killFn: (id: string) => Effect.Effect<void, KillError>,
): Layer.Layer<WorkspaceTransactionSessionOps> =>
  Layer.succeed(WorkspaceTransactionSessionOps, {
    prepare: (agent, paneId) =>
      getHost.pipe(
        // The transaction only prepares non-component agents, which always
        // carry a command; PersistedSession only leaves `cmd` optional because
        // component sessions do not need one.
        Effect.flatMap((host) => {
          const spec = { ...(agent as SessionSpec) };
          if (paneId) spec.paneId = paneId;
          return host.prepare(spec);
        }),
        Effect.mapError(transactionError),
      ),
    kill: (id) => killFn(id).pipe(Effect.mapError(transactionError)),
    write: (id, data) =>
      getHost.pipe(
        Effect.flatMap((host) => host.write(id, data)),
        Effect.mapError(transactionError),
      ),
    prompt: (id, text) =>
      getHost.pipe(
        Effect.flatMap((host) => host.prompt(id, text)),
        Effect.mapError(transactionError),
      ),
    interrupt: (id, reason) =>
      getHost.pipe(
        Effect.flatMap((host) => host.interrupt(id, reason)),
        Effect.mapError(transactionError),
      ),
    decide: (id, answer) =>
      getHost.pipe(
        Effect.flatMap((host) => host.decide(id, answer)),
        Effect.mapError(transactionError),
      ),
    pids: getHost.pipe(
      Effect.flatMap((host) => host.pids),
      Effect.mapError(transactionError),
    ),
  } satisfies SessionOps);

export const makeWorktreeOps: Layer.Layer<WorkspaceTransactionWorktreeOps> = Layer.succeed(
  WorkspaceTransactionWorktreeOps,
  {
    add: (repo, spec, path) =>
      Effect.tryPromise(() =>
        import("../git.ts").then((m) => m.gitWorktreeAdd(repo, spec, path)),
      ).pipe(Effect.mapError(transactionError)),
    remove: (repo, path, force = false) =>
      Effect.tryPromise(() =>
        import("../git.ts").then((m) => m.gitWorktreeRemove(repo, path, force)),
      ).pipe(Effect.mapError(transactionError)),
    isDirty: (path) =>
      Effect.tryPromise(() => import("../git.ts").then((m) => m.gitWorktreeDirty(path))).pipe(
        Effect.mapError(transactionError),
      ),
  } satisfies WorktreeOps,
);

export const makePersistence = <PersistenceError>(
  persistFn: (state: SessionState) => Effect.Effect<void, PersistenceError>,
  activeSaveRef: { current: Fiber.Fiber<void, WorkspaceTransactionError> | null },
  scope: Scope.Closeable,
): Layer.Layer<WorkspaceTransactionPersistence, never, DaemonModel> =>
  Layer.effect(
    WorkspaceTransactionPersistence,
    Effect.gen(function* () {
      const model = yield* DaemonModel;

      const persistUntilSuccess = Effect.fnUntraced(function* (
        state: SessionState,
        reason: string,
      ) {
        const obligation = yield* model.addObligation(reason);
        try {
          // Retrying is unbounded in time but not across shutdown: a daemon that
          // is closing must stop waiting for storage that is not coming back,
          // or teardown blocks on a fiber that will never settle.
          const retrySchedule = Schedule.exponential("10 millis").pipe(
            Schedule.modifyDelay(({ duration }) =>
              Effect.succeed(Duration.min(duration, Duration.seconds(1))),
            ),
            Schedule.tap(({ input: error }) =>
              model.updateObligation(
                obligation,
                `${reason} is waiting for durable storage: ${describe(error)}`,
              ),
            ),
            Schedule.while(() => Effect.map(model.isClosing, (closing) => !closing)),
          );
          const save = Effect.gen(function* () {
            if (yield* model.isClosing)
              return yield* new WorkspaceTransactionError({
                message: `daemon shut down with outstanding durable obligation: ${reason}`,
              });
            return yield* persistFn(state).pipe(Effect.mapError(transactionError));
          });
          const fiber = yield* Effect.forkIn(save.pipe(Effect.retry(retrySchedule)), scope);
          activeSaveRef.current = fiber;
          yield* Fiber.join(fiber).pipe(Effect.asVoid);
        } finally {
          activeSaveRef.current = null;
          yield* model.clearObligation(obligation);
        }
      });

      return {
        persist: (state) => persistFn(state).pipe(Effect.mapError(transactionError)),
        persistUntilSuccess,
      } satisfies Persistence;
    }),
  );

export const makeEvents = (
  publishFrame: (snapshot: WorkspaceSnapshot) => Effect.Effect<void>,
): Layer.Layer<WorkspaceTransactionEvents> =>
  Layer.succeed(WorkspaceTransactionEvents, {
    publishWorkspaceFrame: publishFrame,
  } satisfies Events);
