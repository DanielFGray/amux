import {
  Deferred,
  Effect,
  FiberMap,
  Mailbox,
  Match,
  Ref,
  Schema as S,
  Scope,
  Stream,
} from "effect";
import { PtyWriteInterrupted, readPty, spawnPty } from "../pty.ts";
import { isTerminalSize } from "../limits.ts";

export class PtyError extends S.TaggedError<PtyError>()("PtyError", {
  operation: S.String,
  message: S.String,
}) {}

/** What runs behind a session. A pty is a real process today; an agent is a
 *  stub until the out-of-process LLM backend (ts-a3d8cf) lands. */
export type SessionKind = "pty" | "agent";

export interface SessionSpec {
  /** Defaults to "pty": every caller that predates agent sessions is silently
   *  still asking for one. */
  readonly kind?: SessionKind;
  readonly id: string;
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
}

export interface ManagedSession {
  readonly id: string;
  readonly kind: SessionKind;
  readonly output: Stream.Stream<Uint8Array, PtyError>;
  readonly exit: Effect.Effect<number | null, PtyError>;
  readonly write: (data: string | Uint8Array) => Effect.Effect<void, PtyError>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, PtyError>;
  readonly kill: Effect.Effect<void, PtyError>;
  /** What is in the foreground of this session's tty right now. Only the
   *  daemon can answer: the tty's foreground process group is read through
   *  the master, which lives here. See the `foreground` attach frame. */
  readonly foreground: () => SessionForeground;
}

/** The foreground of a session's tty, as the owner sees it. A session with no
 *  process behind it (an agent stub) reports -1 for both. */
export interface SessionForeground {
  /** Foreground process group of the controlling tty, or -1. Equal to `sid`
   *  while a shell sits at a prompt; a different value means a command is
   *  running in the foreground. */
  readonly pgid: number;
  /** Session id = the session leader's pid, or -1 when it is not knowable. */
  readonly sid: number;
}

type SessionCommand =
  | {
      readonly _tag: "resize";
      readonly cols: number;
      readonly rows: number;
      readonly done: Deferred.Deferred<void, PtyError>;
    }
  | { readonly _tag: "kill"; readonly done: Deferred.Deferred<void, PtyError> };

/**
 * What the registry needs from whatever is behind a session, independent of
 * kind. A real Pty satisfies this structurally; the agent stub below
 * satisfies it by construction. Nothing past this boundary knows which one
 * it has.
 */
interface Backend {
  readonly output: AsyncIterable<Uint8Array>;
  /** Resolves once the backend has fully terminated, with its exit code. */
  readonly wait: Promise<number | null>;
  write(data: string | Uint8Array, signal?: AbortSignal): Promise<void>;
  resize(cols: number, rows: number): void;
  kill(): Promise<void>;
  close(): void;
  foreground(): SessionForeground;
}

function ptyBackend(spec: SessionSpec): Backend {
  const pty = spawnPty([...spec.cmd], {
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
  });
  return {
    output: readPty(pty),
    // A getter, not a field: `pty.wait` itself begins termination as a side
    // effect of being read (see pty.ts), so evaluating it here eagerly would
    // kill the child the instant a backend is constructed instead of when
    // something actually awaits exit.
    get wait() {
      return pty.wait.then(() => pty.exitCode);
    },
    write: (data, signal) => pty.write(data, signal),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    close: () => pty.close(),
    // The two questions only the tty owner can answer — read through the
    // master fd this process holds. sessionId() caches its value internally,
    // so repeated reads are one syscall each.
    foreground: () => ({ pgid: pty.foregroundPgid(), sid: pty.sessionId() }),
  };
}

/**
 * A registrable session with no process behind it.
 *
 * Until the real out-of-process agent backend exists, this is what lets an
 * agent-kind session be spawned, listed, focused and killed through exactly
 * the same registry/supervisor paths as a pty — so nothing downstream has to
 * special-case the kind to be exercised. It produces no output and accepts
 * no input; it just holds the id live until kill() or close() ends it, with
 * no exit code because nothing exited.
 */
function agentStubBackend(): Backend {
  let resolveWait!: (code: number | null) => void;
  const wait = new Promise<number | null>((resolve) => {
    resolveWait = resolve;
  });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    resolveWait(null);
  };
  return {
    output: (async function* () {
      await wait;
    })(),
    wait,
    write: async () => {},
    resize: () => {},
    kill: async () => finish(),
    close: () => finish(),
    // Nothing runs behind a stub, so nothing is in the foreground.
    foreground: () => ({ pgid: -1, sid: -1 }),
  };
}

type Reservation = { readonly token: symbol; readonly backend?: Backend };

const asPtyError = (operation: string, error: unknown): PtyError =>
  new PtyError({
    operation,
    message: error instanceof Error ? error.message : String(error),
  });

/**
 * Scoped ownership for daemon-side sessions, pty or agent.
 *
 * The registry deliberately stops at the backend boundary. Ghostty emulation
 * and pane rendering remain imperative; this service owns process lifetime
 * and turns raw backend output into a supervised Effect stream, whatever the
 * backend behind a given session id turns out to be.
 */
