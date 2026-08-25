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
import {
  decodeAttachFrames,
  isAgentEvent,
  type AgentEventPayload,
  AgentDelta,
  type AgentFrame,
  type AttachFrame,
  type PermissionAnswer,
} from "./AttachProtocol.ts";

export class PtyError extends S.TaggedError<PtyError>()("PtyError", {
  operation: S.String,
  message: S.String,
}) {}

/**
 * What a session's content *is*, which decides what can draw it.
 *
 * A pty produces bytes for a terminal grid. A component produces semantic
 * frames for a UI surface — a transcript, a form, a picker — and has no screen
 * to replay, which is why `sync` answers one from the agent log instead.
 *
 * Not "is this an LLM agent": that is orthogonal and lives in `agent` below.
 * A pty session running opencode is an agent drawn on a grid, and a component
 * session need not be an agent at all.
 */
export type SessionKind = "pty" | "component";

export interface SessionSpec {
  /** Defaults to "pty": a session that does not say otherwise is a terminal. */
  readonly kind?: SessionKind;
  /**
   * The agent CLI or worker this session runs, if it runs one.
   *
   * Declared for sessions the mux starts as an agent; a foreign agent launched
   * inside a shell pane is detected rather than declared (see identifyAgent and
   * the process-state hook), so this being absent does not mean "not an agent".
   * What it does mean is that the session's *exit* is an agent's exit, and so
   * worth reporting as agent lifecycle.
   */
  readonly agent?: string;
  readonly id: string;
  readonly cmd: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Environment variable names a worker must not inherit. The spawn provider
   *  declares these (the harness knows which variables are credentials), so
   *  core never has to. */
  readonly stripEnv?: readonly string[];
  readonly cwd?: string;
  readonly rpcPath?: string;
  /** Where a hook inside a foreign process reports its state. */
  readonly processStatePath?: string;
  /** The pane that shows this session, so the child can be handed its own
   *  pane id (AMUX_PANE_ID). Resolved by the mutation that spawned it. */
  readonly paneId?: string;
  /** The pane's owning daemon session, distinct from the agent id. */
  readonly daemonSession?: string;
  readonly cols: number;
  readonly rows: number;
}

export interface ManagedSession {
  readonly id: string;
  readonly kind: SessionKind;
  readonly output: Stream.Stream<Uint8Array, PtyError>;
  readonly events?: Stream.Stream<AgentEventPayload | AgentDelta, PtyError>;
  readonly exit: Effect.Effect<number | null, PtyError>;
  readonly write: (data: string | Uint8Array) => Effect.Effect<void, PtyError>;
  readonly prompt: (text: string, options?: PromptOptions) => Effect.Effect<void, PtyError>;
  /** Answer a permission request this session is blocked on. */
  readonly decide: (answer: PermissionAnswer) => Effect.Effect<void, PtyError>;
  readonly interrupt: (reason?: string) => Effect.Effect<void, PtyError>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, PtyError>;
  readonly kill: Effect.Effect<void, PtyError>;
  /** What is in the foreground of this session's tty right now. Only the
   *  daemon can answer: the tty's foreground process group is read through
   *  the master, which lives here. See the `foreground` attach frame. */
  readonly foreground: () => SessionForeground;
}

export type PromptOptions = {
  readonly id?: string;
  readonly delivery?: "steer" | "queue";
  readonly resume?: boolean;
};

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
  readonly events?: AsyncIterable<AgentEventPayload | AgentDelta>;
  /** Resolves once the backend has fully terminated, with its exit code. */
  readonly wait: Promise<number | null>;
  write(data: string | Uint8Array, signal?: AbortSignal): Promise<void>;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  decide(answer: PermissionAnswer): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  resize(cols: number, rows: number): void;
  kill(): Promise<void>;
  close(): void;
  foreground(): SessionForeground;
}

