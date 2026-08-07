import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Runtime,
  Schema as S,
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
import { COMMAND_META, type Command } from "../commands.ts";
import type { PersistedSession, SessionState } from "../session.ts";
import type { PreparedSession } from "./SessionSupervisor.ts";
import type { WorktreeSpec } from "../git.ts";
import { layoutPanes } from "../layout.ts";
import { errorMessage } from "../error-message.ts";

const describe = errorMessage;

export class WorkspaceTransactionError extends S.TaggedError<WorkspaceTransactionError>()(
  "WorkspaceTransactionError",
  { message: S.String },
) {}

interface SessionOps {
  readonly prepare: (session: PersistedSession) => Effect.Effect<PreparedSession>;
  readonly kill: (id: string) => Effect.Effect<void>;
  readonly write: (id: string, data: string) => Effect.Effect<void>;
  readonly interrupt: (id: string, reason?: string) => Effect.Effect<void>;
}

interface WorktreeOps {
  readonly add: (repo: string, spec: WorktreeSpec, path: string) => Effect.Effect<void>;
  readonly remove: (repo: string, path: string, force?: boolean) => Effect.Effect<void>;
  readonly isDirty: (path: string) => Effect.Effect<boolean>;
}

interface Persistence {
  readonly persist: (state: SessionState) => Effect.Effect<void>;
  readonly persistUntilSuccess: (state: SessionState, reason: string) => Effect.Effect<void>;
}

interface Events {
  readonly publishWorkspaceEvents: (
    before: WorkspaceSnapshot,
    after: WorkspaceSnapshot,
  ) => Effect.Effect<void>;
  readonly publishWorkspaceFrame: (snapshot: WorkspaceSnapshot) => Effect.Effect<void>;
}

interface Lifecycle {
  readonly onEmpty: Effect.Effect<void>;
}

export class WorkspaceTransactionSessionOps extends Context.Tag("WorkspaceTransaction/SessionOps")<
  WorkspaceTransactionSessionOps,
  SessionOps
>() {}

export class WorkspaceTransactionWorktreeOps extends Context.Tag(
  "WorkspaceTransaction/WorktreeOps",
)<WorkspaceTransactionWorktreeOps, WorktreeOps>() {}

export class WorkspaceTransactionPersistence extends Context.Tag(
  "WorkspaceTransaction/Persistence",
)<WorkspaceTransactionPersistence, Persistence>() {}

export class WorkspaceTransactionEvents extends Context.Tag("WorkspaceTransaction/Events")<
  WorkspaceTransactionEvents,
  Events
>() {}

export class WorkspaceTransactionLifecycle extends Context.Tag("WorkspaceTransaction/Lifecycle")<
  WorkspaceTransactionLifecycle,
  Lifecycle
>() {}

export interface WorkspaceTransactionService {
  readonly run: (
    value: Command,
    expectedRevision: number,
    context: WorkspaceCommandContext,
  ) => Effect.Effect<WorkspaceSnapshot, WorkspaceTransactionError>;
  readonly onSessionExit: (
    sid: string,
    code: number | null,
  ) => Effect.Effect<void, WorkspaceTransactionError>;
}

