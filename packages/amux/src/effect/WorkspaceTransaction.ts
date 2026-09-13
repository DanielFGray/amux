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
  Result,
} from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { DaemonModel } from "./DaemonModel.ts";
import { loadConfig } from "../config.ts";
import { resolveOptions } from "../options.ts";
import {
  resolveTilingAlgorithm,
  TilingAlgorithmsTag,
  type DaemonCommandRegistration,
  type TilingAlgorithmContext,
} from "../plugin/services.ts";
import {
  applyWorkspaceCommand,
  buildWorkspaceReadPackage,
  isCoreWorkspaceAction,
  markSessionExited,
  workspaceSession,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
  type WorkspaceSpace,
  workspaceWindows,
  type PluginWorkspaceReducer,
} from "../workspace.ts";
import {
  PLUGIN_REDUCE_TIMEOUT_MS,
  WorkspaceChangeError,
  WorkspaceReducerAnswerSchema,
  type ActionDecode,
  type OwnerJsonCodec,
  type PluginCommandApply,
  type QueuedPluginAction,
  type ResultCodec,
} from "../workspace-changes.ts";
import { JsonValueSchema, type JsonValue } from "./AttachProtocol.ts";
import { nodePath } from "./node-path.ts";
import { COMMAND_META, isCoreCommand, type Command, type RuntimeCommand } from "../commands.ts";
import type { PaneEntry } from "../read-model.ts";
import type { PersistedSession, SessionState } from "../session.ts";
import type { PreparedSession } from "./SessionSupervisor.ts";
import type { PtyError, SessionSpec } from "./SessionRegistry.ts";
import type { WorktreeSpec } from "../git.ts";
import { errorMessage } from "../error-message.ts";
import { DaemonSessions } from "../daemon-sessions.ts";

const describe = errorMessage;

export class WorkspaceTransactionError extends S.TaggedError<WorkspaceTransactionError>()(
  "WorkspaceTransactionError",
  { message: S.String },
) {}

const transactionError = <E>(error: E): WorkspaceTransactionError =>
  S.is(WorkspaceTransactionError)(error)
    ? error
    : new WorkspaceTransactionError({ message: describe(error) });

/**
 * Daemon-local session ops for the workspace transaction: prepare, kill, write,
 * pids. Lives only in-process — prepare returns live handles that must not
 * cross a socket. Plugin code never sees this service.
 */
export interface WorkspaceTransactionSessionsService {
  readonly prepare: (
    session: PersistedSession,
    paneId?: string,
  ) => Effect.Effect<PreparedSession, WorkspaceTransactionError>;
  readonly kill: (id: string) => Effect.Effect<void, WorkspaceTransactionError>;
  readonly write: (id: string, data: string) => Effect.Effect<void, WorkspaceTransactionError>;
  /** Each live session's leader pid, for enriching `pane.list`/`pane.current`. */
  readonly pids: Effect.Effect<ReadonlyMap<string, number>, WorkspaceTransactionError>;
}

export class WorkspaceTransactionSessions extends Context.Service<
  WorkspaceTransactionSessions,
  WorkspaceTransactionSessionsService
>()("WorkspaceTransaction/Sessions") {}

/** Host surface for {@link buildWorkspaceTransactionSessions}. */
export interface WorkspaceTransactionSessionsHost {
  readonly prepare: (spec: SessionSpec) => Effect.Effect<PreparedSession, PtyError>;
  readonly write: (id: string, data: string | Uint8Array) => Effect.Effect<void, PtyError>;
  readonly pids: Effect.Effect<ReadonlyMap<string, number>>;
}

/**
 * Map a persisted session into a prepare spec. Optional keys appear only when
 * defined. `declaredAgent` becomes `SessionSpec.agent` — the same mapping
 * restore and pending-resume paths in daemon.ts use.
 */
