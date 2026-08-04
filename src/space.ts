import { BoxRenderable, type RenderContext } from "@opentui/core";
import { Context, Effect, Exit, Scope } from "effect";
import { Window } from "./window.ts";
import type { Agent, AgentState } from "./agent.ts";
import type { TerminalPane } from "./pane.ts";
import { RenderCtx, type WorkspaceEnv } from "./env.ts";
import {
  activateSpaceState,
  claimWindowNumber,
  closeWindowState,
  removeSpaceState,
  selectWindowState,
  spaceSetState,
  spaceState,
  type SpaceSetState,
  type SpaceState,
} from "./space-model.ts";
import type { WorkspaceSnapshot, WorkspaceSpace, WorkspaceWindow } from "./workspace.ts";
import type { SpawnBackend } from "./backend.ts";

let nextSpaceId = 0;

/** Keep the generator ahead of every id restore brought back, so a space
 *  created after a restore cannot collide with one that came out of the file. */
function reserveSpaceId(id: string) {
  const n = /^space-(\d+)$/.exec(id);
  if (n) nextSpaceId = Math.max(nextSpaceId, Number(n[1]) + 1);
}

/**
 * A named working context with a directory attached.
 *
 * The top of the tmux hierarchy: a space holds windows, a window holds panes.
 * Its state names windows by number and does not depend on the render tree.
 * SpaceSet projects the active window into its host; every other window keeps
 * its layout and running agents while contributing nothing to yoga or hit tests.
 */
export class Space {
  readonly id: string;
  name: string;
  dir: string;

  /** Git branch of `dir`, refreshed by the app. "" when not a checkout. */
  branch = "";
  /** Commits ahead/behind the upstream, for the sidebar's second row. */
  ahead = 0;
  behind = 0;

  /** Passed down to every window this space opens, unread here beyond the
   *  renderer — a space is a container, not a thing that starts processes. */
  #env: Context.Context<WorkspaceEnv>;
  #windows: Window[] = [];
  /** One scope per window, for the same reason Window keeps one per agent:
   *  closeWindow must end exactly one window, and a window will eventually be
   *  movable between spaces (ts-e10c3a), which a forked child scope forbids. */
  #scopes = new Map<Window, Scope.CloseableScope>();
  #state: SpaceState = spaceState();

  onChange?: () => void;
  onAgentExit?: (agent: Agent, window: Window, space: Space) => void;
  onCopy?: (text: string) => boolean | void;
  onCopyError?: (error: Error) => void;

  constructor(
    env: Context.Context<WorkspaceEnv>,
    opts: { name: string; dir: string; id?: string },
  ) {
    this.#env = env;
    this.id = opts.id ?? `space-${nextSpaceId++}`;
    if (opts.id) reserveSpaceId(opts.id);
    this.name = opts.name;
    this.dir = opts.dir;
  }

  get windows(): readonly Window[] {
    return this.#windows;
  }

  get active(): Window | null {
    return this.#windows.find((window) => window.number === this.#state.activeWindow) ?? null;
  }

  /** Stable model identity used by persistence and, eventually, the daemon. */
  get activeWindowNumber(): number | null {
    return this.#state.activeWindow;
  }

  /** Reconcile selection counters after windows have been projected. */
  projectState(state: SpaceState): void {
    this.#state = structuredClone(state);
    this.onChange?.();
  }

  /** Every agent across every window in this space. */
  get agents(): Agent[] {
    return this.#windows.flatMap((w) => [...w.agents]);
  }

  /**
   * The space's state icon is the most urgent state among its agents: an agent
   * waiting on you matters more than one that is merely busy, which matters
   * more than an idle prompt. A detached agent is surfaced above idle because
   * the UI cannot know whether it is waiting or still working without an
   * attachment. "done" is last, so a space with one live idle agent and one
   * finished agent reads as idle, not finished.
   */
  get state(): AgentState {
    return rollUp(this.agents);
  }