export class WorkspaceTransaction extends Effect.Service<WorkspaceTransaction>()(
  "WorkspaceTransaction",
  {
    scoped: Effect.gen(function* () {
      const model = yield* DaemonModel;
      const sessionOps = yield* WorkspaceTransactionSessionOps;
      const worktreeOps = yield* WorkspaceTransactionWorktreeOps;
      const persistence = yield* WorkspaceTransactionPersistence;
      const events = yield* WorkspaceTransactionEvents;
      const lifecycle = yield* Effect.serviceOption(WorkspaceTransactionLifecycle);
      const closeIfEmpty = lifecycle.pipe(
        Option.match({ onNone: () => Effect.void, onSome: (value) => value.onEmpty }),
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
      ): Effect.Effect<WorkspaceSnapshot, WorkspaceTransactionError> =>
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
                const exitRuntime = yield* Effect.runtime<never>();
                exitCommits.set(agentId, async (code) => {
                  if (!(await Runtime.runPromise(exitRuntime)(Deferred.await(exitsSettled)))) {
                    await Runtime.runPromise(exitRuntime)(onSessionExit(agentId, code));
                  }
                });
              }

              const bodyResult = yield* Effect.exit(
                Effect.gen(function* () {
                  if (worktrees.created) {
                    const spec: WorktreeSpec = {
                      branch: worktrees.created.branch,
                      ...(worktrees.base ? { base: worktrees.base } : {}),
                    };
                    yield* worktreeOps.add(worktrees.created.repo, spec, worktrees.created.path);
                  }
                  for (const a of mutation.actions) {
                    if (a._tag !== "spawn") continue;
                    prepared.push(yield* sessionOps.prepare(a.agent));
                  }
                  for (const a of mutation.actions) {
                    if (a._tag === "kill") yield* sessionOps.kill(a.agent);
                    if (a._tag === "input") yield* sessionOps.write(a.agent, a.data);
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
                    yield* events.publishWorkspaceEvents(cur.workspace, mutation.snapshot);
                    yield* events.publishWorkspaceFrame(mutation.snapshot);
                    if (mutation.snapshot.spaces.length === 0) yield* closeIfEmpty;
                  }
                  for (const wt of worktrees.removed) {
                    yield* worktreeOps.remove(wt!.repo, wt!.path);
                  }
                  yield* Deferred.succeed(exitsSettled, true);
                  for (const p of prepared) yield* p.activate;
                  for (const a of mutation.actions) {
                    if (a._tag === "steer") yield* sessionOps.write(a.agent, a.message);
                    if (a._tag === "interrupt") yield* sessionOps.interrupt(a.agent, a.reason);
                  }
                  const final = yield* model.get;
                  return structuredClone(final.workspace);
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
                if (error instanceof WorkspaceTransactionError) return yield* error;
                return yield* new WorkspaceTransactionError({
                  message: describe(error),
                });
              }

              return bodyResult.value;
            }),
          )
          .pipe(
            Effect.mapError((e) =>
              e instanceof WorkspaceTransactionError
                ? e
                : new WorkspaceTransactionError({ message: describe(e) }),
            ),
          );

      return { run, onSessionExit } satisfies WorkspaceTransactionService;
    }),
  },
) {}