const sessionSpecFromPersisted = (
  session: PersistedSession,
  paneId: string | undefined,
): Effect.Effect<SessionSpec, WorkspaceTransactionError> => {
  if (session.cmd === undefined || session.cmd.length === 0) {
    return Effect.fail(
      new WorkspaceTransactionError({
        message: `session '${session.id}' has no command to prepare`,
      }),
    );
  }
  const base = {
    id: session.id,
    cmd: session.cmd,
    cols: session.cols,
    rows: session.rows,
  };
  const withKind = session.kind === undefined ? base : { ...base, kind: session.kind };
  const withAgent =
    session.declaredAgent === undefined ? withKind : { ...withKind, agent: session.declaredAgent };
  const withEnv = session.env === undefined ? withAgent : { ...withAgent, env: session.env };
  const withCwd = session.cwd === undefined ? withEnv : { ...withEnv, cwd: session.cwd };
  return Effect.succeed(paneId === undefined ? withCwd : { ...withCwd, paneId });
};

export const buildWorkspaceTransactionSessions = <HostError, KillError>(
  getHost: Effect.Effect<WorkspaceTransactionSessionsHost, HostError>,
  killFn: (id: string) => Effect.Effect<void, KillError>,
): WorkspaceTransactionSessionsService => ({
  prepare: (session, paneId) =>
    sessionSpecFromPersisted(session, paneId).pipe(
      Effect.flatMap((spec) =>
        getHost.pipe(
          Effect.flatMap((host) => host.prepare(spec)),
          Effect.mapError(transactionError),
        ),
      ),
    ),
  kill: (id) => killFn(id).pipe(Effect.mapError(transactionError)),
  write: (id, data) =>
    getHost.pipe(
      Effect.flatMap((host) => host.write(id, data)),
      Effect.mapError(transactionError),
    ),
  pids: getHost.pipe(
    Effect.flatMap((host) => host.pids),
    Effect.mapError(transactionError),
  ),
});

export interface PluginActionRegistration {
  readonly tag: string;
  /**
   * Sync decode→encode at apply time. Returns the queued Encoded form so
   * {@link run} can decode once (Schemas with transforms stay correct).
   */
  readonly decode: ActionDecode;
  /** Run after the transaction: decode the queued payload once, then execute. */
  readonly run: (
    action: QueuedPluginAction,
  ) => Effect.Effect<void, WorkspaceTransactionError, DaemonSessions>;
}

/**
 * Pair a payload Schema with its executor. The returned registration stores
 * only closures — no `Schema<unknown>` and no cast.
 */
export const definePluginAction = <A, E>(reg: {
  readonly tag: string;
  readonly payload: S.Codec<A>;
  readonly execute: (action: A) => Effect.Effect<void, E, DaemonSessions>;
}): PluginActionRegistration => ({
  tag: reg.tag,
  decode: (encoded) => {
    const decoded = S.decodeUnknownResult(reg.payload)(encoded);
    if (Result.isFailure(decoded)) {
      return Result.fail(
        new WorkspaceChangeError({
          message: `action.push '${reg.tag}': ${describe(decoded.failure)}`,
        }),
      );
    }
    const reencoded = S.encodeUnknownResult(reg.payload)(decoded.success);
    if (Result.isFailure(reencoded)) {
      return Result.fail(
        new WorkspaceChangeError({
          message: `action.push '${reg.tag}': encode failed`,
        }),
      );
    }
    const wire = S.decodeUnknownResult(JsonValueSchema)(reencoded.success);
    if (Result.isFailure(wire)) {
      return Result.fail(
        new WorkspaceChangeError({
          message: `action.push '${reg.tag}': ${describe(wire.failure)}`,
        }),
      );
    }
    return Result.succeed({ _tag: reg.tag, payload: wire.success });
  },
  run: (queued) =>
    Effect.gen(function* () {
      const decoded = S.decodeUnknownResult(reg.payload)(queued.payload);
      if (Result.isFailure(decoded)) {
        return yield* new WorkspaceTransactionError({
          message: `action '${reg.tag}': ${describe(decoded.failure)}`,
        });
      }
      yield* reg.execute(decoded.success).pipe(Effect.mapError(transactionError));
    }),
});

