import { spawn } from "node:child_process";
import { Effect, Runtime, Schedule, Scope, Stream, Schema as S } from "effect";
import { FileSystem } from "@effect/platform";
import { AttachClient } from "./attach.ts";
import { daemonBackend, type DaemonSession, type SpawnBackend } from "./backend.ts";
import { connectControl, controlCall } from "./control-client.ts";
import type { BufferEntry } from "./effect/BufferStore.ts";
import type { Command } from "./commands.ts";
import {
  parseWorkspace,
  parseWorkspaceJson,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
} from "./workspace.ts";
import { processAlive, sessionPaths, Session, SessionEnv, type SessionState } from "./session.ts";

const START_TIMEOUT_MS = 10_000;
const POLL_MS = 25;

export interface SessionClientOptions {
  client?: string;
  autostart?: boolean;
}

export class SessionClientError extends S.TaggedError<SessionClientError>()("SessionClientError", {
  message: S.String,
}) {}

export interface SessionClientShape extends DaemonSession {
  readonly id: string;
  readonly session: SessionState | null;
  readonly live: ReadonlySet<string>;
  readonly workspace: () => WorkspaceSnapshot;
  readonly models: Stream.Stream<WorkspaceSnapshot>;
  readonly runWorkspace: (
    command: Command,
    context: WorkspaceCommandContext,
  ) => Effect.Effect<WorkspaceSnapshot, unknown, never>;
  readonly backend: () => SpawnBackend;
  readonly close: () => void;
  readonly stop: () => Effect.Effect<void, unknown, never>;
  /** tmux's buffer verbs, all server-side: the stack lives in the daemon
   *  beside the PTYs, so a copy and a paste work with no client attached. */
  readonly setBuffer: (
    name: string | undefined,
    data: string,
  ) => Effect.Effect<string, unknown, never>;
  readonly pasteBuffer: (
    name: string | undefined,
    target: string,
    deleteAfter?: boolean,
  ) => Effect.Effect<void, unknown, never>;
  readonly listBuffers: () => Effect.Effect<readonly BufferEntry[], unknown, never>;
  readonly deleteBuffer: (name: string | undefined) => Effect.Effect<void, unknown, never>;
  readonly showBuffer: (name: string | undefined) => Effect.Effect<string, unknown, never>;
}

/** The control connection lives for the returned client's scope: closing the
 *  scope closes both the attach socket and the RPC socket. */
export const SessionClient = {
  connect(
    id: string,
    options: SessionClientOptions = {},
  ): Effect.Effect<
    SessionClientShape,
    unknown,
    Scope.Scope | SessionEnv | Session | FileSystem.FileSystem
  > {
    return make(id, options);
  },
};

const make = (
  id: string,
  options: SessionClientOptions,
): Effect.Effect<
  SessionClientShape,
  unknown,
  Scope.Scope | SessionEnv | Session | FileSystem.FileSystem
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
      catch: (error) => new SessionClientError({ message: String(error) }),
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced("200 millis").pipe(Schedule.upTo("5000 millis")),
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
            message: `session '${id}' did not answer status: ${String(error)}`,
          }),
      ),
    );
    let service!: SessionClientShape;
    const initialWorkspace = yield* Effect.try({
      try: () => parseWorkspaceJson(status.workspace),
      catch: (error) =>
        new SessionClientError({
          message: `daemon returned an invalid workspace: ${String(error)}`,
        }),
    });
    let workspace = initialWorkspace;
    let commandQueue: Promise<void> = Promise.resolve();
    const accept = (next: WorkspaceSnapshot) => {
      if (next.revision > workspace.revision) {
        workspace = next;
        const live = service.live as Set<string>;
        live.clear();
        for (const space of next.spaces) {
          for (const window of space.windows) {
            for (const agent of window.agents) if (!agent.exited) live.add(agent.id);
          }
        }
      }
      return workspace;
    };
    service = {
      id,
      attach,
      // Decoded from the wire as deeply readonly; the client's shape owns a
      // mutable copy of it.
      session: structuredClone(status.session) as SessionState,
      live: new Set(status.agents),
      workspace: () => structuredClone(workspace),
      models: attach.workspace().pipe(Stream.map(accept)),
      runWorkspace: (command, context) =>
        Effect.flatMap(Effect.runtime<never>(), (runtime) =>
          Effect.tryPromise({
            try: () => {
              const request = async () => {
                const next = await Runtime.runPromise(runtime)(
                  control.WorkspaceCommand({
                    value: command,
                    expectedRevision: workspace.revision,
                    context,
                  }),
                );
                accept(parseWorkspaceJson(next));
                return structuredClone(workspace);
              };
              const queued = commandQueue.then(request);
              commandQueue = queued.then(
                () => {},
                () => {},
              );
              return queued;
            },
            catch: (error) => new SessionClientError({ message: String(error) }),
          }),
        ),
      backend: () => daemonBackend(service, service.live),
      setBuffer: (name, data) => control.SetBuffer({ name, data }),
      pasteBuffer: (name, target, deleteAfter = false) =>
        control.PasteBuffer({ name, target, deleteAfter }),
      listBuffers: () => control.ListBuffers(),
      deleteBuffer: (name) => control.DeleteBuffer({ name }),
      showBuffer: (name) => control.ShowBuffer({ name }),
      close: () => attach.close(),
      // A daemon that dies mid-response is a successful stop, so transport
      // failures here are expected rather than reported.
      stop: () => control.Stop().pipe(Effect.catchAll(() => Effect.void)),
    };
    return service;
  });

export function daemonAlive(
  id: string,
): Effect.Effect<boolean, never, SessionEnv | Session | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const lease = yield* Session.readLease(id).pipe(Effect.orElseSucceed(() => null));
    if (!lease || !processAlive(lease.pid)) return false;
    return yield* controlCall(id, (control) => control.Ping()).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });
}

export function ensureDaemon(
  id: string,
): Effect.Effect<void, SessionClientError, SessionEnv | Session | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (yield* daemonAlive(id)) return;
    const env = yield* SessionEnv;
    const entry = new URL("./daemon-main.ts", import.meta.url).pathname;
    const child = yield* Effect.try({
      try: () => spawn(process.execPath, [entry, id], { detached: true, stdio: "ignore", env }),
      catch: (error) => new SessionClientError({ message: String(error) }),
    });
    child.unref();
    const daemonReady = daemonAlive(id).pipe(
      Effect.filterOrFail(
        Boolean,
        () => new SessionClientError({ message: "daemon is not ready" }),
      ),
    );
    yield* daemonReady.pipe(
      Effect.retry(
        Schedule.spaced(`${POLL_MS} millis`).pipe(Schedule.upTo(`${START_TIMEOUT_MS} millis`)),
      ),
      Effect.mapError(
        () =>
          new SessionClientError({
            message: `daemon for session '${id}' did not start within ${START_TIMEOUT_MS}ms`,
          }),
      ),
    );
  });
}
