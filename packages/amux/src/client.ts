import { Deferred, Effect, Option, Queue, Schedule, Scope, Stream, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import { AttachClient } from "./attach.ts";
import { daemonBackend, type DaemonSession, type SessionBackendFactory } from "./backend.ts";
import { connectControl, controlCall, toControlError } from "./control-client.ts";
import type { BufferEntry } from "./effect/BufferStore.ts";
import type { Command, RuntimeCommand } from "./commands.ts";
import type { JsonValue } from "./effect/AttachProtocol.ts";
import {
  parseWorkspaceJson,
  workspaceSessions,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
} from "./workspace.ts";
import {
  processAlive,
  optionalEnvVar,
  sessionPaths,
  SessionStore,
  SessionIdError,
  type SessionState,
} from "./session.ts";
import type { DaemonEventPayload } from "./effect/EventBus.ts";
import { ControlError } from "./control.ts";
import { errorMessage } from "./error-message.ts";

const START_TIMEOUT_MS = 10_000;
const POLL_MS = 25;

export interface SessionClientOptions {
  client?: string;
  autostart?: boolean;
}

export class SessionClientError extends S.TaggedError<SessionClientError>()("SessionClientError", {
  message: S.String,
}) {}

export interface SessionClientContract extends DaemonSession {
  readonly id: string;
  readonly session: SessionState | null;
  readonly live: ReadonlySet<string>;
  readonly workspace: () => WorkspaceSnapshot;
  readonly models: Stream.Stream<WorkspaceSnapshot, never, never>;
  readonly events: Stream.Stream<DaemonEventPayload, ControlError, never>;
  /** A plugin verb the daemon forwarded here because it has no plugin runtime
   *  of its own; each one wants a matching {@link respondCommand}. */
  readonly commandRequests: Stream.Stream<
    { readonly id: string; readonly command: JsonValue },
    never,
    never
  >;
  readonly respondCommand: (id: string, result?: JsonValue, error?: string) => void;
  readonly runWorkspace: (
    command: Command | RuntimeCommand,
    context: WorkspaceCommandContext,
  ) => Effect.Effect<
    { readonly snapshot: WorkspaceSnapshot; readonly result?: JsonValue },
    ControlError | SessionClientError,
    never
  >;
  /** Raw control-protocol Run for commands that do not produce a workspace snapshot. */
  readonly run: (command: Command | RuntimeCommand) => Effect.Effect<unknown, ControlError>;
  readonly resumeAgent: (input: {
    session: string;
    provider: string;
    argv?: readonly string[];
    env?: Readonly<Record<string, string>>;
    stripEnv?: readonly string[];
  }) => Effect.Effect<void, ControlError>;
  readonly backend: () => SessionBackendFactory;
  readonly close: () => void;
  readonly stop: Effect.Effect<void, ControlError, never>;
  /** tmux's buffer verbs, all server-side: the stack lives in the daemon
   *  beside the PTYs, so a copy and a paste work with no client attached. */
  readonly setBuffer: (
    name: string | undefined,
    data: string,
  ) => Effect.Effect<string, ControlError, never>;
  readonly pasteBuffer: (
    name: string | undefined,
    target: string,
    deleteAfter?: boolean,
  ) => Effect.Effect<void, ControlError, never>;
  readonly listBuffers: Effect.Effect<readonly BufferEntry[], ControlError, never>;
  readonly deleteBuffer: (name: string | undefined) => Effect.Effect<void, ControlError, never>;
  readonly showBuffer: (name: string | undefined) => Effect.Effect<string, ControlError, never>;
}

/** The control connection lives for the returned client's scope: closing the
 *  scope closes both the attach socket and the RPC socket. */
export const SessionClient = {
  connect(
    id: string,
    options: SessionClientOptions = {},
  ): Effect.Effect<
    SessionClientContract,
    ControlError | SessionClientError | SessionIdError,
    Scope.Scope | SessionStore | FileSystem.FileSystem
  > {
    return make(id, options);
  },
};

const make = (
  id: string,
  options: SessionClientOptions,
): Effect.Effect<
  SessionClientContract,
  ControlError | SessionClientError | SessionIdError,
  Scope.Scope | SessionStore | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    if (options.autostart !== false) yield* ensureDaemon(id);
    const paths = yield* sessionPaths(id);
    const attach = yield* Effect.tryPromise({
      try: () =>
        AttachClient.connect({
          path: paths.attach,
          client: options.client ?? `pid-${process.pid}`,
        }),
      catch: (error) => new SessionClientError({ message: errorMessage(error) }),
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced("200 millis").pipe(Schedule.upTo({ duration: "5000 millis" })),
        while: (error) =>
          S.is(SessionClientError)(error) && error.message.includes("already attached"),
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => attach.close()));

    // One connection for the client's whole lifetime: the protocol layer is
    // built into this scope, so every later call reuses the same socket.
    const control = yield* connectControl(id);
    const status = yield* control.Status().pipe(
      Effect.mapError(
        (error) =>
          new SessionClientError({
            message: `session '${id}' did not answer status: ${error.message}`,
          }),
      ),
    );
    let service!: SessionClientContract;
    const initialWorkspace = yield* parseWorkspaceJson(status.workspace).pipe(
      Effect.mapError(
        (error) =>
          new SessionClientError({
            message: `daemon returned an invalid workspace: ${error.message}`,
          }),
      ),
    );
    let workspace = initialWorkspace;
    const commandQueue = yield* Queue.unbounded<{
      readonly command: Command | RuntimeCommand;
      readonly context: WorkspaceCommandContext;
      readonly done: Deferred.Deferred<
        { readonly snapshot: WorkspaceSnapshot; readonly result?: JsonValue },
        SessionClientError
      >;
    }>();
    const closed = yield* Deferred.make<void>();
    const closingError = () => new SessionClientError({ message: "client is closing" });
    const accept = (next: WorkspaceSnapshot) => {
      if (next.revision > workspace.revision) {
        workspace = next;
        const live = service.live as Set<string>;
        live.clear();
        for (const { session } of workspaceSessions(next))
          if (!session.exited) live.add(session.id);
      }
      return workspace;
    };
    const runQueuedWorkspaceCommand = (request: {
      readonly command: Command | RuntimeCommand;
      readonly context: WorkspaceCommandContext;
    }) =>
      Effect.gen(function* () {
        const { outputs } = yield* control.Batch({
          values: [request.command],
          expectedRevision: workspace.revision,
          context: request.context,
        });
        const next = outputs[0]?.workspace;
        if (next === undefined) {
          return yield* new SessionClientError({
            message: "workspace command returned no workspace",
          });
        }
        const parsed = yield* parseWorkspaceJson(next);
        accept(parsed);
        const result = outputs[0]?.result;
        return result === undefined
          ? { snapshot: structuredClone(workspace) }
          : { snapshot: structuredClone(workspace), result: result as JsonValue };
      }).pipe(Effect.mapError((error) => new SessionClientError({ message: errorMessage(error) })));
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(commandQueue).pipe(
          Effect.flatMap((request) =>
            Effect.exit(
              Effect.raceFirst(
                runQueuedWorkspaceCommand(request),
                Deferred.await(closed).pipe(Effect.flatMap(() => Effect.fail(closingError()))),
              ),
            ).pipe(Effect.flatMap((exit) => Deferred.done(request.done, exit))),
          ),
        ),
      ),
    );
    // Release everyone waiting on an in-flight command first, then discard the
    // requests that never started. `Queue.clear` is the non-blocking drain:
    // `Queue.takeAll` waits for an element, and a closing client's queue is
    // normally empty.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(closed, undefined);
        yield* Queue.clear(commandQueue);
      }),
    );
    service = {
      id,
      attach,
      // Decoded from the wire as deeply readonly; the client's shape owns a
      // mutable copy of it.
      session: structuredClone(status.session) as SessionState,
      live: new Set(status.agents),
      workspace: () => structuredClone(workspace),
      models: attach.workspace.pipe(Stream.map(accept)),
      events: control.Events().pipe(
        Stream.drop(1),
        Stream.map(({ event }) => event),
        Stream.mapError(toControlError),
      ),
      commandRequests: attach.commandRequests,
      respondCommand: (id, result, error) => attach.respondCommand(id, result, error),
      runWorkspace: (command, context) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<
            { readonly snapshot: WorkspaceSnapshot; readonly result?: JsonValue },
            SessionClientError
          >();
          return yield* Effect.raceFirst(
            Queue.offer(commandQueue, { command, context, done }).pipe(
              Effect.andThen(Deferred.await(done)),
            ),
            Deferred.await(closed).pipe(Effect.flatMap(() => Effect.fail(closingError()))),
          );
        }),
      run: (command) =>
        control.Batch({ values: [command] }).pipe(
          Effect.map(({ outputs }) => outputs[0]?.result),
          Effect.mapError(toControlError),
        ),
      resumeAgent: (input) =>
        Effect.sync(() => {
          const resumeInput = { ...input, env: input.env, stripEnv: input.stripEnv };
          if (input.argv) resumeInput.argv = [...input.argv];
          return resumeInput;
        }).pipe(
          Effect.flatMap((resumeInput) => control.ResumeAgent(resumeInput)),
          Effect.mapError(toControlError),
        ),
      backend: () => daemonBackend(service, service.live),
      setBuffer: (name, data) =>
        control.SetBuffer({ name, data }).pipe(Effect.mapError(toControlError)),
      pasteBuffer: (name, target, deleteAfter = false) =>
        control.PasteBuffer({ name, target, deleteAfter }).pipe(Effect.mapError(toControlError)),
      listBuffers: control.ListBuffers().pipe(Effect.mapError(toControlError)),
      deleteBuffer: (name) => control.DeleteBuffer({ name }).pipe(Effect.mapError(toControlError)),
      showBuffer: (name) => control.ShowBuffer({ name }).pipe(Effect.mapError(toControlError)),
      close: () => attach.close(),
      // A daemon that dies mid-response is a successful stop, so transport
      // failures here are expected rather than reported.
      stop: control.Stop().pipe(Effect.ignore),
    };
    return service;
  });

