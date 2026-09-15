import { Deferred, Effect, Option, Queue, Schedule, Scope, Stream, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import { AttachClient } from "./attach.ts";
import { daemonBackend, type DaemonSession, type SessionBackendFactory } from "./backend.ts";
import { connectControl, controlCall, toControlError } from "./control-client.ts";
import type { BufferEntry } from "./effect/BufferStore.ts";
import type { DocumentMeta, DocumentSnapshot, TextEdit } from "@danielfgray/amux-text-buffer";
import { WireCommand, type Command, type RuntimeCommand } from "./commands.ts";
import type { JsonValue } from "./effect/AttachProtocol.ts";
import {
  parseWorkspaceJson,
  workspaceSessions,
  type WorkspaceSnapshot,
} from "./workspace.ts";
import type { WorkspaceCommandContext } from "./workspace-command-context.ts";
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
import type { PluginPublicationAnnouncement } from "./plugin/ui-announcement.ts";
import type { PluginUiReadyReport } from "./control.ts";
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

/** Fold a Batch output that carries no workspace. The daemon omits the
 *  snapshot when a command bypasses the model queue — the session, client,
 *  buffer and plugin-verb paths, plus send-keys — so the model is unchanged
 *  by construction, not missing by failure. The client keeps its snapshot
 *  and passes any result on. */
export const unchangedOutput = (
  workspace: WorkspaceSnapshot,
  result: JsonValue | undefined,
): { readonly snapshot: WorkspaceSnapshot; readonly result?: JsonValue } =>
  result === undefined
    ? { snapshot: structuredClone(workspace) }
    : { snapshot: structuredClone(workspace), result };

export interface SessionClientContract extends DaemonSession {
  readonly id: string;
  readonly session: SessionState | null;
  readonly live: ReadonlySet<string>;
  readonly workspace: () => WorkspaceSnapshot;
  readonly models: Stream.Stream<WorkspaceSnapshot, never, never>;
  readonly events: Stream.Stream<DaemonEventPayload, ControlError, never>;
  /**
   * Host publication announcements (SubscriptionRef.changes). Emits the current
   * revision first so late joiners need no Status read before loading UI halves.
   */
  readonly pluginPublications: Stream.Stream<PluginPublicationAnnouncement, ControlError, never>;
  readonly reportPluginUiReady: (
    report: PluginUiReadyReport,
  ) => Effect.Effect<void, ControlError, never>;
  /** A plugin verb the daemon forwarded here because it has no plugin runtime
   *  of its own; each one wants a matching {@link respondCommand}. */
  readonly commandRequests: Stream.Stream<
    {
      readonly id: string;
      readonly command: JsonValue;
      readonly source: "key" | "socket" | "cli";
      readonly pane?: string;
      readonly agent?: string;
    },
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
  readonly run: (
    command: Command | RuntimeCommand,
    context: WorkspaceCommandContext,
  ) => Effect.Effect<unknown, ControlError>;
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
  /** Daemon-owned open documents — editor and agents share one sequenced store. */
  readonly documentOpen: (
    uri: string,
    text?: string,
  ) => Effect.Effect<DocumentMeta, ControlError, never>;
  readonly documentApply: (
    uri: string,
    baseGeneration: number,
    edits: readonly TextEdit[],
  ) => Effect.Effect<DocumentMeta, ControlError, never>;
  readonly documentWrite: (
    uri: string,
    baseGeneration: number,
    text: string,
  ) => Effect.Effect<DocumentMeta, ControlError, never>;
  readonly documentSnapshot: (uri: string) => Effect.Effect<DocumentSnapshot, ControlError, never>;
  readonly documentSlice: (
    uri: string,
    start: number,
    end: number,
  ) => Effect.Effect<readonly string[], ControlError, never>;
  readonly documentSave: (uri: string) => Effect.Effect<DocumentMeta, ControlError, never>;
  readonly documentClose: (
    uri: string,
    force?: boolean,
  ) => Effect.Effect<void, ControlError, never>;
  readonly documentList: Effect.Effect<readonly DocumentMeta[], ControlError, never>;
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
    const attach = yield* AttachClient.make({
      path: paths.attach,
      client: options.client ?? `pid-${process.pid}`,
    }).pipe(
      Effect.mapError((error) => new SessionClientError({ message: errorMessage(error) })),
      Effect.retry({
        schedule: Schedule.spaced("200 millis").pipe(Schedule.upTo({ duration: "5000 millis" })),
        while: (error) =>
          S.is(SessionClientError)(error) && error.message.includes("already attached"),
      }),
    );
    // Scope teardown closes the socket via makeScoped's acquireRelease — do not
    // add a second finalizer that calls attach.close() (that was the Promise
    // adapter's lifecycle, not this one).

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
    // Refresh from modeled non-exited sessions on a newer snapshot. Seed comes
    // from Status.agents (daemon authority); this keeps live aligned with the
    // workspace the client projects — production panes are always modeled.
    const fillLive = (target: Set<string>, snapshot: WorkspaceSnapshot) => {
      target.clear();
      for (const { session } of workspaceSessions(snapshot))
        if (!session.exited) target.add(session.id);
    };
    const accept = (next: WorkspaceSnapshot) => {
      if (next.revision > workspace.revision) {
        workspace = next;
        fillLive(service.live as Set<string>, next);
      }
      return workspace;
    };
    const runQueuedCommand = (request: {
      readonly command: Command | RuntimeCommand;
      readonly context: WorkspaceCommandContext;
    }) =>
      Effect.gen(function* () {
        const encoded = yield* S.encodeEffect(S.fromJsonString(WireCommand))(request.command).pipe(
          Effect.mapError((error) => new SessionClientError({ message: errorMessage(error) })),
        );
        const output = yield* attach.runCommand(encoded, {
          expectedRevision: workspace.revision,
          context: request.context,
        });
        const next = output.workspace;
        if (next === undefined) return unchangedOutput(workspace, output.result);
        const parsed = yield* parseWorkspaceJson(next);
        accept(parsed);
        return output.result === undefined
          ? { snapshot: structuredClone(workspace) }
          : { snapshot: structuredClone(workspace), result: output.result };
      }).pipe(Effect.mapError((error) => new SessionClientError({ message: errorMessage(error) })));
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(commandQueue).pipe(
          Effect.flatMap((request) =>
            Effect.exit(
              Effect.raceFirst(
                runQueuedCommand(request),
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
      // Status.agents: running PTYs plus parked resumes — daemon adoption set.
      live: new Set(status.agents),
      workspace: () => structuredClone(workspace),
      models: attach.workspace.pipe(Stream.map(accept)),
      events: control.Events().pipe(
        Stream.drop(1),
        Stream.map(({ event }) => event),
        Stream.mapError(toControlError),
      ),
      pluginPublications: control.PluginPublications().pipe(Stream.mapError(toControlError)),
      reportPluginUiReady: (report) =>
        control.ReportPluginUiReady(report).pipe(Effect.mapError(toControlError)),
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
      // No expectedRevision and no queue: a client-target runOnClient can call
      // back into session.run while the outer command is still open; serializing
      // both on commandQueue deadlocks. Workspace mutations stay on runWorkspace.
      run: (command, context) =>
        Effect.gen(function* () {
          const encoded = yield* S.encodeEffect(S.fromJsonString(WireCommand))(command).pipe(
            Effect.mapError((error) => new ControlError({ message: errorMessage(error) })),
          );
          const output = yield* Effect.raceFirst(
            attach.runCommand(encoded, { context }),
            Deferred.await(closed).pipe(Effect.flatMap(() => Effect.fail(closingError()))),
          );
          if (output.workspace !== undefined) {
            const parsed = yield* parseWorkspaceJson(output.workspace);
            accept(parsed);
          }
          return output.result;
        }).pipe(Effect.mapError((error) => new ControlError({ message: errorMessage(error) }))),
      resumeAgent: (input) =>
        Effect.sync(() => {
          const resumeInput = { ...input, env: input.env, stripEnv: input.stripEnv };
          if (input.argv) resumeInput.argv = [...input.argv];
          return resumeInput;
        }).pipe(
          Effect.flatMap((resumeInput) => control.ResumeAgent(resumeInput)),
          Effect.mapError(toControlError),
        ),
      // service.live is seeded from Status.agents and refreshed by accept().
      backend: () => daemonBackend(service, service.live),
      setBuffer: (name, data) =>
        control.SetBuffer({ name, data }).pipe(Effect.mapError(toControlError)),
      pasteBuffer: (name, target, deleteAfter = false) =>
        control.PasteBuffer({ name, target, deleteAfter }).pipe(Effect.mapError(toControlError)),
      listBuffers: control.ListBuffers().pipe(Effect.mapError(toControlError)),
      deleteBuffer: (name) => control.DeleteBuffer({ name }).pipe(Effect.mapError(toControlError)),
      showBuffer: (name) => control.ShowBuffer({ name }).pipe(Effect.mapError(toControlError)),
      documentOpen: (uri, text) =>
        control.DocumentOpen({ uri, text }).pipe(Effect.mapError(toControlError)),
      documentApply: (uri, baseGeneration, edits) =>
        control
          .DocumentApply({ uri, baseGeneration, edits: [...edits] })
          .pipe(Effect.mapError(toControlError)),
      documentWrite: (uri, baseGeneration, text) =>
        control.DocumentWrite({ uri, baseGeneration, text }).pipe(Effect.mapError(toControlError)),
      documentSnapshot: (uri) =>
        control.DocumentSnapshot({ uri }).pipe(Effect.mapError(toControlError)),
      documentSlice: (uri, start, end) =>
        control.DocumentSlice({ uri, start, end }).pipe(Effect.mapError(toControlError)),
      documentSave: (uri) => control.DocumentSave({ uri }).pipe(Effect.mapError(toControlError)),
      documentClose: (uri, force = false) =>
        control.DocumentClose({ uri, force }).pipe(Effect.mapError(toControlError)),
      documentList: control.DocumentList().pipe(Effect.mapError(toControlError)),
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
    if (!lease || !(yield* processAlive(lease.pid))) return false;
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
    const args = [entry, id];
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