function ptyBackend(spec: SessionSpec): Backend {
  const env = { ...spec.env, AMUX_AGENT_ID: spec.id } satisfies Record<string, string>;
  if (spec.paneId !== undefined) Object.assign(env, { AMUX_PANE_ID: spec.paneId });
  if (spec.rpcPath !== undefined) Object.assign(env, { AMUX_CONTROL_SOCKET: spec.rpcPath });
  if (spec.processStatePath !== undefined)
    Object.assign(env, { AMUX_PROCESS_STATE_SOCKET: spec.processStatePath });
  if (spec.daemonSession !== undefined)
    Object.assign(env, { AMUX_DAEMON_SESSION: spec.daemonSession });
  const pty = spawnPty([...spec.cmd], {
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    // What makes a pane addressable from the inside: an agent CLI running here
    // can learn which pane it occupies and where to reach the mux. Unlike the
    // native worker, provider keys are left in place — this is the user's own
    // shell, and a foreign agent authenticates with the user's own environment.
    env,
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
    prompt: async () => {
      throw new Error("pty sessions do not accept agent prompts");
    },
    decide: async () => {},
    interrupt: async () => {},
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    close: () => pty.close(),
    // The two questions only the tty owner can answer — read through the
    // master fd this process holds. sessionId() caches its value internally,
    // so repeated reads are one syscall each.
    foreground: () => ({ pgid: pty.foregroundPgid(), sid: pty.sessionId() }),
  };
}

class AsyncMailbox<A> implements AsyncIterable<A> {
  #values: A[] = [];
  #waiters: ((result: IteratorResult<A>) => void)[] = [];
  #ended = false;

  offer(value: A): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    while (this.#waiters.length) this.#waiters.shift()!({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<A> {
    while (this.#values.length || !this.#ended) {
      if (this.#values.length) yield this.#values.shift()!;
      else {
        const next = await new Promise<IteratorResult<A>>((resolve) => this.#waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }
}

const isAgentFrame = (frame: AttachFrame): frame is AgentFrame =>
  isAgentEvent(frame) || S.is(AgentDelta)(frame);

/** A component's content comes from a worker isolated from the daemon, speaking
 *  semantic frames on stdout instead of terminal bytes. */
function componentBackend(spec: SessionSpec): Backend {
  if (!spec.cmd.length) throw new Error("component session requires a worker command");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !(spec.stripEnv ?? []).includes(name)),
    ),
    AMUX_SESSION: spec.id,
    AMUX_AGENT_ID: spec.id,
    AMUX_AGENT_SIZE: JSON.stringify({ cols: spec.cols, rows: spec.rows }),
    ...spec.env,
  } satisfies Record<string, string>;
  if (spec.rpcPath !== undefined) Object.assign(env, { AMUX_CONTROL_SOCKET: spec.rpcPath });
  if (spec.daemonSession !== undefined)
    Object.assign(env, { AMUX_DAEMON_SESSION: spec.daemonSession });
  if (spec.paneId !== undefined) Object.assign(env, { AMUX_PANE_ID: spec.paneId });
  if (spec.cwd !== undefined) Object.assign(env, { AMUX_AGENT_CWD: spec.cwd });
  const child = Bun.spawn([...spec.cmd], {
    cwd: spec.cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new AsyncMailbox<Uint8Array>();
  const events = new AsyncMailbox<AgentEventPayload | AgentDelta>();
  let closed = false;
  let killed = false;

  void new Response(child.stderr).text();
  void (async () => {
    let pending = new Uint8Array();
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stdout) {
        const combined = new Uint8Array(pending.length + chunk.length);
        combined.set(pending);
        combined.set(chunk, pending.length);
        let start = 0;
        for (let index = 0; index < combined.length; index++) {
          if (combined[index] !== 10) continue;
          const line = decoder.decode(combined.subarray(start, index));
          start = index + 1;
          if (!line) continue;
          for (const frame of decodeAttachFrames(`${line}\n`).frames) {
            if (frame._tag === "output" && frame.session === spec.id)
              output.offer(new Uint8Array(frame.data));
            else if (frame._tag === "agent.event" && frame.event.session === spec.id)
              events.offer(frame.event);
            else if (isAgentFrame(frame) && frame.session === spec.id) events.offer(frame);
          }
        }
        pending = combined.slice(start);
      }
    } finally {
      output.end();
      events.end();
    }
  })();

  const send = async (frame: AttachFrame) => {
    if (!closed) await child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const wait = child.exited.then((code) => {
    closed = true;
    return killed ? null : code;
  });
  return {
    output,
    events,
    wait,
    write: (data) =>
      send({
        _tag: "input",
        session: spec.id,
        data: typeof data === "string" ? new TextEncoder().encode(data) : data,
      }),
    prompt: (text, options) => send({ _tag: "agent.prompt", session: spec.id, text, ...options }),
    decide: (answer) => send({ _tag: "agent.permission", session: spec.id, ...answer }),
    interrupt: (reason) =>
      reason === undefined
        ? send({ _tag: "agent.interrupt", session: spec.id })
        : send({ _tag: "agent.interrupt", session: spec.id, reason }),
    resize: (cols, rows) => void send({ _tag: "resize", session: spec.id, cols, rows }),
    kill: async () => {
      if (!closed) {
        killed = true;
        child.kill();
        await child.exited;
      }
    },
    close: () => {
      if (!closed) child.kill();
    },
    foreground: () => ({ pgid: -1, sid: -1 }),
  };
}

type Reservation = { readonly token: symbol; readonly backend?: Backend };

const asPtyError = (operation: string, error: string): PtyError =>
  new PtyError({
    operation,
    message: error,
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
          return yield* new PtyError({
            operation: "spawn",
            message: "invalid terminal size",
          });
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
            try: () => (kind === "component" ? componentBackend(spec) : ptyBackend(spec)),
            catch: (error) => asPtyError("spawn", String(error)),
          }).pipe(Effect.tapError(() => release)),
          (owned) =>
            Effect.uninterruptible(
              Effect.tryPromise(() => owned.kill()).pipe(
                Effect.catchAll(() => Effect.void),
                Effect.ensuring(Effect.sync(() => owned.close())),
                Effect.ensuring(release),
              ),
            ),
        );
        yield* Ref.update(sessions, (current) => {
          if (current.get(spec.id)?.token !== token) return current;
          const next = new Map(current);
          next.set(spec.id, { token, backend });
          return next;
        });
        const commands = yield* Mailbox.make<SessionCommand>({
          capacity: 256,
          strategy: "suspend",
        });
        const runCommand = (command: SessionCommand) => {
          const operation = Match.valueTags(command, {
            resize: (command) => Effect.sync(() => backend.resize(command.cols, command.rows)),
            kill: () => Effect.tryPromise(() => backend.kill()),
          });
          return operation.pipe(
            Effect.mapError((error) => asPtyError(command._tag, String(error))),
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
          output: Stream.fromAsyncIterable(backend.output, (error) =>
            asPtyError("read", String(error)),
          ),
          events: backend.events
            ? Stream.fromAsyncIterable(backend.events, (error) =>
                asPtyError("event", String(error)),
              )
            : undefined,
          exit: Effect.tryPromise({
            try: () => backend.wait,
            catch: (error) => asPtyError("exit", String(error)),
          }).pipe(Effect.ensuring(release)),
          write: (data) =>
            Effect.tryPromise({
              try: (signal) => backend.write(data, signal),
              catch: (error) =>
                S.is(PtyWriteInterrupted)(error) ? error : asPtyError("write", String(error)),
            }).pipe(
              Effect.catchAll((error) =>
                S.is(PtyWriteInterrupted)(error) && error.reason === "shutdown"
                  ? Effect.void
                  : Effect.fail(asPtyError("write", String(error))),
              ),
            ),
          prompt: (text, options) =>
            Effect.tryPromise({
              try: () => backend.prompt(text, options),
              catch: (error) => asPtyError("prompt", String(error)),
            }),
          decide: (answer) =>
            Effect.tryPromise({
              try: () => backend.decide(answer),
              catch: (error) => asPtyError("decide", String(error)),
            }),
          interrupt: (reason) =>
            Effect.tryPromise({
              try: () => backend.interrupt(reason),
              catch: (error) => asPtyError("interrupt", String(error)),
            }),
          resize: (cols, rows) =>
            isTerminalSize(cols, rows)
              ? commandResult((done) => ({
                  _tag: "resize",
                  cols,
                  rows,
                  done,
                }))
              : Effect.fail(
                  new PtyError({
                    operation: "resize",
                    message: "invalid terminal size",
                  }),
                ),
          // Kill must not wait behind a write whose child stopped reading.
          kill: Effect.tryPromise(() => backend.kill()).pipe(
            Effect.mapError((error) => asPtyError("kill", String(error))),
          ),
          foreground: () => backend.foreground(),
        } satisfies ManagedSession;
      });

    return {
      spawn,
      sessions: Ref.get(sessions).pipe(Effect.map((current) => new Set(current.keys()))),
    };
  }),
}) {}