export function gitWorktreesFor(
  value: Command,
  next: WorkspaceSnapshot,
  current: WorkspaceSnapshot,
): {
  created: WorkspaceSpace["worktree"] | null;
  base: string | undefined;
  removed: WorkspaceSpace["worktree"][];
} {
  const none = {
    created: null as WorkspaceSpace["worktree"] | null,
    base: undefined as string | undefined,
    removed: [] as WorkspaceSpace["worktree"][],
  };
  if (value._tag === "space.new") {
    const created = next.spaces.find(
      (s) => s.worktree && !current.spaces.some((c) => c.id === s.id),
    );
    if (created?.worktree) {
      const base = (value as { base?: string }).base?.trim() || undefined;
      return { created: created.worktree, base, removed: [] };
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

export function publishWorkspaceEventsEffect(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  publish: (event: { _tag: string; [key: string]: unknown }) => Effect.Effect<void>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const beforeSpaces = new Map(before.spaces.map((space) => [space.id, space]));
    const afterSpaces = new Map(after.spaces.map((space) => [space.id, space]));
    for (const space of after.spaces) {
      const oldSpace = beforeSpaces.get(space.id);
      if (!oldSpace) {
        yield* publish({ _tag: "space.changed", space: space.id, change: "created" });
      } else if (oldSpace.name !== space.name) {
        yield* publish({ _tag: "space.changed", space: space.id, change: "renamed" });
      }
      const oldWindows = new Map(oldSpace?.windows.map((window) => [window.number, window]) ?? []);
      for (const window of space.windows) {
        const oldWindow = oldWindows.get(window.number);
        if (!oldWindow)
          yield* publish({
            _tag: "window.changed",
            space: space.id,
            window: window.number,
            change: "created",
          });
        else if (oldWindow.name !== window.name)
          yield* publish({
            _tag: "window.changed",
            space: space.id,
            window: window.number,
            change: "renamed",
          });
      }
      for (const window of oldSpace?.windows ?? []) {
        if (!space.windows.some((current) => current.number === window.number))
          yield* publish({
            _tag: "window.changed",
            space: space.id,
            window: window.number,
            change: "closed",
          });
      }
    }
    for (const space of before.spaces) {
      if (!afterSpaces.has(space.id))
        yield* publish({ _tag: "space.changed", space: space.id, change: "closed" });
    }
    for (const space of after.spaces)
      for (const window of space.windows)
        for (const pane of window.layout.root ? layoutPanes(window.layout.root) : [])
          if (
            !beforeSpaces
              .get(space.id)
              ?.windows.some((oldWindow) =>
                layoutPanes(oldWindow.layout.root).some((oldPane) => oldPane.id === pane.id),
              )
          )
            yield* publish({ _tag: "pane.opened", pane: pane.id, session: pane.agent });
  });
}

export const makeSessionOps = (
  hostRef: { current: { prepare: any; write: any; interrupt: any } | null },
  killFn: (id: string) => Effect.Effect<void, unknown>,
): Layer.Layer<WorkspaceTransactionSessionOps> =>
  Layer.succeed(WorkspaceTransactionSessionOps, {
    prepare: (agent) =>
      Effect.suspend(() =>
        hostRef.current
          ? hostRef.current.prepare(agent).pipe(Effect.orDie)
          : Effect.die(new Error("host not started")),
      ),
    kill: (id) => killFn(id).pipe(Effect.orDie),
    write: (id, data) =>
      Effect.suspend(() =>
        hostRef.current
          ? hostRef.current.write(id, data).pipe(Effect.orDie)
          : Effect.die(new Error("host not started")),
      ),
    interrupt: (id, reason) =>
      Effect.suspend(() =>
        hostRef.current
          ? hostRef.current.interrupt(id, reason).pipe(Effect.orDie)
          : Effect.die(new Error("host not started")),
      ),
  } satisfies SessionOps);

export const makeWorktreeOps = (): Layer.Layer<WorkspaceTransactionWorktreeOps> =>
  Layer.succeed(WorkspaceTransactionWorktreeOps, {
    add: (repo, spec, path) =>
      Effect.tryPromise(() =>
        import("../git.ts").then((m) => m.gitWorktreeAdd(repo, spec, path)),
      ).pipe(Effect.orDie),
    remove: (repo, path, force = false) =>
      Effect.tryPromise(() =>
        import("../git.ts").then((m) => m.gitWorktreeRemove(repo, path, force)),
      ).pipe(Effect.orDie),
    isDirty: (path) =>
      Effect.tryPromise(() => import("../git.ts").then((m) => m.gitWorktreeDirty(path))).pipe(
        Effect.orDie,
      ),
  } satisfies WorktreeOps);

export const makePersistence = (
  persistFn: (state: SessionState) => Effect.Effect<void, unknown>,
  activeSaveRef: { current: Fiber.RuntimeFiber<void, unknown> | null },
  scope: Scope.CloseableScope,
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
        let delay = 10;
        try {
          for (;;) {
            if (yield* model.isClosing)
              throw new WorkspaceTransactionError({
                message: `daemon shut down with outstanding durable obligation: ${reason}`,
              });
            const result = yield* Effect.exit(
              Effect.gen(function* () {
                const fiber = yield* Effect.forkIn(
                  persistFn(state).pipe(
                    Effect.mapError((e) => new WorkspaceTransactionError({ message: describe(e) })),
                  ),
                  scope,
                );
                activeSaveRef.current = fiber;
                const value = yield* Fiber.join(fiber);
                activeSaveRef.current = null;
                return value;
              }),
            );
            if (Exit.isSuccess(result)) return;
            {
              const error = Cause.squash(result.cause);
              activeSaveRef.current = null;
              yield* model.updateObligation(
                obligation,
                `${reason} is waiting for durable storage: ${describe(error)}`,
              );
              if (yield* model.isClosing) throw error;
              yield* Effect.raceFirst(Effect.sleep(`${delay} millis`), Effect.never);
              delay = Math.min(delay * 2, 1_000);
            }
          }
        } finally {
          yield* model.clearObligation(obligation);
        }
      });

      return {
        persist: (state) => persistFn(state).pipe(Effect.orDie),
        persistUntilSuccess,
      } satisfies Persistence;
    }),
  );

export const makeEvents = (
  publishEvent: (event: { _tag: string; [key: string]: unknown }) => Effect.Effect<void>,
  publishFrame: (snapshot: WorkspaceSnapshot) => Effect.Effect<void>,
): Layer.Layer<WorkspaceTransactionEvents> =>
  Layer.succeed(WorkspaceTransactionEvents, {
    publishWorkspaceEvents: (before, after) =>
      publishWorkspaceEventsEffect(before, after, publishEvent),
    publishWorkspaceFrame: publishFrame,
  } satisfies Events);