export class SessionRegistry extends Effect.Service<SessionRegistry>()("SessionRegistry", {
  // scoped, not effect: the command pumps are a FiberMap that has to be
  // finalized, and the scope that owns it is the registry's own lifetime.
  scoped: Effect.gen(function* () {
    // The token prevents a late exit from an old backend from releasing a reused id.
    const sessions = yield* Ref.make<ReadonlyMap<string, Reservation>>(new Map());
    const commandPumps = yield* FiberMap.make<string>();

    const spawn = (spec: SessionSpec): Effect.Effect<ManagedSession, PtyError, Scope.Scope> =>
      Effect.gen(function* () {
        if (!isTerminalSize(spec.cols, spec.rows)) {
          return yield* new PtyError({ operation: "spawn", message: "invalid terminal size" });
        }
        const kind: SessionKind = spec.kind ?? "pty";
        const token = Symbol(spec.id);
        const reserved = yield* Ref.modify(sessions, (current) => {
          const existing = current.get(spec.id);
           // The leader may have exited while session members still run. The
           // reservation lasts until the whole-session termination barrier.
           if (existing) return [false, current] as const;
          const next = new Map(current);
          next.set(spec.id, { token });
          return [true, next] as const;
        });
        if (!reserved) {
          return yield* new PtyError({
            operation: "spawn",
            message: `session '${spec.id}' is already live or starting`,
          });
        }

        const release = Ref.update(sessions, (current) => {
          if (current.get(spec.id)?.token !== token) return current;
          const next = new Map(current);
          next.delete(spec.id);
          return next;
        });
        const backend = yield* Effect.acquireRelease(
          Effect.try({
            try: () => (kind === "agent" ? agentStubBackend() : ptyBackend(spec)),
            catch: (error) => asPtyError("spawn", error),
          }).pipe(Effect.tapError(() => release)),
           (owned) => Effect.uninterruptible(Effect.promise(() => owned.kill()).pipe(
             Effect.ensuring(Effect.sync(() => owned.close())),
             Effect.ensuring(release),
           )),
        );
        yield* Ref.update(sessions, (current) => {
          if (current.get(spec.id)?.token !== token) return current;
          const next = new Map(current);
          next.set(spec.id, { token, backend });
          return next;
        });
        const commands = yield* Mailbox.make<SessionCommand>({ capacity: 256, strategy: "suspend" });
        const runCommand = (command: SessionCommand) => {
          const operation = Match.valueTags(command, {
            resize: (command) => Effect.sync(() => backend.resize(command.cols, command.rows)),
             kill: () => Effect.promise(() => backend.kill()),
          });
          return operation.pipe(
            Effect.mapError((error) => asPtyError(command._tag, error)),
            Effect.exit,
            Effect.flatMap((exit) => Deferred.done(command.done, exit)),
            Effect.zipRight(command._tag === "kill" ? commands.end : Effect.void),
          );
        };
        yield* FiberMap.run(
          commandPumps,
          spec.id,
          Mailbox.toStream(commands).pipe(Stream.runForEach(runCommand)),
        );

        const offer = (command: SessionCommand): Effect.Effect<void, PtyError> =>
          commands.offer(command).pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.void
                : Effect.fail(
                    new PtyError({
                      operation: command._tag,
                      message: "session command pump is closed",
                    }),
                  ),
            ),
          );

        const commandResult = Effect.fnUntraced(function* (
          command: (done: Deferred.Deferred<void, PtyError>) => SessionCommand,
        ) {
          const done = yield* Deferred.make<void, PtyError>();
          yield* offer(command(done));
          yield* Deferred.await(done);
        });

        return {
          id: spec.id,
          kind,
          output: Stream.fromAsyncIterable(backend.output, (error) => asPtyError("read", error)),
           exit: Effect.tryPromise({
             try: () => backend.wait,
            catch: (error) => asPtyError("exit", error),
          }).pipe(Effect.ensuring(release)),
          write: (data) => Effect.tryPromise({
            try: (signal) => backend.write(data, signal),
            catch: (error) => error,
          }).pipe(
            Effect.catchAll((error) =>
              error instanceof PtyWriteInterrupted && error.reason === "shutdown"
                ? Effect.void
                : Effect.fail(asPtyError("write", error)),
            ),
          ),
          resize: (cols, rows) => isTerminalSize(cols, rows)
            ? commandResult((done) => ({ _tag: "resize", cols, rows, done }))
            : Effect.fail(new PtyError({ operation: "resize", message: "invalid terminal size" })),
          // Kill must not wait behind a write whose child stopped reading.
          kill: Effect.promise(() => backend.kill()),
          foreground: () => backend.foreground(),
        } satisfies ManagedSession;
      });

    return {
      spawn,
      sessions: Ref.get(sessions).pipe(Effect.map((current) => new Set(current.keys()))),
    };
  }),
}) {}