export function daemonAlive(
  id: string,
): Effect.Effect<boolean, never, SessionStore | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const lease = yield* Effect.flatMap(SessionStore, (store) => store.readLease(id)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!lease || !processAlive(lease.pid)) return false;
    return yield* controlCall(id, (control) => control.Ping()).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });
}

export function ensureDaemon(
  id: string,
): Effect.Effect<void, SessionClientError, SessionStore | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (yield* daemonAlive(id)) return;
    const home = yield* optionalEnvVar("HOME");
    const stateHome = yield* optionalEnvVar("XDG_STATE_HOME");
    const entry = new URL("./daemon-main.ts", import.meta.url).pathname;
    // A compiled executable's modules live under /$bunfs, which is not a
    // path a child process can execute. Re-enter its public daemon subcommand;
    // source mode still asks Bun to run daemon-main.ts directly.
    const args = entry.startsWith("/$bunfs/") ? ["daemon", id] : [entry, id];
    const env = { ...process.env };
    if (Option.isSome(home)) env.HOME = home.value;
    if (Option.isSome(stateHome)) env.XDG_STATE_HOME = stateHome.value;
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn([process.execPath, ...args], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          env,
        }),
      catch: (error) => new SessionClientError({ message: errorMessage(error) }),
    });
    child.unref();
    const pidFile = yield* optionalEnvVar("AMUX_DAEMON_PID_FILE");
    if (Option.isSome(pidFile))
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.writeFileString(pidFile.value, `${child.pid}\n`)),
      );
    const daemonReady = daemonAlive(id).pipe(
      Effect.filterOrFail(
        Boolean,
        () => new SessionClientError({ message: "daemon is not ready" }),
      ),
    );
    yield* daemonReady.pipe(
      Effect.retry(
        Schedule.spaced(`${POLL_MS} millis`).pipe(
          Schedule.upTo({ duration: `${START_TIMEOUT_MS} millis` }),
        ),
      ),
      Effect.mapError(
        () =>
          new SessionClientError({
            message: `daemon for session '${id}' did not start within ${START_TIMEOUT_MS}ms`,
          }),
      ),
    );
  }).pipe(
    Effect.mapError((error) =>
      S.is(SessionClientError)(error)
        ? error
        : new SessionClientError({ message: errorMessage(error) }),
    ),
  );
}
