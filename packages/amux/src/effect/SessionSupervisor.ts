import {
  Context,
  Deferred,
  Effect,
  FiberMap,
  Layer,
  Match,
  Queue,
  Ref,
  Schema as S,
  Stream,
} from "effect";
import { MODE_BRACKETED_PASTE, Terminal } from "../ghostty.ts";
import { formatScreen } from "../shim.ts";
import { AttachHub } from "./AttachHub.ts";
import {
  isAgentEventPayload,
  SESSION_STATE_TOPIC,
  type AgentEventPayload,
  type AgentFrame,
  type AttachFrame,
  type JsonValue,
  type Topic,
} from "./AttachProtocol.ts";
import { AgentLog, type AgentLogError } from "./AgentLog.ts";
import {
  PtyError,
  SessionRegistry,
  type ManagedSession,
  type SessionForeground,
  type SessionSpec,
} from "./SessionRegistry.ts";
import { isTerminalSize } from "../limits.ts";
import { ProcessState } from "../process-state.ts";

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

/** How long activation waits for the pump's first output before capturing the
 *  replay screen. A session that starts with output must have it in the replay,
 *  and the pump's first turn is a synchronous read, so this only has to outlast
 *  the pump's scheduling latency under load (measured up to ~30ms). An idle
 *  session never produces a chunk, so this bound is also what lets its
 *  activation proceed. */
const INITIAL_OUTPUT_GRACE_MS = 100;

const foregroundArgv = (foreground: SessionForeground): readonly string[] => {
  if (foreground.pgid <= 0 || foreground.pgid === foreground.sid) return [];
  try {
    const raw = require("node:fs").readFileSync(
      `/proc/${foreground.pgid}/cmdline`,
      "utf8",
    ) as string;
    return raw.split("\0").filter(Boolean);
  } catch {
    return [];
  }
};

export interface SessionExitObserverService {
  readonly beforePublish: (
    id: string,
    code: number | null,
  ) => Effect.Effect<void, SessionObserverError>;
}

export interface SessionStateObserverService {
  readonly onState: (id: string, state: string) => Effect.Effect<void, SessionObserverError>;
}

export class SessionObserverError extends S.TaggedError<SessionObserverError>()(
  "SessionObserverError",
  {
    message: S.String,
    operation: S.Literals(["exit", "state"]),
  },
) {}

export const SessionStateObserver = Context.Reference<SessionStateObserverService>(
  "SessionStateObserver",
  {
    defaultValue: (): SessionStateObserverService => ({
      onState: () => Effect.void,
    }),
  },
);