  /**
   * Create a window and switch to it.
   *
   * `number` is only passed by restore, which must bring a window back under
   * the number the user knows it by — `^a 3` has to keep meaning the same
   * window across a restart. The counter is pushed past any number claimed that
   * way, so a window created afterwards still gets a free one.
   */
  newWindow(name?: string, number?: number): Effect.Effect<Window> {
    return Effect.gen(this, function* () {
      let claimed: number;
      [this.#state, claimed] = claimWindowNumber(this.#state, number);
      const scope = yield* Scope.make();
      const window = yield* Window.make(this.#env, this.dir, claimed).pipe(Scope.extend(scope));
      this.#scopes.set(window, scope);
      if (name) window.customName = name;
      window.onChange = () => this.onChange?.();
      window.onAgentExit = (agent) => this.onAgentExit?.(agent, window, this);
      window.onCopy = this.onCopy;
      window.onCopyError = this.onCopyError;
      this.#windows.push(window);
      this.selectWindow(window);
      return window;
    });
  }

  selectWindow(window: Window) {
    const next = selectWindowState(
      this.#state,
      this.#windows.map((candidate) => candidate.number),
      window.number,
    );
    if (next === this.#state) return;
    this.#state = next;
    const pane = window.focused ?? window.panes[0];
    if (pane) window.focus(pane);
    this.onChange?.();
  }

  /**
   * Select the previously active window — tmux's last-window.
   *
   * Repeated presses toggle between the two most recent windows, the way
   * last-pane toggles between panes. A window closed since it was last is
   * skipped rather than selected: closeWindow() clears it, and this check
   * keeps the promise even if something else left a stale reference behind.
   */
  selectLastWindow() {
    const last = this.#windows.find((window) => window.number === this.#state.lastWindow);
    if (!last) return;
    this.selectWindow(last);
  }

  /** Select by 1-based number, the way `^a 1..9` does. */
  selectNumber(number: number): boolean {
    const window = this.#windows.find((w) => w.number === number);
    if (!window) return false;
    this.selectWindow(window);
    return true;
  }

  cycleWindow(step = 1) {
    if (this.#windows.length < 2) return;
    const active = this.active;
    const i = active ? this.#windows.indexOf(active) : -1;
    this.selectWindow(this.#windows[(i + step + this.#windows.length) % this.#windows.length]!);
  }

  /**
   * Break a pane out of its window into a new one — tmux's break-pane.
   *
   * The pane and its agent are MOVED, not restarted: the process keeps its
   * PTY, its terminal, its scrollback and its title. Only ownership changes,
   * which is why the agent's lifecycle hooks are re-pointed at the destination
   * window — an exit must close the pane in the window it now lives in and
   * fire that window's onAgentExit, or the app-level cascade would act on
   * stale ownership.
   *
   * The source window collapses to its remaining panes (the same tree surgery
   * close() does, minus the destruction). A window left with no panes is
   * closed, the way tmux closes a window it just emptied — unless it still
   * holds running agents, which are never discarded silently (the rule
   * afterAgentExit uses).
   *
   * The destination window takes the next number and becomes active, which is
   * tmux's session_select after a break. Returns the new window, or null when
   * the pane is not in this space.
   */
  breakPane(pane: TerminalPane): Effect.Effect<Window | null> {
    return Effect.gen(this, function* () {
      const source = this.#windows.find((w) => w.panes.includes(pane));
      if (!source) return null;
      const agent = pane.agent;
      // Ownership is checked BEFORE anything is mutated. The agent's scope has
      // to travel with it — the source window may be closed below, and closing
      // it must not end a process that now lives elsewhere — so a break that
      // could not hand the scope over has to be refused while it is still a
      // no-op, rather than half-done with a detached pane nothing will release.
      if (!source.agents.includes(agent)) return null;
      if (!source.detachPane(pane)) return null;
      const scope = source.relinquishAgent(agent)!;

      const window = yield* this.newWindow();
      window.adopt(agent, pane, scope);

      if (source.panes.length === 0 && !source.agents.some((a) => a.state !== "done")) {
        yield* this.closeWindow(source);
      }
      return window;
    });
  }

  /** Redraw every window's borders after `frame.externalLeft` changed. */
  refreshChrome() {
    for (const w of this.#windows) w.refreshChrome();
  }

  /** Close a window and everything running in it. */
  closeWindow(window: Window): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const i = this.#windows.indexOf(window);
      if (i === -1) return;
      this.#windows.splice(i, 1);
      this.#state = closeWindowState(
        this.#state,
        this.#windows.map((candidate) => candidate.number),
        window.number,
        i,
      );
      // SpaceSet observes this synchronously and unmounts the old root before
      // the window scope frees terminals that root could still render.
      const active = this.active;
      const pane = active?.focused ?? active?.panes[0];
      if (active && pane) active.focus(pane);
      else this.onChange?.();
      yield* this.#releaseWindow(window);
    });
  }

  #releaseWindow(window: Window): Effect.Effect<void> {
    const scope = this.#scopes.get(window);
    this.#scopes.delete(window);
    return scope ? Scope.close(scope, Exit.void) : window.release;
  }

  /**
   * A space whose windows are released when the surrounding scope closes.
   */
  static make(
    env: Context.Context<WorkspaceEnv>,
    opts: { name: string; dir: string; id?: string },
  ): Effect.Effect<Space, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new Space(env, opts)),
      (space) => space.release,
    );
  }

  get release(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      for (const w of [...this.#windows]) yield* this.#releaseWindow(w);
      this.#windows.length = 0;
      this.#state = spaceState();
    });
  }
}

