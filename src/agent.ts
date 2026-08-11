import { Clock, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Terminal, RenderState } from "./ghostty.ts";
import { localPty, exitedBackend, type SessionBackend, type SessionBackendFactory } from "./backend.ts";
import { scrollViewport, ScrollTo } from "./shim.ts";
import { splitActivity, looksBlocked, identifyAgent, commandName } from "./detect.ts";
import { AgentState } from "./agent-state.ts";

/** How often the screen is re-scanned for a "waiting on you" prompt. Blocked
 *  state changes are human-paced, so a few times a second is ample and keeps
 *  the scan off the render path for busy agents. */
const BLOCKED_POLL_MS = 250;

/** How many of the last written rows are searched for a prompt. A confirmation
 *  UI is the most recent thing on screen by definition, so a short tail is
 *  enough and scanning the whole grid would cost several times more. */
const BLOCKED_SCAN_ROWS = 20;

/** How often the foreground process is re-checked for an agent CLI. Reading
 *  /proc on every sidebar row on every tick would be gratuitous, and starting an
 *  agent is a human-paced event. */
const AGENT_POLL_MS = 500;

export interface SessionOptions {
  /** What draws this session: a terminal grid, or a component fed by semantic
   *  worker frames. Omitted means a pty. */
  kind?: "pty" | "component";
  /** The agent this session was started as, when the mux started it as one.
   *  A shell pane the user later runs an agent in leaves this unset and is
   *  detected instead — see agentKind. */
  agent?: string;
  /** Display name before the child reports an OSC title. Defaults to the
   *  executable being run, which is nearly always the better answer. */
  name?: string;
  cmd: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  /**
   * Keep an identity that already exists, instead of minting a new one.
   *
   * Only restore passes this. A layout is stored as agent ids, so an agent that
   * comes back under a fresh id is an agent its own window's saved arrangement
   * no longer mentions.
   */
  id?: string;
  /** Where the process comes from. Defaults to a PTY in this process. */
  backend?: SessionBackendFactory;
  /**
   * Restore an agent whose process is already over.
   *
   * Nothing is started and no exit is announced — the exit happened in a
   * previous life, and firing onExit here would cascade "an agent just
   * finished" through an app that has been running for two seconds.
   */
  exited?: { code: number | null };
}

let nextAgentId = 0;

/** Keep the generator ahead of every id restore has brought back, so a fresh
 *  agent can never collide with a persisted one. */
function reserveAgentId(id: string) {
  const n = /^agent-(\d+)$/.exec(id);
  if (n) nextAgentId = Math.max(nextAgentId, Number(n[1]) + 1);
}

/**
 * A running process and its terminal state.
 *
 * Agents are the real entities: they own the emulator and the process behind
 * it, they keep running whether or not anything is displaying them, and they
 * outlive the panes that view them. A TerminalPane is only a viewport.
 *
 * "The process behind it" is an AgentBackend rather than a PTY directly — see
 * backend.ts. A local PTY is the default and the only one the UI creates today;
 * the seam is what lets a daemon-owned PTY and a restored tombstone be the same
 * kind of thing to everything above.
 */
export class Session {
  readonly id: string;
  readonly kind: "pty" | "component";
  readonly name: string;
  readonly cmd: string[];
  readonly cwd: string | undefined;
  readonly term: Terminal;
  readonly startedAt = Date.now();

  #backend: SessionBackend;
  #exited = false;
  #detached = false;
  #exitCode: number | null = null;
  #lastOutputAt = 0;
  #viewers = 0;
  #unseen = false;
  /** Lazily created: only agents actually asked for their state pay for it. */
  #detect: RenderState | null = null;
  #blockedCache = false;
  #blockedAt = 0;
  #blockedSeenOutput = -1;
  /** Declared by whoever started this session as an agent. Fixed for its life. */
  readonly #declaredAgent: string | null;
  /** Agent CLI this pane was launched as, if any. Fixed for the agent's life. */
  #spawnedAs: string | null;
  #runningAs: string | null = null;
  #runningAt = 0;
  #comm = "";
  #commAt = 0;
  /** The fiber drawing backend output into `term`. Null for a tombstone, which
   *  has nothing to draw. Interrupted before the terminal is freed. */
  #pumpFiber: Fiber.RuntimeFiber<void> | null = null;
  /**
   * Owns every FFI handle this agent allocates.
   *
   * The handles are C allocations that leak if nothing frees them and corrupt
   * the heap if something frees them twice, and they used to be freed by
   * dispose() remembering to name each one. Closing a scope cannot forget.
   */
  #scope = Effect.runSync(Scope.make());
  #disposed = false;