export interface WorkspaceTransactionPluginsService {
  readonly reducers: ReadonlyMap<string, PluginWorkspaceReducer>;
  /** Action tag → run closure (decode then execute). */
  readonly actions: ReadonlyMap<string, PluginActionRegistration["run"]>;
  /** Per command tag: action tag → sync decode closure. */
  readonly actionDecodersByCommand: ReadonlyMap<
    string,
    ReadonlyMap<string, PluginActionRegistration["decode"]>
  >;
  /** Per command tag: result codec, if the command declared one. */
  readonly resultCodecs: ReadonlyMap<string, ResultCodec>;
  /** Pane type → descriptor codec. */
  readonly paneDescriptors: ReadonlyMap<string, OwnerJsonCodec>;
  /** Provider id → firstMessage codec. */
  readonly providerMessages: ReadonlyMap<string, OwnerJsonCodec>;
}

/** Build the transaction plugins service from daemon command registrations. */
export const workspaceTransactionPluginsFromRegistrations = (
  registrations: Iterable<DaemonCommandRegistration>,
): WorkspaceTransactionPluginsService => {
  const list = [...registrations];
  return {
    reducers: new Map(
      list
        .filter((registration) => registration.reduce !== undefined)
        .map((registration) => [registration.tag, registration.reduce!]),
    ),
    actions: new Map(
      list
        .flatMap((registration) => registration.actions ?? [])
        .map((registration) => [registration.tag, registration.run]),
    ),
    actionDecodersByCommand: new Map(
      list
        .filter((registration) => (registration.actions?.length ?? 0) > 0)
        .map((registration) => [
          registration.tag,
          new Map((registration.actions ?? []).map((action) => [action.tag, action.decode])),
        ]),
    ),
    resultCodecs: new Map(
      list
        .filter((registration) => registration.result !== undefined)
        .map((registration) => [registration.tag, registration.result!]),
    ),
    paneDescriptors: new Map(
      list
        .flatMap((registration) => registration.paneDescriptors ?? [])
        .map((registration) => [registration.type, registration.codec]),
    ),
    providerMessages: new Map(
      list
        .flatMap((registration) => registration.providerMessages ?? [])
        .map((registration) => [registration.provider, registration.codec]),
    ),
  };
};

/**
 * Run a plugin reducer (timeout + answer Schema) and assemble the
 * {@link PluginCommandApply} the sync apply path consumes. Core commands with
 * no reducer still receive descriptor/provider maps for pane.open-plugin etc.
 */
export const reducePluginCommand = (
  plugins: WorkspaceTransactionPluginsService,
  command: RuntimeCommand,
  workspace: WorkspaceSnapshot,
  context: WorkspaceCommandContext,
): Effect.Effect<PluginCommandApply, WorkspaceTransactionError> =>
  Effect.gen(function* () {
    const paneDescriptors = plugins.paneDescriptors;
    const providerMessages = plugins.providerMessages;
    const reducer = plugins.reducers.get(command._tag);
    if (reducer === undefined) {
      return {
        changes: [],
        resultCodec: undefined,
        actionDecoders: new Map(),
        paneDescriptors,
        providerMessages,
      };
    }
    const reads = buildWorkspaceReadPackage(workspace, context);
    const answer = yield* reducer({ command, context, reads }).pipe(
      Effect.timeout(Duration.millis(PLUGIN_REDUCE_TIMEOUT_MS)),
      Effect.mapError(
        (error) =>
          new WorkspaceTransactionError({
            message: `plugin reducer for '${command._tag}': ${describe(error)}`,
          }),
      ),
    );
    const decoded = yield* S.decodeEffect(WorkspaceReducerAnswerSchema)(answer).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceTransactionError({
            message: `plugin reducer for '${command._tag}' returned undecodable data: ${describe(error)}`,
          }),
      ),
    );
    return {
      changes: decoded.changes,
      resultCodec: plugins.resultCodecs.get(command._tag),
      actionDecoders: plugins.actionDecodersByCommand.get(command._tag) ?? new Map(),
      paneDescriptors,
      providerMessages,
    };
  });