/** Ranked by how much it wants your attention. Shared by spaces and windows. */
export function rollUp(agents: readonly Agent[]): AgentState {
  const RANK: Record<AgentState, number> = {
    blocked: 4,
    working: 3,
    detached: 2,
    idle: 1,
    done: 0,
  };
  let best: AgentState = "done";
  for (const a of agents) {
    const s = a.state;
    if (s === "blocked") return "blocked";
    if (RANK[s] > RANK[best]) best = s;
  }
  return best;
}

/**
 * The next blocked agent after `from` in a stable order, or the first one when
 * nothing is focused — scanning forward and wrapping around.
 *
 * Starting *after* `from` is what makes repeated presses walk the set: the
 * agent you are looking at is already on screen, so it is not the one the next
 * press is looking for. The full wrap keeps a lone blocked agent reachable,
 * where landing on it again is a no-op rather than a jump.
 *
 * Returns null when no agent is blocked.
 */
export function nextBlockedAfter(order: readonly Agent[], from: Agent | null): Agent | null {
  const n = order.length;
  if (!n) return null;
  const start = from ? order.indexOf(from) + 1 : 0;
  for (let step = 0; step < n; step++) {
    const agent = order[(start + step) % n]!;
    if (agent.state === "blocked") return agent;
  }
  return null;
}

/**
 * The set of spaces and which one is on screen.
 *
 * Only the active space's container is mounted, so an inactive space keeps its
 * windows, their layouts and their agents entirely off the layout tree.
 */
export class SpaceSet {
  #env: Context.Context<WorkspaceEnv>;
  #ctx: RenderContext;
  #host: BoxRenderable;
  #spaces: Space[] = [];
  #scopes = new Map<Space, Scope.CloseableScope>();
  #state: SpaceSetState = spaceSetState();
  #mounted: Window | null = null;
  onChange?: () => void;
  onAgentExit?: (agent: Agent, window: Window, space: Space) => void;
  onCopy?: (text: string) => boolean | void;
  onCopyError?: (error: Error) => void;

