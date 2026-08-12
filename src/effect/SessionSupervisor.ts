import { Context, Deferred, Effect, FiberMap, Layer, Match, Ref, Stream } from "effect";
import { MODE_BRACKETED_PASTE, Terminal } from "../ghostty.ts";
import { formatScreen } from "../shim.ts";
import { AttachHub } from "./AttachHub.ts";
import {
  isAgentEventPayload,
  type AgentEventPayload,
  type AgentFrame,
  type AttachFrame,
} from "./AttachProtocol.ts";
import { AgentLog } from "./AgentLog.ts";
import {
  PtyError,
  SessionRegistry,
  type ManagedSession,
  type SessionForeground,
  type SessionSpec,
} from "./SessionRegistry.ts";
import { isTerminalSize } from "../limits.ts";
import { AgentState, type ReportedAgentState } from "../agent-state.ts";

const BRACKETED_PASTE_START = new TextEncoder().encode("\x1b[200~");
const BRACKETED_PASTE_END = new TextEncoder().encode("\x1b[201~");

/**
 * How often a session's foreground process group is re-read on the daemon
 * side.
 *
 * Mirrors the client's AGENT_POLL_MS: a process starting is a human-paced
 * event, and the sidebar's cache is re-read at that same cadence. Reading
 * tcgetpgrp is one cheap syscall per live session, so polling is not a cost
 * worth being clever about — the alternative (an event from the pty) does not
 * exist.
 */
const FOREGROUND_POLL_MS = 500;

export interface SessionExitObserverService {
  readonly beforePublish: (id: string, code: number | null) => Effect.Effect<void, unknown>;
}

export interface SessionStateObserverService {
  readonly onState: (id: string, state: ReportedAgentState) => Effect.Effect<void, unknown>;
}

export class SessionStateObserver extends Context.Reference<SessionStateObserver>()(
  "SessionStateObserver",
  {
    defaultValue: (): SessionStateObserverService => ({
      onState: () => Effect.void,
    }),
  },
) {}

/** Durability barrier between backend termination and the observable exit frame. */
export class SessionExitObserver extends Context.Reference<SessionExitObserver>()(
  "SessionExitObserver",
  {
    defaultValue: (): SessionExitObserverService => ({ beforePublish: () => Effect.void }),
  },
) {}

export interface PreparedSession {
  readonly session: ManagedSession;
  /** Admit the session into the committed model and release any pending exit. */
  readonly activate: Effect.Effect<void>;
  /** Terminate an uncommitted session without consulting the workspace authority. */
  readonly abort: Effect.Effect<void>;
}

/** Wrap bytes in the bracketed-paste escapes, for a child that asked for them. */
const bracketPaste = (data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(
    BRACKETED_PASTE_START.length + data.length + BRACKETED_PASTE_END.length,
  );
  out.set(BRACKETED_PASTE_START);
  out.set(data, BRACKETED_PASTE_START.length);
  out.set(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length + data.length);
  return out;
};

/**
 * Connects daemon-owned sessions — pty or agent — to the attach data plane.
 *
 * A single FiberMap entry supervises each session's output and exit
 * publication. The backend itself remains scoped by SessionRegistry, outside
 * any client scope, so a UI disconnect cannot kill the session. Nothing here
 * branches on kind: a pty and a native agent session are adopted, killed and
 * replayed through the identical path.
 */