export class WorkspaceTransactionPlugins extends Context.Service<
  WorkspaceTransactionPlugins,
  WorkspaceTransactionPluginsService
>()("WorkspaceTransaction/Plugins") {}

const withPanePid = (entry: PaneEntry, pids: ReadonlyMap<string, number>): PaneEntry =>
  entry.session === undefined ? entry : { ...entry, pid: pids.get(entry.session) };

/** `pane.list`/`pane.current` answer from the pure workspace reducer, which
 *  knows nothing live — pid comes from the daemon's session registry, so it
 *  is stitched on here rather than threaded through `applyWorkspaceCommand`. */
const withPanePids = (
  tag: string,
  result: JsonValue,
  sessions: WorkspaceTransactionSessionsService,
): Effect.Effect<JsonValue, WorkspaceTransactionError> => {
  if (tag !== "pane.list" && tag !== "pane.current") return Effect.succeed(result);
  return sessions.pids.pipe(
    Effect.map((pids) =>
      Array.isArray(result)
        ? result.map((entry) => withPanePid(entry as PaneEntry, pids))
        : result === null
          ? result
          : withPanePid(result as PaneEntry, pids),
    ),
  );
};

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
    value: Command | RuntimeCommand,
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
  readonly result?: JsonValue;
}

export class WorkspaceTransaction extends Context.Service<WorkspaceTransaction>()(
  "WorkspaceTransaction",
  {
    make: Effect.gen(function* () {
      const model = yield* DaemonModel;
      const transactionSessions = yield* WorkspaceTransactionSessions;
      const pluginSessions = yield* DaemonSessions;
      const worktreeOps = yield* WorkspaceTransactionWorktreeOps;
      const persistence = yield* WorkspaceTransactionPersistence;
      const events = yield* WorkspaceTransactionEvents;
      const lifecycle = yield* Effect.serviceOption(WorkspaceTransactionLifecycle);
      const plugins = yield* Effect.serviceOption(WorkspaceTransactionPlugins);
      const tilingAlgorithms = yield* Effect.serviceOption(TilingAlgorithmsTag);
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
            const newState = yield* workspaceSession(next, cur2.state);
            yield* persistence.persistUntilSuccess(newState, `natural exit for '${sid}'`);
            yield* model.commitWorkspace(next, newState);
            yield* events.publishWorkspaceFrame(next);
            if (next.spaces.length === 0) yield* closeIfEmpty;
          }),
        );
      });

      const run = (
        value: Command | RuntimeCommand,
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
              if (isCoreCommand(value) && COMMAND_META[value._tag].target !== "workspace") {
                return yield* new WorkspaceTransactionError({
                  message: `command '${value._tag}' is not a workspace command`,
                });
              }

              const config = yield* loadConfig().pipe(Effect.provide(BunFileSystem.layer));
              // Every registered algorithm's own id is a legal choice for
              // behaviour.tilingAlgorithm — the registry is the daemon-side
              // source of truth for this option's live values, so a plugin
              // algorithm never needs a second registration just to be
              // selectable (see OptionsService.registerEnumValue for the
              // client-side Settings UI's equivalent).
              const registeredAlgorithmIds = Option.getOrElse(
                Option.map(tilingAlgorithms, (service) =>
                  service.all().map((entry) => entry.value.algorithm.id),
                ),
                (): readonly string[] => [],
              );
              const selectedId = resolveOptions(
                config.options,
                new Map([["behaviour.tilingAlgorithm", registeredAlgorithmIds]]),
              )["behaviour.tilingAlgorithm"];
              const target = value as { readonly space?: string; readonly window?: number };
              const workspaceId = target.space ?? cur.workspace.state.activeSpace ?? undefined;
              const targetWindow = [...workspaceWindows(cur.workspace)].find(
                ({ space, window }) =>
                  (target.space === undefined || space.id === target.space) &&
                  (target.window === undefined || window.number === target.window),
              );
              const algorithmContext: TilingAlgorithmContext = {
                width: context.size.cols,
                height: context.size.rows,
                workspaceId,
                sessionCount: targetWindow?.window.sessions.length,
                selectedId,
              };
              const algorithm = resolveTilingAlgorithm(
                Option.getOrElse(
                  Option.map(tilingAlgorithms, (service) => service.all()),
                  () => [],
                ),
                algorithmContext,
              );

              const path = yield* nodePath;
              const pluginService = Option.getOrUndefined(plugins);
              const pluginApply =
                pluginService === undefined
                  ? undefined
                  : isCoreCommand(value)
                    ? {
                        changes: [] as const,
                        resultCodec: undefined,
                        actionDecoders: new Map(),
                        paneDescriptors: pluginService.paneDescriptors,
                        providerMessages: pluginService.providerMessages,
                      }
                    : yield* reducePluginCommand(pluginService, value, cur.workspace, context);
              const mutation = yield* applyWorkspaceCommand(
                cur.workspace,
                value,
                context,
                path,
                pluginApply,
                algorithm,
              ).pipe(
                Effect.mapError(
                  (error) =>
                    new WorkspaceTransactionError({
                      message: error.message,
                    }),
                ),
              );
              const candidate = yield* workspaceSession(mutation.snapshot, cur.state);
              const worktrees = gitWorktreesFor(value, mutation.snapshot, cur.workspace);
              const prepared: PreparedSession[] = [];
              const exitsSettled = yield* Deferred.make<boolean>();
              const killed = mutation.actions
                .filter(isCoreWorkspaceAction)
                .filter((a) => a._tag === "kill")
                .map((a) => a.agent);

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
                    if (!isCoreWorkspaceAction(a)) continue;
                    if (a._tag !== "spawn") continue;
                    if (a.agent.kind === "component") continue;
                    prepared.push(yield* transactionSessions.prepare(a.agent, a.pane));
                  }
                  for (const a of mutation.actions) {
                    if (!isCoreWorkspaceAction(a)) continue;
                    yield* Match.value(a).pipe(
                      Match.tag("kill", (a) => transactionSessions.kill(a.agent)),
                      Match.tag("input", (a) => transactionSessions.write(a.agent, a.data)),
                      Match.orElse(() => Effect.void),
                    );
                  }
                  for (const action of mutation.actions) {
                    if (isCoreWorkspaceAction(action)) continue;
                    const run = plugins.pipe(
                      Option.flatMap((value) =>
                        Option.fromNullishOr(value.actions.get(action._tag)),
                      ),
                    );
                    if (Option.isNone(run)) continue;
                    yield* Effect.scoped(
                      run.value(action).pipe(Effect.provideService(DaemonSessions, pluginSessions)),
                    ).pipe(Effect.timeout("30 seconds"), Effect.asVoid);
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
                  const final = yield* model.get;
                  const committed = {
                    snapshot: structuredClone(final.workspace),
                  };
                  if (mutation.result !== undefined) {
                    const result = yield* withPanePids(
                      value._tag,
                      mutation.result,
                      transactionSessions,
                    );
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
  value: Command | RuntimeCommand,
  next: WorkspaceSnapshot,
  current: WorkspaceSnapshot,
): GitWorktreePlan {
  const none: GitWorktreePlan = {
    created: null,
    base: undefined,
    removed: [],
  };
  if (!isCoreCommand(value)) return none;
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