  constructor(env: Context.Context<WorkspaceEnv>, host: BoxRenderable) {
    this.#env = env;
    this.#ctx = Context.get(env, RenderCtx);
    this.#host = host;
  }

  get spaces(): readonly Space[] {
    return this.#spaces;
  }

  get active(): Space | null {
    return this.#spaces.find((space) => space.id === this.#state.activeSpace) ?? null;
  }

  /** Stable model identity used by persistence and, eventually, the daemon. */
  get activeSpaceId(): string | null {
    return this.#state.activeSpace;
  }

  /** Reconcile active identity after spaces and windows have been projected. */
  projectState(state: SpaceSetState): void {
    this.#state = structuredClone(state);
    this.#project();
    this.onChange?.();
    this.#ctx.requestRender();
  }

  /** The window keystrokes currently land in. */
  get activeWindow(): Window | null {
    return this.active?.active ?? null;
  }

  /** Every agent across every space — what a global "N agents" count means. */
  get allAgents(): Agent[] {
    return this.#spaces.flatMap((s) => s.agents);
  }

  create(name: string, dir = process.cwd(), id?: string): Effect.Effect<Space> {
    return Effect.gen(this, function* () {
      const scope = yield* Scope.make();
      const space = yield* Space.make(this.#env, { name, dir, id }).pipe(Scope.extend(scope));
      this.#scopes.set(space, scope);
      space.onChange = () => {
        if (space === this.active) this.#project();
        this.onChange?.();
      };
      space.onAgentExit = (agent, window) => this.onAgentExit?.(agent, window, space);
      space.onCopy = this.onCopy;
      space.onCopyError = this.onCopyError;
      this.#spaces.push(space);
      if (!this.active) this.activate(space);
      else this.onChange?.();
      return space;
    });
  }

  activate(space: Space) {
    const next = activateSpaceState(
      this.#state,
      this.#spaces.map((candidate) => candidate.id),
      space.id,
    );
    if (next === this.#state) return;
    this.#state = next;
    this.#project();
    // Re-focus so keystrokes land in this space's pane, not the old one's.
    const window = space.active;
    const pane = window?.focused ?? window?.panes[0];
    if (window && pane) window.focus(pane);
    this.onChange?.();
    this.#ctx.requestRender();
  }

  /** Redraw every pane frame everywhere — an inactive space's windows too, so
   *  switching back to one does not reveal a stale border. */
  refreshChrome() {
    for (const s of this.#spaces) s.refreshChrome();
  }

  cycle(step = 1) {
    if (this.#spaces.length < 2) return;
    const active = this.active;
    const i = active ? this.#spaces.indexOf(active) : -1;
    this.activate(this.#spaces[(i + step + this.#spaces.length) % this.#spaces.length]!);
  }

  find(agent: Agent): Space | null {
    return this.#spaces.find((s) => s.agents.includes(agent)) ?? null;
  }

  /**
   * Jump to the next blocked agent and bring it on screen — the herding loop.
   *
   * The agent worth your attention is the one waiting on a human, so a single
   * press walks the blocked set across every space instead of tabbing through
   * panes. Order is stable: spaces in creation order, then windows, then spawn
   * order within a window, so repeated presses advance rather than bouncing
   * between two. Navigation is the same as clicking the sidebar row — the
   * agent's space is activated, its window selected, and it is revealed (or
   * focused) even when no pane shows it. Returns the agent, or null when
   * nothing is blocked.
   */
  nextBlocked(from: Agent | null = this.activeWindow?.focused?.agent ?? null): Agent | null {
    const target = nextBlockedAfter(this.allAgents, from);
    if (!target) return null;
    const space = this.find(target);
    const window = space?.windows.find((w) => w.agents.includes(target));
    if (!space || !window) return null;
    this.activate(space);
    space.selectWindow(window);
    window.reveal(target);
    return target;
  }

  remove(space: Space): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const i = this.#spaces.indexOf(space);
      if (i === -1) return;
      this.#spaces.splice(i, 1);
      this.#state = removeSpaceState(
        this.#state,
        this.#spaces.map((candidate) => candidate.id),
        space.id,
        i,
      );
      this.#project();
      yield* this.#releaseSpace(space);
      this.onChange?.();
      this.#ctx.requestRender();
    });
  }

  #releaseSpace(space: Space): Effect.Effect<void> {
    const scope = this.#scopes.get(space);
    this.#scopes.delete(space);
    return scope ? Scope.close(scope, Exit.void) : space.release;
  }

