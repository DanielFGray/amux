import { Effect, Ref, Schema as S, Scope, Stream } from "effect"
import { readPty, spawnPty } from "../pty.ts"

export class PtyError extends S.TaggedError<PtyError>()("PtyError", {
  operation: S.String,
  message: S.String,
}) {}

export interface PtySpec {
  readonly id: string
  readonly cmd: readonly string[]
  readonly cwd?: string
  readonly cols: number
  readonly rows: number
}

export interface ManagedPty {
  readonly id: string
  readonly output: Stream.Stream<Uint8Array, PtyError>
  readonly write: (data: string | Uint8Array) => Effect.Effect<void, PtyError>
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, PtyError>
  readonly kill: Effect.Effect<void, PtyError>
}

const asPtyError = (operation: string, error: unknown): PtyError =>
  new PtyError({
    operation,
    message: error instanceof Error ? error.message : String(error),
  })

/**
 * Scoped ownership for daemon-side PTYs.
 *
 * The registry deliberately stops at the PTY boundary. Ghostty emulation and
 * pane rendering remain imperative; this service owns process lifetime and
 * turns raw PTY output into a supervised Effect stream.
 */
export class PtyRegistry extends Effect.Service<PtyRegistry>()("PtyRegistry", {
  effect: Effect.gen(function* () {
    const sessions = yield* Ref.make<ReadonlySet<string>>(new Set())

    const spawn = (spec: PtySpec): Effect.Effect<ManagedPty, PtyError, Scope.Scope> =>
      Effect.gen(function* () {
        const pty = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              spawnPty([...spec.cmd], {
                cols: spec.cols,
                rows: spec.rows,
                cwd: spec.cwd,
              }),
            catch: (error) => asPtyError("spawn", error),
          }),
          (owned) =>
            Effect.sync(() => {
              owned.kill()
              owned.close()
            }).pipe(Effect.zipRight(Ref.update(sessions, (current) => {
              const next = new Set(current)
              next.delete(spec.id)
              return next
            }))),
        )

        yield* Ref.update(sessions, (current) => new Set(current).add(spec.id))

        const operation = <A>(name: string, run: () => A): Effect.Effect<A, PtyError> =>
          Effect.try({ try: run, catch: (error) => asPtyError(name, error) })

        return {
          id: spec.id,
          output: Stream.fromAsyncIterable(readPty(pty), (error) => asPtyError("read", error)),
          write: (data) => operation("write", () => pty.write(data)),
          resize: (cols, rows) => operation("resize", () => pty.resize(cols, rows)),
          kill: operation("kill", () => pty.kill()),
        } satisfies ManagedPty
      })

    return {
      spawn,
      sessions: Ref.get(sessions),
    }
  }),
}) {}