/** Durability barrier between backend termination and the observable exit frame. */
export const SessionExitObserver = Context.Reference<SessionExitObserverService>(
  "SessionExitObserver",
  {
    defaultValue: (): SessionExitObserverService => ({ beforePublish: () => Effect.void }),
  },
);

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
export class SessionSupervisor extends Context.Service<SessionSupervisor>()("SessionSupervisor", {
  // scoped for the same reason as SessionRegistry: the per-session output pumps are
  // a FiberMap, and they belong to the supervisor rather than to any caller.
  make: Effect.gen(function* () {
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
    /** Per-session entry point for a fact a process reports about itself, under
     *  a topic name the reporter names — `SESSION_STATE_TOPIC` for the generic
     *  idle/running/blocked/done self-report, anything else for a plugin-owned
     *  topic the reporter and its subscriber agree on privately. The error
     *  channel includes both durable log failures and observer failures:
     *  ingest can fail either way before the event reaches the hub. */
    const reporters = yield* Ref.make<
      ReadonlyMap<
        string,
        (
          topic: string,
          payload: JsonValue,
        ) => Effect.Effect<void, AgentLogError | SessionObserverError>
      >
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
      // The pump delivers the first batch of output asynchronously, and the
      // activation replay must include it: a client that adopts this session
      // sees the replay's cursor position, and a burst that missed it lands
      // wherever the empty replay left the cursor. Activation waits for this
      // before capturing the screen. An idle session produces no chunk, so the
      // wait is bounded — it exists to let the pump run, not to slow activation.
      const firstOutput = yield* Deferred.make<void>();
      let phase: "prepared" | "activating" | "active" | "aborted" = "prepared";
      const pending = yield* Queue.unbounded<Uint8Array>();
      const pendingEvents = yield* Queue.unbounded<AgentFrame>();
      let lastSessionState: string | null = null;
      let exitPublished = false;

      const publishExit = (code: number | null) =>
        Effect.suspend(() =>
          exitPublished
            ? Effect.void
            : exitObserver.beforePublish(spec.id, code).pipe(
                Effect.andThen(
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
        Effect.andThen(Deferred.succeed(completion, void 0)),
      );
      const foreground = Effect.gen(function* () {
        const read = () => {
          const foreground = session.foreground();
          return { ...foreground, argv: foregroundArgv(foreground) };
        };
        const publish = (fg: SessionForeground & { readonly argv: readonly string[] }) =>
          hub.publish({
            _tag: "foreground",
            session: spec.id,
            pgid: fg.pgid,
            sid: fg.sid,
            argv: fg.argv,
          } satisfies AttachFrame);
        let last = yield* Effect.sync(read);
        yield* publish(last);
        while (
          yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(spec.id) === session))
        ) {
          yield* Effect.sleep(FOREGROUND_POLL_MS);
          const next = yield* Effect.sync(read);
          if (
            next.pgid !== last.pgid ||
            next.sid !== last.sid ||
            next.argv.join("\0") !== last.argv.join("\0")
          ) {
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
                yield* Deferred.succeed(firstOutput, void 0);
                if (phase === "active") {
                  yield* hub.publish({
                    _tag: "output",
                    session: spec.id,
                    data: chunk,
                  } satisfies AttachFrame);
                } else if (phase === "activating")
                  yield* Queue.offer(pending, new Uint8Array(chunk));
              }),
            ),
            Effect.catch((error) =>
              Effect.logDebug(`session output ended: ${error.operation}: ${error.message}`),
            ),
          );
          yield* Deferred.succeed(firstOutput, void 0);
          const code = yield* session.exit.pipe(Effect.orElseSucceed(() => null));
          yield* Deferred.succeed(termination, code);
          if ((yield* Deferred.await(disposition)) === "active") {
            // A declared process integration gets a final state fact before
            // its exit frame. Core only ever writes a neutral ProcessState
            // here — whether the exit was clean is the `exit` frame's `code`,
            // which is the fact an agent-aware subscriber derives "failed"
            // from, not something this topic says.
            if (spec.agent && code !== null) {
              const done = yield* agentLog.append({
                _tag: "topic",
                session: spec.id,
                topic: SESSION_STATE_TOPIC,
                payload: ProcessState.Done,
              });
              yield* stateObserver.onState(spec.id, ProcessState.Done);
              yield* hub.publish(done);
            }
            yield* publishExit(code);
          }
          yield* complete;
        }).pipe(
          Effect.ensuring(
            Effect.uninterruptible(
              session.kill.pipe(
                Effect.ignore,
                Effect.andThen(session.exit.pipe(Effect.orElseSucceed(() => null))),
                Effect.tap((code) => Deferred.succeed(termination, code)),
                Effect.andThen(Deferred.succeed(disposition, "aborted")),
                Effect.andThen(complete),
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
      const ingest = Effect.fnUntraced(function* (event: AgentFrame | AgentEventPayload) {
        const committed = isAgentEventPayload(event) ? yield* agentLog.append(event) : event;
        if (isSessionStateTopic(committed) && committed.payload !== lastSessionState) {
          lastSessionState = committed.payload;
          yield* stateObserver.onState(spec.id, committed.payload);
        }
        if (phase === "active") yield* hub.publish(committed);
        else yield* Queue.offer(pendingEvents, committed);
      });

      // Process reports take the same generic topic door as component events,
      // so replay and live subscribers observe one ordered fact stream.
      yield* Ref.update(reporters, (current) =>
        new Map(current).set(spec.id, (topic: string, payload: JsonValue) =>
          ingest({
            _tag: "topic",
            session: spec.id,
            topic,
            payload,
          }),
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
          // The replay must show the pre-activation burst, so it waits for the
          // pump's first delivery — bounded, because an idle session never
          // delivers one. The bound is generous: it only has to outlast the
          // pump's scheduling latency under load, and the idle path bears it
          // whole, so accuracy wins over the few milliseconds saved.
          yield* Deferred.await(firstOutput).pipe(
            Effect.timeout(INITIAL_OUTPUT_GRACE_MS),
            Effect.orElseSucceed(() => undefined),
          );
          const replay = yield* Effect.sync(() => formatScreen(screen.handle));
          if (replay.length > 0) {
            yield* hub.publish({
              _tag: "output",
              session: spec.id,
              data: replay,
            } satisfies AttachFrame);
          }
          // Offers can arrive while hub publication yields, so drain again.
          while ((yield* Queue.size(pending)) > 0) {
            for (const data of yield* Queue.takeAll(pending)) {
              yield* hub.publish({
                _tag: "output",
                session: spec.id,
                data,
              } satisfies AttachFrame);
            }
          }
          while ((yield* Queue.size(pendingEvents)) > 0) {
            for (const event of yield* Queue.takeAll(pendingEvents)) yield* hub.publish(event);
          }
          phase = "active";
          yield* FiberMap.run(pumps, `foreground:${spec.id}`, foreground);
          yield* Deferred.succeed(disposition, "active");
        });
      });
      const abort = Effect.suspend(() => {
        if (phase === "prepared") phase = "aborted";
        return Deferred.succeed(disposition, "aborted").pipe(
          Effect.andThen(session.kill.pipe(Effect.ignore)),
          Effect.andThen(Deferred.await(termination)),
          Effect.andThen(Deferred.await(completion)),
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
       * A process's report about itself, from the process-state socket.
       *
       * The topic and payload are opaque here: this door is generic process
       * self-reporting, not agent-specific, so validating a topic's payload
       * against whatever vocabulary its subscriber expects is that
       * subscriber's job, not the supervisor's — `process.state` is nothing
       * but this same door called with `SESSION_STATE_TOPIC` already
       * substituted. Unknown sessions are ignored rather than failed: the
       * reporter is a hook inside somebody else's agent, and a pane that
       * closed while its hook was mid-write is ordinary, not an error anyone
       * can act on.
       */
      report: (id: string, topic: string, payload: JsonValue) =>
        Ref.get(reporters).pipe(
          Effect.flatMap((current) => current.get(id)?.(topic, payload) ?? Effect.void),
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
          Match.tag("session.message", (command) =>
            Effect.gen(function* () {
              const session = (yield* Ref.get(sessions)).get(command.session);
              if (!session) return;
              yield* session.message(command.message);
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
        // Restored component sessions are pending until the client resolves
        // their provider and respawns the worker. Their durable transcript
        // must still be available while the pane is waiting for that step.
        const history = yield* agentLog.read(id, after);
        for (const event of history) yield* hub.publishTo(client, connection, event);
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
            argv: foregroundArgv(fg),
          } satisfies AttachFrame);
        }
        if (session?.kind === "component") return;
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

      // Session id = the leader's pid (SessionForeground.sid). Read straight
      // off each backend's cached tty state, so this costs no syscall beyond
      // what the foreground poller already pays.
      pids: Ref.get(sessions).pipe(
        Effect.map((current) => {
          const entries: [string, number][] = [];
          for (const [id, session] of current) {
            const sid = session.foreground().sid;
            if (sid > 0) entries.push([id, sid]);
          }
          return new Map(entries);
        }),
      ),

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
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(SessionRegistry.layer));
}

const isSessionStateTopic = (frame: AgentFrame): frame is Topic & { readonly payload: string } =>
  frame._tag === "topic" && frame.topic === SESSION_STATE_TOPIC && S.is(S.String)(frame.payload);