  /** Bumped whenever output arrives, so views can invalidate caches. */
  onOutput?: (agent: Session) => void;
  onExit?: (agent: Session) => void;
  /** Fired when scrolled state changes (scrollback entered or exited), so the
   *  sidebar's ▲ indicator stays accurate. */
  onScroll?: (agent: Session) => void;

  constructor(opts: SessionOptions) {
    this.id = opts.id ?? `agent-${nextAgentId++}`;
    this.kind = opts.kind ?? "pty";
    if (opts.id) reserveAgentId(opts.id);
    this.name = opts.name ?? commandName(opts.cmd);
    this.cmd = opts.cmd;
    this.cwd = opts.cwd;
    this.#declaredAgent = opts.agent ?? null;
    this.#spawnedAs = identifyAgent(opts.cmd.join(" "));
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    this.term = this.#own(
      () => new Terminal(cols, rows),
      (t) => t.free(),
    );
    if (opts.exited) {
      // A tombstone: everything it can still answer, nothing running behind it.
      this.#backend = exitedBackend(opts.exited.code);
      this.#exited = true;
      this.#exitCode = opts.exited.code;
      return;
    }
    this.#backend = (opts.backend ?? localPty)({
      id: this.id,
      cmd: opts.cmd,
      cwd: opts.cwd,
      cols,
      rows,
    });
    this.#pumpFiber = this.#pump();
  }

  /**
   * Allocate an FFI handle into this agent's scope.
   *
   * runSync is honest here rather than a shortcut: these constructors are
   * synchronous C calls, so there is nothing to await, and the alternative is
   * making every caller of `new Agent` an Effect before the rest of the app is
   * ready to be one. The scope is what matters; how it is entered is not.
   */
  #own<A>(acquire: () => A, free: (handle: A) => void): A {
    return Effect.runSync(
      Scope.extend(
        Effect.acquireRelease(Effect.sync(acquire), (handle) => Effect.sync(() => free(handle))),
        this.#scope,
      ),
    );
  }

  /**
   * An agent whose handles are released when the surrounding scope closes.
   *
   * The lifetime-correct way to make one. `new Agent` still works and still
   * needs dispose(); this is what the call sites become as they convert.
   */
  static make(opts: SessionOptions): Effect.Effect<Session, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new Session(opts)),
      (agent) => agent.release(),
    );
  }

  /**
   * Stop this agent and free what it holds, in that order.
   *
   * The order is the point. Interrupting the pump first means no fiber is
   * holding a chunk it is about to write into a terminal that is being freed
   * underneath it — a race the handles' own freed-guards currently absorb, but
   * absorbing a race is not the same as not having one.
   */
  release(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#disposed) return Effect.void;
      this.#disposed = true;
      this.#backend.close();
      return (this.#pumpFiber ? Fiber.interrupt(this.#pumpFiber) : Effect.void).pipe(
        Effect.andThen(Scope.close(this.#scope, Exit.void)),
      );
    });
  }

  /**
   * Draw the backend's output into the terminal until it ends.
   *
   * Forked rather than called: an `async` method nobody holds a handle to
   * cannot be stopped, and this one writes into an FFI handle that disposal
   * frees. Holding the fiber means teardown can interrupt the writer first and
   * free second, instead of racing it.
   */
  #pump(): Fiber.RuntimeFiber<void> {
    const self = this;
    return Effect.runFork(
      Stream.runForEach(self.#backend.stream, (chunk) =>
        Effect.gen(function* () {
          self.term.write(chunk);
          self.#lastOutputAt = yield* Clock.currentTimeMillis;
          if (self.#viewers === 0) self.#unseen = true;
          self.onOutput?.(self);
        }),
      ).pipe(
        // onExit belongs to the stream ending, not to the fiber ending: an
        // interrupted pump is a pane being torn down, and announcing an exit
        // there would tombstone an agent that is still running.
        Effect.andThen(
          Effect.sync(() => {
            this.#detached = this.#backend.detached;
            if (this.#detached) return;
            this.#exited = true;
            // Not `?? 0`: a backend that reports no exit code does not mean the
            // process succeeded. A daemon-owned agent whose attachment was lost
            // is still running somewhere, and calling that a clean exit would
            // persist a tombstone for something that never died. See backend.ts.
            this.#exitCode = this.#backend.exitCode;
            this.onExit?.(this);
          }),
        ),
      ),
    );
  }

  /** Title reported by the child via OSC 0/2, falling back to the given name.
   *  The leading activity glyph is stripped: it is state, not a name, and we
   *  render it ourselves as an animated state icon. */
  get title(): string {
    const raw = this.term.title;
    if (!raw) return this.name;
    return splitActivity(raw).text || this.name;
  }

  get pwd(): string {
    return this.term.pwd;
  }

  get exited() {
    return this.#exited;
  }

  /** True when the daemon attachment ended without the process exiting. */
  get detached() {
    return this.#detached;
  }

  get exitCode() {
    return this.#exitCode;
  }

  /** True when output has arrived that no pane was displaying. */
  get unseen() {
    return this.#unseen;
  }

  /** True when the viewport is parked in history rather than following output.
   *  Asked of ghostty rather than tracked locally: it clamps scrolls at both
   *  edges, so a counter of our own drifts out of sync the first time the user
   *  scrolls past the top or the bottom. */
  get scrolled(): boolean {
    return !this.#exited && !this.term.atBottom;
  }

  /**
   * Which agent this pane is, if any — "claude", "codex", "native", or null.
   *
   * Three ways to know, in order of authority: the mux started it as an agent
   * and said so; the command it was launched with is a known agent CLI; or a
   * shell in it is running one right now. The last is the common case — you
   * open a shell, cd somewhere, and type `claude` — and is polled, because a
   * process starting is not something the pty tells us about.
   *
   * Independent of `kind`: a grid can hold an agent and a component need not.
   */
  /** What this session was declared as, for persistence. `agentKind` is the
   *  question worth asking everywhere else, because it also answers for the
   *  panes nobody declared. */
  get declaredAgent(): string | null {
    return this.#declaredAgent;
  }

  get agentKind(): string | null {
    if (this.#declaredAgent) return this.#declaredAgent;
    if (this.#spawnedAs) return this.#spawnedAs;
    if (this.#exited) return null;
    const now = Date.now();
    if (now - this.#runningAt >= AGENT_POLL_MS) {
      this.#runningAt = now;
      this.#runningAs = identifyAgent(this.#foregroundCmdline());
    }
    return this.#runningAs;
  }

  /** Full argv of the foreground process, space-joined. `comm` is truncated at
   *  15 bytes and hides the script behind a `node`/`bun` wrapper, so identifying
   *  an agent has to read the command line. */
  #foregroundCmdline(): string {
    const fg = this.#backend.foregroundPgid();
    if (fg <= 0 || fg === this.#backend.sessionId()) return "";
    try {
      const raw = require("node:fs").readFileSync(`/proc/${fg}/cmdline`, "utf8") as string;
      return raw.split("\0").filter(Boolean).join(" ");
    } catch {
      return "";
    }
  }

  /**
   * What the agent is doing right now.
   *
   * Only asked of things that are actually agents. A pane running `nvim` or a
   * three-minute build is not idle-or-working-or-blocked in any sense worth
   * showing: those states describe an agent's relationship to *you*, and a text
   * editor has none. A shell is therefore always "idle" until it exits — the
   * spinner in the sidebar means "a model is thinking", not "a process exists".
   *
   * For a real agent there are two signals, most specific first:
   *
   * 1. An activity spinner in the OSC title — the agent CLI telling us outright
   *    that it is thinking. This is the only signal that works for `claude` or
   *    `codex`, which never leave the foreground and so look permanently busy
   *    to any process-based check.
   * 2. A recognised confirmation prompt on screen, meaning it has stopped and
   *    is waiting on a human. Polled, not computed per read: see the note on
   *    BLOCKED_POLL_MS.
   */
  get state(): AgentState {
    if (this.#exited) return AgentState.Done;
    if (this.#detached) return AgentState.Detached;
    const authoritative = this.#backend.agentState?.();
    if (authoritative) return authoritative;
    if (!this.agentKind) return AgentState.Idle;
    if (splitActivity(this.term.title).spinning) return AgentState.Working;
    if (this.#blocked()) return AgentState.Blocked;
    return AgentState.Idle;
  }

  /** @deprecated use `state`. */
  get status(): AgentState {
    return this.state;
  }

  /** Cached screen scan. Recomputed at most every BLOCKED_POLL_MS, and only
   *  when output has actually arrived since the last scan. */
  #blocked(): boolean {
    const now = Date.now();
    if (now - this.#blockedAt < BLOCKED_POLL_MS) return this.#blockedCache;
    if (this.#blockedAt > 0 && this.#lastOutputAt <= this.#blockedSeenOutput) {
      this.#blockedAt = now;
      return this.#blockedCache;
    }
    this.#blockedAt = now;
    this.#blockedSeenOutput = this.#lastOutputAt;
    // A disposed agent's handles are freed; scanning one would read released
    // memory. The last answer it gave is still the true one — nothing has
    // arrived since to change it.
    if (this.#disposed) return this.#blockedCache;
    this.#detect ??= this.#own(
      () => new RenderState(),
      (state) => state.free(),
    );
    this.#detect.update(this.term);
    this.#blockedCache = looksBlocked(this.#detect.tailText(BLOCKED_SCAN_ROWS));
    return this.#blockedCache;
  }

  /** Command name of the foreground process, e.g. "vim" — "" when at a prompt.
   *  Cached: the sidebar reads this for every row on every tick, and a process
   *  starting is not a sub-second event. */
  get foregroundCommand(): string {
    if (this.#exited) return "";
    const now = Date.now();
    if (now - this.#commAt >= AGENT_POLL_MS) {
      this.#commAt = now;
      const fg = this.#backend.foregroundPgid();
      if (fg <= 0 || fg === this.#backend.sessionId()) {
        this.#comm = "";
      } else {
        try {
          this.#comm = (
            require("node:fs").readFileSync(`/proc/${fg}/comm`, "utf8") as string
          ).trim();
        } catch {
          this.#comm = "";
        }
      }
    }
    return this.#comm;
  }

  get msSinceOutput() {
    return this.#lastOutputAt === 0 ? Infinity : Date.now() - this.#lastOutputAt;
  }

  addViewer() {
    this.#viewers++;
    this.#unseen = false;
  }

  removeViewer() {
    this.#viewers = Math.max(0, this.#viewers - 1);
  }

  get viewers() {
    return this.#viewers;
  }

  write(data: string | Uint8Array) {
    this.scrollToBottom();
    this.#backend.write(data);
  }

  /** Views share one terminal, so resize is last-writer-wins. See notes in
   *  workspace: two panes on one agent at different sizes will fight. */
  resize(cols: number, rows: number) {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
    this.#backend.resize(cols, rows);
  }

  scrollBy(rows: number) {
    const before = this.scrolled;
    scrollViewport(this.term.handle, ScrollTo.delta, rows);
    if (this.scrolled !== before) this.onScroll?.(this);
  }

  scrollToBottom() {
    if (!this.scrolled) return;
    scrollViewport(this.term.handle, ScrollTo.bottom);
    this.onScroll?.(this);
  }

  kill() {
    this.#backend.kill();
  }

  /**
   * Synchronous teardown, for the call sites that are not Effects yet.
   *
   * Prefer `Agent.make`, which needs no teardown call at all. This stays until
   * the last of them converts; it runs the same finalizers, just without a
   * scope to hang them on.
   */
  dispose() {
    Effect.runFork(this.release());
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}