  /** Reconcile the one renderable admitted by the workspace model. */
  #project() {
    const next = this.activeWindow;
    if (next === this.#mounted) return;
    if (this.#mounted) this.#host.remove(this.#mounted.root);
    this.#mounted = next;
    if (next) this.#host.add(next.root);
  }

  /**
   * A workspace whose spaces — and so every window, agent and PTY under them —
   * are released when the surrounding scope closes.
   *
   * This is the root of the lifetime chain. One scope releases every local
   * projection in the right order; each backend decides whether release ends
   * its owned PTY or detaches from a daemon-owned one.
   */
  static make(
    env: Context.Context<WorkspaceEnv>,
    host: BoxRenderable,
  ): Effect.Effect<SpaceSet, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new SpaceSet(env, host)),
      (spaces) => spaces.release,
    );
  }

  get release(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      // Unmount before disposing: mounted panes draw from terminals whose
      // scopes are about to close.
      this.#state = spaceSetState();
      this.#project();
      for (const s of [...this.#spaces]) yield* this.#releaseSpace(s);
      this.#spaces.length = 0;
    });
  }
}

/**
 * Reconcile one authoritative daemon generation into renderer-owned objects.
 * Existing Agent terminals and panes are reused; only model identities that
 * appeared or disappeared are acquired or released.
 */
export function projectWorkspace(
  target: SpaceSet,
  source: WorkspaceSnapshot,
  backend: SpawnBackend,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const space of [...target.spaces]) {
      if (!source.spaces.some((candidate) => candidate.id === space.id))
        yield* target.remove(space);
    }
    for (const savedSpace of source.spaces) {
      let space = target.spaces.find((candidate) => candidate.id === savedSpace.id);
      if (!space) space = yield* target.create(savedSpace.name, savedSpace.dir, savedSpace.id);
      space.name = savedSpace.name;
      space.dir = savedSpace.dir;
      yield* projectSpace(space, savedSpace, backend);
    }
    target.projectState(source.state);
  });
}

function projectSpace(
  space: Space,
  source: WorkspaceSpace,
  backend: SpawnBackend,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const window of [...space.windows]) {
      if (!source.windows.some((candidate) => candidate.number === window.number))
        yield* space.closeWindow(window);
    }
    for (const savedWindow of source.windows) {
      let window = space.windows.find((candidate) => candidate.number === savedWindow.number);
      if (!window)
        window = yield* space.newWindow(savedWindow.name ?? undefined, savedWindow.number);
      window.customName = savedWindow.name;
      yield* projectWindow(window, savedWindow, backend);
    }
    space.projectState(source.state);
  });
}

function projectWindow(
  window: Window,
  source: WorkspaceWindow,
  backend: SpawnBackend,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const agent of [...window.agents]) {
      if (!source.agents.some((candidate) => candidate.id === agent.id))
        yield* window.removeProjectedAgent(agent);
    }
    for (const saved of source.agents) {
      if (window.agents.some((candidate) => candidate.id === saved.id)) continue;
      yield* window.startAgent({
        id: saved.id,
        name: saved.name,
        cmd: saved.cmd,
        cwd: saved.cwd,
        cols: saved.cols,
        rows: saved.rows,
        ...(saved.exited ? { exited: { code: saved.exitCode } } : { backend }),
      });
    }
    window.project(source.layout, source.state);
  });
}