export class SessionSupervisor extends Effect.Service<SessionSupervisor>()("SessionSupervisor", {
  // scoped for the same reason as SessionRegistry: the per-session output pumps are
  // a FiberMap, and they belong to the supervisor rather than to any caller.
  scoped: Effect.gen(function* () {
    const registry = yield* SessionRegistry;
    const hub = yield* AttachHub;
    const exitObserver = yield* SessionExitObserver;
    const stateObserver = yield* SessionStateObserver;
    const agentLog = yield* AgentLog;
    const sessions = yield* Ref.make<ReadonlyMap<string, ManagedSession>>(new Map());
    const completions = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<void>>>(new Map());
    const terminations = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<number | null>>>(
      new Map(),
    );
    const reservations = yield* Ref.make<ReadonlySet<string>>(new Set());
    // The daemon-side screen model per session. A reattaching client has none
    // of an adopted session's history, so its pane would be blank until the
    // program next redraws; this terminal is what lets the daemon answer an
    // adoption with the session's current screen. scrollback 0: only the
    // active screen is ever needed, and an emulator per session is cost enough
    // without history.
    const replays = yield* Ref.make<ReadonlyMap<string, Terminal>>(new Map());
    /** Per-session entry point for state a process reports about itself. The
     *  error channel is the observer's own `unknown` (see ts-f58aa1), not the
     *  log's: ingest can fail either way and the caller cannot tell them apart
     *  until both are typed. */
    const reporters = yield* Ref.make<
      ReadonlyMap<string, (state: ReportedAgentState) => Effect.Effect<void, unknown>>
    >(new Map());
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

    // A live session's pump is permanently stuck reading session.output: the
    // stream's iterator.next() call is a plain, unabortable promise, so a
    // fiber blocked inside it cannot notice interruption until the promise
    // itself resolves — which only happens once the backend is killed. If
    // scope teardown relied on interrupting the pump to trigger that kill (as
    // it used to, via the pump's own Effect.ensuring below), nothing would
    // ever run: the pump waits on the kill, the kill waits on the pump.
    // Registered after the pump map, so by LIFO it runs first and kills every
    // live backend directly, which lets each pump's in-flight read finish on
    // its own — the map's own interrupt-and-join finalizer then has nothing
    // left to wait for.
    yield* Effect.addFinalizer(() =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) =>
          Effect.forEach([...current.values()], (session) => session.kill.pipe(Effect.ignore), {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      ),
    );

    const dropScreen = Effect.fnUntraced(function* (id: string, expected?: Terminal) {
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

    const dropSession = Effect.fnUntraced(function* (
      id: string,
      session: ManagedSession,
      screen?: Terminal,
    ) {
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
      yield* Ref.update(terminations, (current) => {
        if (!current.has(id)) return current;
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      yield* Ref.update(reporters, (current) => {
        if (!current.has(id)) return current;
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      yield* dropScreen(id, screen);
      yield* releaseReservation(id);
    });

    const prepare = Effect.fnUntraced(function* (spec: SessionSpec) {
      if (!isTerminalSize(spec.cols, spec.rows)) {
        return yield* new PtyError({ operation: "spawn", message: "invalid terminal size" });
      }
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
      const session = yield* registry
        .spawn(spec)
        .pipe(Effect.tapError(() => releaseReservation(spec.id)));
      const screen = yield* Effect.sync(() => new Terminal(spec.cols, spec.rows, 0));
      const completion = yield* Deferred.make<void>();
      const termination = yield* Deferred.make<number | null>();
      const disposition = yield* Deferred.make<"active" | "aborted">();
      let phase: "prepared" | "activating" | "active" | "aborted" = "prepared";
      const pending: Uint8Array[] = [];
      const pendingEvents: AgentFrame[] = [];
      let lastAgentState: ReportedAgentState | null = null;
      let exitPublished = false;

      const publishExit = (code: number | null) =>
        Effect.suspend(() =>
          exitPublished
            ? Effect.void
            : exitObserver.beforePublish(spec.id, code).pipe(
                Effect.zipRight(
                  Effect.sync(() => {
                    if (exitPublished) return false;
                    exitPublished = true;
                    return true;
                  }),
                ),
                Effect.flatMap((publish) =>
                  publish
                    ? hub.publish({ _tag: "exit", session: spec.id, code } satisfies AttachFrame)
                    : Effect.void,
                ),
              ),
        );
      const complete = dropSession(spec.id, session, screen).pipe(
        Effect.zipRight(Deferred.succeed(completion, void 0)),
      );
      const foreground = Effect.gen(function* () {
        const publish = (fg: SessionForeground) =>
          hub.publish({
            _tag: "foreground",
            session: spec.id,
            pgid: fg.pgid,
            sid: fg.sid,
          } satisfies AttachFrame);
        let last = yield* Effect.sync(() => session.foreground());
        yield* publish(last);
        while (
          yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(spec.id) === session))
        ) {
          yield* Effect.sleep(FOREGROUND_POLL_MS);
          const next = yield* Effect.sync(() => session.foreground());
          if (next.pgid !== last.pgid || next.sid !== last.sid) {
            last = next;
            yield* publish(next);
          }
        }
      });

      yield* FiberMap.run(
        pumps,
        `prepared:${spec.id}`,
        Effect.gen(function* () {
          yield* session.output.pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                // The replay terminal is the private output buffer. Only bytes
                // arriving while activation drains that replay need a side queue.
                screen.write(chunk);
                if (phase === "active") {
                  yield* hub.publish({
                    _tag: "output",
                    session: spec.id,
                    data: chunk,
                  } satisfies AttachFrame);
                } else if (phase === "activating") pending.push(new Uint8Array(chunk));
              }),
            ),
            Effect.catchAll((error) =>
              Effect.logDebug(`session output ended: ${error.operation}: ${error.message}`),
            ),
          );
          const code = yield* session.exit.pipe(Effect.orElseSucceed(() => null));
          yield* Deferred.succeed(termination, code);
          if ((yield* Deferred.await(disposition)) === "active") {
            // An agent's process ending is an agent lifecycle event; a
            // component's is not, and the two are only the same thing while
            // every component happens to be an agent.
            if (spec.agent && code !== null) {
              const failed = yield* agentLog.append({
                _tag: "agent.status",
                session: spec.id,
                state: AgentState.Failed,
              });
              yield* stateObserver.onState(spec.id, AgentState.Failed);
              yield* hub.publish(failed);
            }
            yield* publishExit(code);
          }
          yield* complete;
        }).pipe(
          Effect.ensuring(
            Effect.uninterruptible(
              session.kill.pipe(
                Effect.ignore,
                Effect.zipRight(session.exit.pipe(Effect.orElseSucceed(() => null))),
                Effect.tap((code) => Deferred.succeed(termination, code)),
                Effect.zipRight(Deferred.succeed(disposition, "aborted")),
                Effect.zipRight(complete),
              ),
            ),
          ),
        ),
      );

      /**
       * The one door every agent event enters by, whoever produced it.
       *
       * A payload is committed to the session log before anybody hears about
       * it, so an observer cannot see a state the log does not have and a
       * replaying client cannot miss an edge a live client saw. Events that
       * arrive before activation are held, not dropped: a prepared session is
       * absent from the hub, and publishing there would address nobody.
       */
      const ingest = (event: AgentFrame | AgentEventPayload) =>
        Effect.gen(function* () {
          const committed = isAgentEventPayload(event) ? yield* agentLog.append(event) : event;
          if (committed._tag === "agent.status" && committed.state !== lastAgentState) {
            lastAgentState = committed.state;
            yield* stateObserver.onState(spec.id, committed.state);
          }
          if (phase === "active") yield* hub.publish(committed);
          else pendingEvents.push(committed);
        });

      // A foreign agent reporting over the control socket is the same fact as
      // our own harness emitting `agent.status`, so it takes the same door and
      // lands in the same log. Without this a self-reported state would be live
      // only, and a watcher resuming from a cursor would never see it.
      yield* Ref.update(reporters, (current) =>
        new Map(current).set(spec.id, (state: ReportedAgentState) =>
          ingest({ _tag: "agent.status", session: spec.id, state }),
        ),
      );

      if (session.events) {
        yield* FiberMap.run(
          pumps,
          `events:${spec.id}`,
          session.events.pipe(Stream.runForEach(ingest)),
        );
      }

      const activate = Effect.suspend(() => {
        if (phase !== "prepared") return Effect.void;
        phase = "activating";
        return Effect.gen(function* () {
          yield* Ref.update(replays, (current) => new Map(current).set(spec.id, screen));
          yield* Ref.update(sessions, (current) => new Map(current).set(spec.id, session));
          yield* Ref.update(completions, (current) => new Map(current).set(spec.id, completion));
          yield* Ref.update(terminations, (current) => new Map(current).set(spec.id, termination));
          const replay = yield* Effect.sync(() => formatScreen(screen.handle));
          if (replay.length > 0) {
            yield* hub.publish({
              _tag: "output",
              session: spec.id,
              data: replay,
            } satisfies AttachFrame);
          }
          while (pending.length > 0) {
            yield* hub.publish({
              _tag: "output",
              session: spec.id,
              data: pending.shift()!,
            } satisfies AttachFrame);
          }
          while (pendingEvents.length > 0) yield* hub.publish(pendingEvents.shift()!);
          phase = "active";
          yield* FiberMap.run(pumps, `foreground:${spec.id}`, foreground);
          yield* Deferred.succeed(disposition, "active");
        });
      });
      const abort = Effect.suspend(() => {
        if (phase === "prepared") phase = "aborted";
        return Deferred.succeed(disposition, "aborted").pipe(
          Effect.zipRight(session.kill.pipe(Effect.ignore)),
          Effect.zipRight(Deferred.await(termination)),
          Effect.zipRight(Deferred.await(completion)),
        );
      });
      return { session, activate, abort } satisfies PreparedSession;
    });
    const spawn = Effect.fnUntraced(function* (spec: SessionSpec) {
      const prepared = yield* prepare(spec);
      yield* prepared.activate;
      return prepared.session;
    });

    return {
      prepare,
      spawn,
      /**
       * A process's report about itself, from the control socket.
       *
       * Unknown sessions are ignored rather than failed: the reporter is a hook
       * inside somebody else's agent, and a pane that closed while its hook was
       * mid-write is ordinary, not an error anyone can act on.
       */
      report: (id: string, state: ReportedAgentState) =>
        Ref.get(reporters).pipe(
          Effect.flatMap((current) => current.get(id)?.(state) ?? Effect.void),
        ),

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
                if (!isTerminalSize(command.cols, command.rows)) {
                  return yield* new PtyError({
                    operation: "resize",
                    message: "invalid terminal size",
                  });
                }
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
            }),
          ),
          Match.tag("agent.prompt", (command) =>
            Effect.gen(function* () {
              const session = (yield* Ref.get(sessions)).get(command.session);
              if (!session) return;
              yield* session.prompt(command.text);
            }),
          ),
          Match.tag("agent.permission", (command) =>
            Effect.gen(function* () {
              const session = (yield* Ref.get(sessions)).get(command.session);
              if (!session) return;
              yield* session.decide({
                request: command.request,
                decision: command.decision,
                ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
              });
            }),
          ),
          Match.tag("agent.interrupt", (command) =>
            Effect.gen(function* () {
              const session = (yield* Ref.get(sessions)).get(command.session);
              if (!session) return;
              yield* session.interrupt(command.reason);
            }),
          ),
          Match.orElse(() => Effect.void),
        );
      }),

      capture: Effect.fnUntraced(function* (id: string) {
        const screen = (yield* Ref.get(replays)).get(id);
        if (!screen) {
          return yield* new PtyError({ operation: "capture", message: `unknown session '${id}'` });
        }
        return new TextDecoder().decode(yield* Effect.sync(() => formatScreen(screen.handle)));
      }),

      /** Replay an adopted session's screen to the client that asked for it. */
      sync: Effect.fnUntraced(function* (
        client: string,
        connection: string,
        id: string,
        after?: number,
      ) {
        const session = (yield* Ref.get(sessions)).get(id);
        // "Bring me up to date" includes which process is in the foreground.
        // The poller only publishes changes, so an adopting client would stay
        // blind until the next one without this — exactly the reattach case a
        // session outliving its client exists for.
        if (session) {
          const fg = yield* Effect.sync(() => session.foreground());
          yield* hub.publishTo(client, connection, {
            _tag: "foreground",
            session: id,
            pgid: fg.pgid,
            sid: fg.sid,
          } satisfies AttachFrame);
        }
        if (session?.kind === "component") {
          // A component has no screen to replay — its content is the frames it
          // emitted, and the worker's own terminal is not those frames.
          const history = yield* agentLog.read(id, after);
          for (const event of history) yield* hub.publishTo(client, connection, event);
          return;
        }
        const screen = (yield* Ref.get(replays)).get(id);
        if (!screen) return;
        const data = yield* Effect.sync(() => formatScreen(screen.handle));
        yield* hub.publishTo(client, connection, {
          _tag: "output",
          session: id,
          data,
        } satisfies AttachFrame);
      }),

      /**
       * Write a server-owned buffer into a session, the way tmux paste-buffer
       * does.
       *
       * The bytes are written on the daemon's side of the PTY, so a paste needs
       * no attached client — that is the whole point of the buffers living on
       * the server. When the child has enabled bracketed paste (DECSET 2004),
       * the bytes arrive wrapped, exactly as tmux wraps them, so a paste into
       * vim or a shell does not reflow or run lines as it lands. The mode is
       * read from the session's own screen model, which is the emulator's
       * answer rather than a guess.
       */
      paste: Effect.fnUntraced(function* (id: string, data: Uint8Array) {
        const session = (yield* Ref.get(sessions)).get(id);
        if (!session) {
          return yield* new PtyError({
            operation: "paste",
            message: `unknown session '${id}'`,
          });
        }
        const screen = (yield* Ref.get(replays)).get(id);
        const bytes = screen?.mode(MODE_BRACKETED_PASTE) ? bracketPaste(data) : data;
        yield* session.write(bytes);
      }),

      live: Ref.get(sessions).pipe(Effect.map((current) => [...current.keys()])),

      kill: Effect.fnUntraced(function* (id: string) {
        const session = (yield* Ref.get(sessions)).get(id);
        // If the process exited between the workspace-level kill decision
        // and this call, the session is already gone — which is success.
        if (!session) return;
        const termination = (yield* Ref.get(terminations)).get(id);
        yield* session.kill;
        if (termination) yield* Deferred.await(termination);
      }),
    };
  }),
}) {
  static Live = SessionSupervisor.Default.pipe(Layer.provide(SessionRegistry.Default));
}
