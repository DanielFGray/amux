import { Deferred, Effect, FiberMap, Layer, Match, Ref, Scope, Stream } from "effect";
import { Terminal } from "../ghostty.ts";
import { formatScreen } from "../shim.ts";
import { AttachHub } from "./AttachHub.ts";
import { type AttachFrame } from "./AttachProtocol.ts";
import { PtyError, SessionRegistry, type ManagedSession, type SessionSpec } from "./SessionRegistry.ts";

/**
 * Connects daemon-owned sessions — pty or agent — to the attach data plane.
 *
 * A single FiberMap entry supervises each session's output and exit
 * publication. The backend itself remains scoped by SessionRegistry, outside
 * any client scope, so a UI disconnect cannot kill the session. Nothing here
 * branches on kind: a pty and a stub agent session are adopted, killed and
 * replayed through the identical path.
 */
export class SessionSupervisor extends Effect.Service<SessionSupervisor>()("SessionSupervisor", {
  // scoped for the same reason as SessionRegistry: the per-session output pumps are
  // a FiberMap, and they belong to the supervisor rather than to any caller.
  scoped: Effect.gen(function* () {
    const registry = yield* SessionRegistry;
    const hub = yield* AttachHub;
    const sessions = yield* Ref.make<ReadonlyMap<string, ManagedSession>>(new Map());
    const completions = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<void>>>(new Map());
    const reservations = yield* Ref.make<ReadonlySet<string>>(new Set());
    // The daemon-side screen model per session. A reattaching client has none
    // of an adopted session's history, so its pane would be blank until the
    // program next redraws; this terminal is what lets the daemon answer an
    // adoption with the session's current screen. scrollback 0: only the
    // active screen is ever needed, and an emulator per session is cost enough
    // without history.
    const replays = yield* Ref.make<ReadonlyMap<string, Terminal>>(new Map());
    yield* Effect.addFinalizer(() =>
      Ref.get(replays).pipe(
        Effect.flatMap((screens) =>
          Effect.sync(() => {
            for (const screen of screens.values()) screen.free();
          }),
        ),
      ),
    );
    // Register the screen finalizer before the pump map so scope teardown
    // interrupts pumps before freeing the terminals they may still touch.
    const pumps = yield* FiberMap.make<string>();

    const dropScreen = (id: string, expected?: Terminal) =>
      Effect.gen(function* () {
        const screen = yield* Ref.modify(replays, (current) => {
          const screen = current.get(id);
          if (!screen || (expected && screen !== expected)) return [undefined, current] as const;
          const next = new Map(current);
          next.delete(id);
          return [screen, next] as const;
        });
        if (screen) screen.free();
      });

    const releaseReservation = (id: string) =>
      Ref.update(reservations, (current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });

    const dropSession = (id: string, session: ManagedSession, screen?: Terminal) =>
      Effect.gen(function* () {
        yield* Ref.update(sessions, (current) => {
          if (current.get(id) !== session) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        yield* Ref.update(completions, (current) => {
          if (!current.has(id)) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        yield* dropScreen(id, screen);
        yield* releaseReservation(id);
      });

    return {
      spawn: Effect.fnUntraced(function* (spec: SessionSpec) {
        const reserved = yield* Ref.modify(reservations, (current) => {
          if (current.has(spec.id)) return [false, current] as const;
          return [true, new Set(current).add(spec.id)] as const;
        });
        if (!reserved) {
          return yield* new PtyError({
            operation: "spawn",
            message: `session '${spec.id}' is already live or starting`,
          });
        }
        const session = yield* registry.spawn(spec).pipe(Effect.tapError(() => releaseReservation(spec.id)));
        // Sized before the pump runs: the first chunk the backend produces is
        // fed to both the hub and the screen model, so the model must exist
        // first.
        let screen: Terminal | undefined;
        yield* Effect.gen(function* () {
          screen = yield* Effect.sync(() => new Terminal(spec.cols, spec.rows, 0));
          const completion = yield* Deferred.make<void>();
          let exitPublished = false;
          const publishExit = (code: number | null) =>
            Effect.sync(() => {
              if (exitPublished) return false;
              exitPublished = true;
              return true;
            }).pipe(
              Effect.flatMap((shouldPublish) =>
                shouldPublish
                  ? hub.publish({ _tag: "exit", session: spec.id, code } satisfies AttachFrame)
                  : Effect.void,
              ),
            );
          const complete = dropSession(spec.id, session, screen).pipe(
            Effect.zipRight(Deferred.succeed(completion, void 0)),
          );
          yield* Ref.update(replays, (current) => new Map(current).set(spec.id, screen!));
          yield* Ref.update(sessions, (current) => new Map(current).set(spec.id, session));
          yield* Ref.update(completions, (current) => new Map(current).set(spec.id, completion));
          yield* FiberMap.run(
            pumps,
            spec.id,
            Effect.gen(function* () {
              yield* session.output.pipe(
                Stream.runForEach((chunk) =>
                  Effect.gen(function* () {
                    // readPty reuses its backing buffer, so the screen model must
                    // take its bytes before the frame's copy does: the write is
                    // synchronous, then the copy is owned by the queued frame.
                    screen!.write(chunk);
                    yield* hub.publish({
                      _tag: "output",
                      session: spec.id,
                      data: new Uint8Array(chunk),
                    } satisfies AttachFrame);
                  }),
                ),
                Effect.catchAll((error) =>
                  Effect.logDebug(`session output ended: ${error.operation}: ${error.message}`),
                ),
              );
              const code = yield* session.exit.pipe(Effect.orElseSucceed(() => null));
              yield* publishExit(code);
              yield* complete;
            }).pipe(
              Effect.ensuring(
                Effect.uninterruptible(
                  session.kill.pipe(
                    Effect.ignore,
                    Effect.zipRight(session.exit.pipe(Effect.orElseSucceed(() => null))),
                    Effect.zipRight(publishExit(null)),
                    Effect.zipRight(complete),
                  ),
                ),
              ),
            ),
          );
        }).pipe(
          Effect.tapError(() => dropSession(spec.id, session, screen).pipe(
            Effect.zipRight(session.kill.pipe(Effect.ignore)),
            Effect.zipRight(session.exit.pipe(Effect.ignore)),
          )),
        );
        return session;
      }),

      handle: Effect.fnUntraced(function* (frame: AttachFrame) {
        yield* Match.value(frame).pipe(
          Match.tag("input", "resize", (command) =>
            Effect.gen(function* () {
              const session = (yield* Ref.get(sessions)).get(command.session);
              if (!session) {
                return yield* new PtyError({
                  operation: command._tag,
                  message: `unknown session '${command.session}'`,
                });
              }
              if (command._tag === "resize") {
                // Size the screen model before the backend: a pty's child
                // redraws in response to SIGWINCH, and the redraw must land on
                // a model that is already the right size. The model resize is
                // synchronous; the backend resize goes through its command
                // pump, so the ordering is safe by construction.
                (yield* Ref.get(replays)).get(command.session)?.resize(command.cols, command.rows);
              }
              yield* Match.value(command).pipe(
                Match.tag("input", (input) => session.write(input.data)),
                Match.tag("resize", (resize) => session.resize(resize.cols, resize.rows)),
                Match.exhaustive,
              );
            })),
          Match.orElse(() => Effect.void),
        );
      }),

      /** Replay an adopted session's screen to the client that asked for it. */
      sync: Effect.fnUntraced(function* (client: string, connection: string, id: string) {
        const screen = (yield* Ref.get(replays)).get(id);
        if (!screen) return;
        const data = yield* Effect.sync(() => formatScreen(screen.handle));
        yield* hub.publishTo(client, connection, { _tag: "output", session: id, data } satisfies AttachFrame);
      }),

      live: Ref.get(sessions).pipe(Effect.map((current) => [...current.keys()])),

      kill: Effect.fnUntraced(function* (id: string) {
        const session = (yield* Ref.get(sessions)).get(id);
        if (!session)
          return yield* new PtyError({ operation: "kill", message: `unknown session '${id}'` });
        const completion = (yield* Ref.get(completions)).get(id);
        yield* session.kill;
        if (completion) yield* Deferred.await(completion);
      }),
    };
  }),
}) {
  static Live = SessionSupervisor.Default.pipe(Layer.provide(SessionRegistry.Default));
}
