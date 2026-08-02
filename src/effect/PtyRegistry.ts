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
import { readPty, spawnPty } from "../pty.ts";

export class PtyError extends S.TaggedError<PtyError>()("PtyError", {
  operation: S.String,
  message: S.String,
}) {}

export interface PtySpec {
  readonly id: string;
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
}

export interface ManagedPty {
  readonly id: string;
  readonly output: Stream.Stream<Uint8Array, PtyError>;
  readonly exit: Effect.Effect<number | null, PtyError>;
  readonly write: (data: string | Uint8Array) => Effect.Effect<void, PtyError>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, PtyError>;
  readonly kill: Effect.Effect<void, PtyError>;
}

type PtyCommand =
  | {
      readonly _tag: "resize";
      readonly cols: number;
      readonly rows: number;
      readonly done: Deferred.Deferred<void, PtyError>;
    }
  | { readonly _tag: "kill"; readonly done: Deferred.Deferred<void, PtyError> };

type Reservation = { readonly token: symbol; readonly pty?: ReturnType<typeof spawnPty> };

const asPtyError = (operation: string, error: unknown): PtyError =>
  new PtyError({
    operation,
    message: error instanceof Error ? error.message : String(error),
  });

/**
 * Scoped ownership for daemon-side PTYs.
 *
 * The registry deliberately stops at the PTY boundary. Ghostty emulation and
 * pane rendering remain imperative; this service owns process lifetime and
 * turns raw PTY output into a supervised Effect stream.
 */
export class PtyRegistry extends Effect.Service<PtyRegistry>()("PtyRegistry", {
  // scoped, not effect: the command pumps are a FiberMap that has to be
  // finalized, and the scope that owns it is the registry's own lifetime.
  scoped: Effect.gen(function* () {
    // The token prevents a late exit from an old PTY from releasing a reused id.
    const sessions = yield* Ref.make<ReadonlyMap<string, Reservation>>(new Map());
    const commandPumps = yield* FiberMap.make<string>();

    const spawn = (spec: PtySpec): Effect.Effect<ManagedPty, PtyError, Scope.Scope> =>
      Effect.gen(function* () {
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
        const pty = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              spawnPty([...spec.cmd], {
                cols: spec.cols,
                rows: spec.rows,
                cwd: spec.cwd,
              }),
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
          next.set(spec.id, { token, pty });
          return next;
        });
        const commands = yield* Mailbox.make<PtyCommand>({ capacity: 256, strategy: "suspend" });
        const runCommand = (command: PtyCommand) => {
          const operation = Match.valueTags(command, {
            resize: (command) => Effect.sync(() => pty.resize(command.cols, command.rows)),
             kill: () => Effect.promise(() => pty.kill()),
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

        const offer = (command: PtyCommand): Effect.Effect<void, PtyError> =>
          commands.offer(command).pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.void
                : Effect.fail(
                    new PtyError({
                      operation: command._tag,
                      message: "pty command pump is closed",
                    }),
                  ),
            ),
          );

        const commandResult = Effect.fnUntraced(function* (
          command: (done: Deferred.Deferred<void, PtyError>) => PtyCommand,
        ) {
          const done = yield* Deferred.make<void, PtyError>();
          yield* offer(command(done));
          yield* Deferred.await(done);
        });

        return {
          id: spec.id,
          output: Stream.fromAsyncIterable(readPty(pty), (error) => asPtyError("read", error)),
           exit: Effect.tryPromise({
             try: () => pty.wait.then(() => pty.proc.exitCode),
            catch: (error) => asPtyError("exit", error),
          }).pipe(Effect.ensuring(release)),
          write: (data) => Effect.tryPromise({
            try: (signal) => pty.write(data, signal),
            catch: (error) => asPtyError("write", error),
          }),
          resize: (cols, rows) => commandResult((done) => ({ _tag: "resize", cols, rows, done })),
          // Kill must not wait behind a write whose child stopped reading.
          kill: Effect.promise(() => pty.kill()),
        } satisfies ManagedPty;
      });

    return {
      spawn,
      sessions: Ref.get(sessions).pipe(Effect.map((current) => new Set(current.keys()))),
    };
  }),
}) {}
