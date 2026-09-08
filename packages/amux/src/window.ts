import { BoxRenderable, type KeyEvent, type RenderContext, type Renderable } from "@opentui/core";
import { Pane, TerminalPane } from "./pane.ts";
import { ComponentPane, type PaneView } from "./component-pane.tsx";
import { SessionHandle, type SessionHandleOptions } from "./session-handle.ts";
import type { SessionBackendFactory } from "./backend.ts";
import { Context, Effect, Exit, Scope } from "effect";
import {
  RenderCtx,
  Backend as BackendContext,
  PaneViews,
  type WorkspaceEnv,
} from "./env.ts";
import { rollUp } from "./space.ts";
import { Divider, setWeight, setDirection, type JunctionFrame } from "./divider.ts";
import { layoutKindRenderer } from "./layout-kinds.ts";
import { runtime } from "./options.ts";

import {
  appendPane,
  closeLayout,
  componentViewType,
  layoutPanes,
  layoutRefs,
  makeLayout,
  newPaneId,
  placementOf,
  windowState,
  paneSession,
  withSession,
  emptyDockStrips,
  dockDefaultSize,
  DOCK_SIDES,
  type DockSide,
  type Layout,
  type LayoutFloat,
  type LayoutNode,
  type LayoutPreset,
  type PaneContent,
  type PaneRef,
  type WindowState,
} from "./layout.ts";
import {
  dividerHasNeighbour,
  dividerTouchesPane,
  paneHasNeighbour,
  type LayoutPath,
} from "./geometry.ts";

export type SplitDirection = "row" | "column";

/** Which way `focusDirection` looks. Screen directions, not tree axes. */
export type Direction = "left" | "right" | "up" | "down";

/** The content a live session's pane shows: a pty view, or the plugin view of
 *  a component session (the agent harness). Mirrors paneContentFor in
 *  workspace.ts for the client's own layouts — the resident model records
 *  content, so a round trip through applyLayout keeps it. */
function contentFor(session: SessionHandle): PaneContent {
  return session.kind === "component"
    ? {
        kind: "plugin",
        type: componentViewType(session),
        descriptor: {},
        session: session.id,
      }
    : { kind: "pty", session: session.id };
}

let nextId = 0;

/**
 * Put a pane back in the flex pass, sized by weight against its siblings.
 *
 * The undo of the absolute placement a float gets, and unconditional because
 * panes are reused across rebuilds: a pane that floated yesterday is still
 * carrying `position: absolute`, and a tiled pane that kept it would be lifted
 * out of the split it was just put into.
 */
function tile(pane: Pane, weight: number) {
  pane.position = "relative";
  // "auto", not undefined: undefined leaves the edge as yoga last had it, so a
  // pane that had been floating would keep offsetting itself inside its slot.
  pane.left = "auto";
  pane.top = "auto";
  pane.width = "auto";
  pane.height = "auto";
  setWeight(pane, weight);
}

/**
 * A window: one split tree of panes, and the sessions behind them.
 *
 * The middle level of the tmux hierarchy — a space holds windows, a window
 * holds panes. Agents belong to the window they were started in, so closing a
 * window is what ends its sessions rather than merely hiding them.
 *
 * Layout itself is delegated to opentui: every split is a flex Box, so yoga
 * computes the geometry and — because hit-testing is a byproduct of rendering —
 * clicking and hovering keep working through arbitrary nesting with no
 * coordinate math of our own.
 *
 * A window is a projection: the daemon owns the workspace model, and the
 * client re-renders whatever arrangement each model revision describes.
 * Nothing in this class authors model state — focus, resize and every other
 * mutation leave as commands (see `onModelFocus` / `onModelResizeDivider`),
 * and the arrangement is rebuilt from the revision the daemon sends back.
 */
export class Window {
  readonly root: BoxRenderable;
  /** Stable 1-based number for ^a 1..9, kept even as siblings come and go. */
  readonly number: number;
  /** Set by rename; otherwise the window shows what it is running. */
  customName: string | null = null;
  #ctx: RenderContext;
  #panes: Pane[] = [];
  #sessions: SessionHandle[] = [];
  /** The arrangement is authoritative here; renderables are only its projection. */
  #layout: Layout = makeLayout({ root: null });
  #dividerRefs = new WeakMap<Divider, { path: LayoutPath; index: number }>();
  /**
   * Everything about this window that is not its arrangement: focus,
   * last-pane, zoom, sync and preset, all as pane ids and flags.
   *
   * A plain record rather than five private fields, and ids rather than
   * renderable references, so that the state a headless window would hold is
   * separable from the tree that draws it. See WindowState in layout.ts.
   */
  #state: WindowState = windowState();
  onChange?: () => void;
  /** Fired after a session's process exits and its views have been closed. The
   *  app uses it to decide what to show next; it is deliberately not the same
   *  as "a pane closed", because closing a view by hand is a detach, not an end. */
  onSessionExit?: (session: SessionHandle) => void;
  onCopy?: (text: string) => boolean | void;
  onCopyError?: (error: Error) => void;
  onModelFocus?: (pane: string) => void;
  onModelResizeDivider?: (path: LayoutPath, index: number, delta: number) => void;

  /**
   * Where sessions started here get their processes.
   *
   * Read from context alongside #shell because it answers the same kind of
   * question — not "what does this window contain" but "what does starting
   * something in it mean" — and every path that creates a session goes through
   * here. It is always a real backend now: "run it locally" is the Backend
   * reference's default rather than the absence of an answer.
   */
  #backend: SessionBackendFactory;

  /** What a component session's pane mounts. Null in a workspace that
   *  registered none; see PaneViews in env.ts. */
  #paneContent: PaneView | null;

  /**
   * One scope per session, rather than one scope for the window.
   *
   * The obvious arrangement — fork every session's scope from the window's — is
   * wrong here, because a pane MOVES to another window and Effect scopes cannot
   * be re-parented. A session forked from its old window's scope would be killed
   * when that window closed, despite now living somewhere else. Independent
   * scopes held in a map make the transfer a map entry moving between two
   * windows (see adopt), and make releasing a session the closing of exactly
   * one of them.
   */
  #scopes = new Map<SessionHandle, Scope.Closeable>();

  constructor(env: Context.Context<WorkspaceEnv>, number: number) {
    this.#ctx = Context.get(env, RenderCtx);
    this.#backend = Context.get(env, BackendContext);
    this.#paneContent = Context.get(env, PaneViews);
    this.number = number;
    this.root = new BoxRenderable(this.#ctx, {
      id: `window-${number}-${nextId++}`,
      flexDirection: "row",
      flexGrow: 1,
    });
  }

  get panes(): readonly Pane[] {
    return this.#panes;
  }

  /** Tab label: the given name, else whatever the focused pane is showing —
   *  the same "what is this actually running" cue tmux gives a window. */
  get title(): string {
    if (this.customName) return this.customName;
    const session = this.focused?.session ?? this.#sessions[0];
    return session?.title ?? "window";
  }

  /** How the window reads in the tab bar and the sidebar. Both show the same
   *  string, including the zoom marker, so neither can drift from the other. */
  get label(): string {
    return `${this.number}:${this.title}${this.#state.zoom ? " Z" : ""}${this.#state.sync ? " Y" : ""}`;
  }

  /** True while one pane is filling the window on its own. */
  get zoomed(): boolean {
    return this.#state.zoom !== null;
  }

  /** True while ordinary child input is broadcast to every pane in the window. */
  get sync(): boolean {
    return this.#state.sync;
  }

  /** Every session, including ones no pane is currently showing. This is what
   *  the sidebar lists. */
  get sessions(): readonly SessionHandle[] {
    return this.#sessions;
  }

  /** Most urgent state among this window's sessions, for its sidebar row. */
  get state() {
    return rollUp(this.#sessions);
  }

  /** Agents with no viewport open — running, but off-screen. */
  get detached(): SessionHandle[] {
    return this.#sessions.filter((a) => a.viewers === 0);
  }

  /**
   * Wire a session's lifecycle callbacks to this window.
   *
   * A session's process exit is projected from the next model revision rather
   * than acted on here: the daemon closes the pane and fires the exit against
   * whatever window owns the session in the revision it sends. The callbacks
   * below only invalidate the local rendering so the projection stays live.
   */
  #bind(session: SessionHandle) {
    session.onOutput = () => {
      for (const p of this.#panes) if (p.session === session) p.invalidate();
      this.onChange?.();
      this.#ctx.requestRender();
    };
    session.onExit = () => {
      this.onChange?.();
      this.#ctx.requestRender();
    };
    session.onScroll = () => {
      // Scrollback state (scrollBy/scrollToBottom) is user-driven, so it has
      // no output to invalidate panes — but the sidebar's ▲ must repaint.
      this.onChange?.();
      this.#ctx.requestRender();
    };
  }

  /** Make this renderable window a projection of daemon state. */
  project(layout: Layout, state: WindowState): void {
    this.#state = structuredClone(state);
    for (const evicted of this.#mount(layout, state.preset)) evicted.destroyRecursively();
    this.#state = structuredClone(state);
    this.#layout = makeLayout({ ...layout, focus: state.focus ?? undefined });
    for (const pane of this.#panes) pane.active = pane.id === state.focus;
    this.#refreshChrome();
    this.#ctx.requestRender();
  }

  /** Drop a client projection after the daemon has removed its owner. */
  removeProjectedSession(session: SessionHandle): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const pane of this.#panes.slice()) if (pane.session === session) this.close(pane);
      const at = this.#sessions.indexOf(session);
      if (at !== -1) this.#sessions.splice(at, 1);
      yield* this.#releaseSession(session);
    });
  }

  /**
   * A window whose sessions are released when the surrounding scope closes.
   *
   * The lifetime-correct way to make one: nothing has to remember to call
   * disposeAll, because closing the scope that made the window is what ends the
   * processes in it.
   */
  static make(
    env: Context.Context<WorkspaceEnv>,
    number: number,
  ): Effect.Effect<Window, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new Window(env, number)),
      (window) => window.release,
    );
  }

  /**
   * Bring up a session from full options and take ownership of it.
   *
   * restore needs the options spawn's positional arguments cannot carry — a
   * persisted id, a size, and the fact that this one's process is already over
   * and must not be run again.
   */
  startSession(opts: SessionHandleOptions): Effect.Effect<SessionHandle> {
    return Effect.gen({ self: this }, function* () {
      const scope = yield* Scope.make();
      // The window's backend is a default, not an override: restore passes its
      // own per-session choice, and a tombstone must keep having no backend at all.
      // Spread order is what encodes that — opts wins where it says anything.
      const session = yield* SessionHandle.make({ backend: this.#backend, ...opts }).pipe(
        Scope.provide(scope),
      );
      this.#scopes.set(session, scope);
      this.#bind(session);
      this.#sessions.push(session);
      this.onChange?.();
      return session;
    });
  }

  /**
   * Detach a pane and transfer its live session ownership as one handoff.
   *
   * All preconditions are checked before the layout or ownership maps change,
   * so callers cannot leave a pane detached when its lifetime is unavailable.
   */
  releasePane(pane: Pane): { session: SessionHandle; scope: Scope.Closeable } | null {
    const session = pane.session;
    // A sessionless pane (client-rendered plugin) owns no session, so there is
    // nothing to hand over.
    if (!session) return null;
    if (!this.#panes.includes(pane) || !this.#sessions.includes(session)) return null;
    const scope = this.#scopes.get(session);
    if (!scope) return null;
    if (this.#slotOf(this.exportLayout(), pane) === -1) return null;
    if (!this.detachPane(pane)) return null;
    // Session ownership moves as one unit. Any other viewport onto this session
    // belongs to the source window only while the session does, so close it
    // before the callback and lifetime are handed to the destination. It runs
    // after the detach, not before: closing a sibling re-projects the layout,
    // and a detach that then failed would leave those views destroyed behind a
    // null return that tells the caller nothing happened.
    for (const sibling of this.#panes.slice()) {
      if (sibling !== pane && sibling.session === session) this.close(sibling);
    }
    this.#sessions.splice(this.#sessions.indexOf(session), 1);
    this.#scopes.delete(session);
    this.onChange?.();
    return { session, scope };
  }

  /**
   * Close a session's scope, which is what frees its PTY and terminal.
   *
   * Every session this window owns has one — `startSession` makes it and `adopt`
   * requires it — so a miss here means the session was never really ours. It is
   * released anyway rather than left running, but the two cases stay distinct:
   * a fallback that quietly does the same work would make a lost scope
   * invisible, and a leaked scope is exactly the bug worth seeing.
   */
  #releaseSession(session: SessionHandle): Effect.Effect<void> {
    const scope = this.#scopes.get(session);
    this.#scopes.delete(session);
    if (scope) return Scope.close(scope, Exit.void);
    return Effect.andThen(Effect.logWarning(`session ${session.id} released without a scope`), () =>
      session.release(),
    );
  }

  /**
   * The focused pane, resolved from the id the state holds.
   *
   * Derived rather than stored, which is what makes a dangling focus
   * impossible: a pane that has left the window answers to no id, so this
   * simply comes back null instead of handing out a destroyed renderable.
   * Pane ids are minted monotonically and never reused, so a stale id cannot
   * come back to life as some later pane either.
   */
  get focused(): Pane | null {
    return this.#pane(this.#state.focus);
  }

  #pane(id: string | null): Pane | null {
    return id === null ? null : (this.#panes.find((pane) => pane.id === id) ?? null);
  }

  /**
   * Where a pane sits in the tiled arrangement, and -1 for a float.
   *
   * Read out of the layout rather than by walking the tree, because under a
   * zoom the tree is down to one pane while the arrangement still has all of
   * them. The layout is the thing transforms index into anyway.
   */
  #slotOf(layout: Layout, pane: Pane): number {
    return layoutPanes(layout.root).findIndex((slot) => slot.id === pane.id);
  }

  /**
   * Send bytes to the focused pane — or to every pane when sync is on.
   *
   * The single child-input path. Everything the user aims at a child funnels
   * through here: unhandled keystrokes and the literal-prefix passthrough. amux
   * controls (the keymap's own bindings), overlays, prompts and pane-local mouse
   * events never reach it, so sync mode can only ever replicate input that was
   * meant for a child in the first place.
   *
   * The broadcast target is the window's panes — exactly the set on screen — so
   * it follows the layout without bookkeeping: a new split joins the fan-out, a
   * closed pane leaves it, and a parked pane stays in it while the window is
   * zoomed, because zoom hides panes rather than detaching them. A *detached*
   * session has no pane, so it receives nothing until a view is opened on it.
   *
   * Deduplicated by session: a pane is a viewport, and two panes viewing one session
   * are one process — writing twice would double the input into it. Different
   * sizes need no handling: every child owns a terminal of its own geometry, so
   * the same bytes are simply delivered to each.
   */
  write(bytes: string | Uint8Array) {
    if (this.#state.sync) {
      // Null keys (sessionless plugin panes) collapse into one bucket; their
      // write is a no-op, so the fan-out is just cheaply redundant for them.
      const seen = new Set<SessionHandle | null>();
      for (const pane of this.#panes) {
        if (seen.has(pane.session)) continue;
        seen.add(pane.session);
        pane.write(bytes);
      }
      return;
    }
    this.focused?.write(bytes);
  }

  /**
   * Hand an unbound keystroke to the pane it belongs to.
   *
   * Separate from `write` because a keystroke is not bytes until a leaf that
   * wants bytes says so: a terminal encodes it, a component leaves it for the
   * renderable holding focus inside its subtree. Follows sync mode for the same
   * reason `write` does — the user typing into one pane of a synchronized
   * window is typing into all of them.
   *
   * True when some pane took it; see the note on preventDefault in bindings.ts.
   */
  key(event: KeyEvent): boolean {
    if (!this.#state.sync) return this.focused?.handleKey(event) ?? false;
    const seen = new Set<SessionHandle | null>();
    let taken = false;
    for (const pane of this.#panes) {
      if (seen.has(pane.session)) continue;
      seen.add(pane.session);
      if (pane.handleKey(event)) taken = true;
    }
    return taken;
  }

  #makeDivider(direction: SplitDirection, path: LayoutPath, index: number): Divider {
    const divider = new Divider(this.#ctx, {
      id: `divider-${nextId++}`,
      axis: direction,
      onDrag: (delta) => this.onModelResizeDivider?.(path, index, delta),
    });
    this.#dividerRefs.set(divider, { path, index });
    // It is a segment of the pane frame, so its ends finish as junctions.
    divider.tees = true;
    // Every cell it draws is merged against the frame's geometry, so a seam
    // meeting a seam at one cell draws a ┼ rather than the last tee to land.
    divider.junction = () => this.#junctionFrame();
    return divider;
  }

  /**
   * `id` is the pane's model identity (layout.ts newPaneId), used as the
   * renderable's tree id too so a pane has one identifier rather than two.
   * The caller adds it to `#panes`, because where a pane lands in that list is
   * layout order and only the projection knows it.
   *
   * The content decides which kind of leaf it gets, and whether it needs a
   * session. This is the one place that asks: everything else in the window
   * addresses a Pane, so a plugin leaf tiles, splits and closes without a second
   * path through any of it. A pty always names a session and shows its terminal
   * grid; a plugin shows the Solid subtree a pane type registered, fed by the
   * session's frames when it has one and rendered from the descriptor alone when
   * it does not (the editor).
   */
  #makePane(content: PaneContent, session: SessionHandle | null, id = newPaneId()): Pane {
    const pane =
      content.kind === "plugin"
        ? new ComponentPane(this.#ctx, {
            id,
            session,
            paneType: content.type,
            descriptor: content.descriptor,
            view: this.#paneContent ?? undefined,
          })
        : // pty content always names a session — the wire schema says so.
          new TerminalPane(this.#ctx, { id, session: session! });
    setWeight(pane, 1);
    pane.onFocusRequest = (p) => this.onModelFocus?.(p.id);
    pane.onCopy = this.onCopy;
    pane.onCopyError = this.onCopyError;
    return pane;
  }

  /**
   * Set the focused pane from its model identity: re-focus after a rebuild, or
   * the active window's pane after a window or space switch.
   *
   * This is a rendering concern, not a model write — the daemon owns focus and
   * the next revision reinstates it. It records last-pane, clears a zoom the
   * selection leaves behind, and repaints the chrome that keys off focus.
   */
  focus(pane: Pane) {
    // Looking at another pane means you are done with the zoom, which is also
    // what tmux's select-pane does. Zoom survives switching *windows*, though:
    // that is navigation, not a change of mind about this layout.
    if (this.#state.zoom && pane.id !== this.#state.zoom.pane) this.#unzoom();
    // The pane being left becomes last-pane's other endpoint, the way tmux's
    // window_set_active_pane records a last pane on every select. Re-focusing
    // the pane already on screen — a window switch landing back on its own
    // focus — is not a change of mind, so it leaves the pair alone.
    if (pane.id !== this.#state.focus) {
      this.#state.last = this.#state.focus;
      this.#state.focus = pane.id;
      this.#layout = makeLayout({ ...this.#layout, focus: pane.id });
    }
    for (const p of this.#panes) p.active = p === pane;
    this.#refreshChrome();
    this.onChange?.();
    this.#ctx.requestRender();
  }

  #unzoom() {
    const zoom = this.#state.zoom;
    if (!zoom) return;
    this.#state.zoom = null;
    this.#mount(zoom.from, this.#state.preset);
  }

  /** Model-derived neighbour query shared by pane borders and divider caps. */
  #hasNeighbour(node: Pane | Divider, axis: SplitDirection, direction: -1 | 1): boolean {
    if (node instanceof Pane) {
      return paneHasNeighbour(this.#layout, node.id, axis, direction);
    }
    const ref = this.#dividerRefs.get(node);
    return ref ? dividerHasNeighbour(this.#layout, ref.path, axis, direction) : false;
  }

  /**
   * Recompute who draws which border, and which divider is next to the focus.
   *
   * Every pane draws the sides that face the window's outer edge; a side facing
   * another pane belongs to the divider between them, so the frame stays one
   * cell thick at every seam.
   */
  #refreshChrome() {
    const gap = runtime["appearance.gap"];
    // Without a gap the pane frame is the only usable edge, so outerBorder is
    // intentionally ignored. It only changes the separated-border mode.
    const showOuterBorder = runtime["appearance.outerBorder"];
    const edge = (pane: Pane, axis: SplitDirection, direction: -1 | 1) =>
      gap || (!this.#hasNeighbour(pane, axis, direction) && showOuterBorder);
    const focused = this.focused;
    const floating = new Set(this.#layout.floats.map((float) => float.id));
    for (const pane of this.#panes) {
      // A float draws all four sides, always. There is no divider at any of its
      // edges to draw them for it, and nothing but its own frame separating it
      // from the panes it covers — so the outer-border setting, which is about
      // whether the window has a rim, has nothing to say about a float.
      if (floating.has(pane.id)) {
        pane.edges = { top: true, right: true, bottom: true, left: true };
        continue;
      }
      pane.edges = {
        left: edge(pane, "row", -1),
        right: edge(pane, "row", 1),
        top: edge(pane, "column", -1),
        bottom: edge(pane, "column", 1),
      };
    }
    for (const divider of this.#dividers()) {
      divider.setPaneGap(runtime["appearance.gap"] ? 1 : 0);
      // A divider's ends meet the window's outer border exactly where it has no
      // neighbour of its own across the perpendicular axis.
      const cross: SplitDirection = divider.axis === "row" ? "column" : "row";
      divider.capStart = !this.#hasNeighbour(divider, cross, -1);
      divider.capEnd = !this.#hasNeighbour(divider, cross, 1);
      divider.adjacentToFocus = focused ? this.#touches(divider, focused) : false;
    }
  }

  /** Recompute borders after something outside the window changed — the only
   *  case being the sidebar opening or closing. */
  refreshChrome() {
    this.#refreshChrome();
    this.#ctx.requestRender();
  }

  #dividers(root: Renderable = this.root, out: Divider[] = []): Divider[] {
    for (const child of root.getChildren()) {
      if (child instanceof Divider) out.push(child);
      else if (!(child instanceof Pane)) this.#dividers(child, out);
    }
    return out;
  }

  /**
   * The window's frame, as a query for junction cells.
   *
   * Layout is final by the time anything draws, so a divider resolves every
   * cell it touches — its own line, its capped ends, and the tee one cell past
   * an uncapped end — against the frame lines that actually pass through it.
   * A frame cell is a divider's rect, a pane border it owns, or the edge of the
   * pane area. Uncapped ends are presence too: the tee one cell past a divider
   * lands on a cell the line on the far side also claims, and both sides must
   * agree it is a junction.
   *
   * Two dividers never share a cell along their own axis (the split tree
   * alternates), so at most one line crosses another at a junction cell. What
   * *can* collide is a crossing seam meeting two collinear seams at one cell —
   * the ┼ case — and resolving the glyph from geometry instead of paint order
   * is what makes that cell right from either drawer.
   */
  #junctionFrame(): JunctionFrame {
    const dividers = this.#dividers();
    const panes = this.#panes;

    const vertical = (x: number, y: number): boolean => {
      for (const d of dividers) {
        if (d.axis !== "row") continue;
        if (d.x === x && y >= d.y && y < d.y + d.height) return true;
        if (d.tees && !d.capStart && d.x === x && y === d.y - 1) return true;
        if (d.tees && !d.capEnd && d.x === x && y === d.y + d.height) return true;
      }
      for (const p of panes) {
        if (p.edges.left && p.x === x && y >= p.y && y < p.y + p.height) return true;
        if (p.edges.right && p.x + p.width - 1 === x && y >= p.y && y < p.y + p.height) return true;
      }
      return false;
    };

    const horizontal = (x: number, y: number): boolean => {
      for (const d of dividers) {
        if (d.axis !== "column") continue;
        if (d.y === y && x >= d.x && x < d.x + d.width) return true;
        if (d.tees && !d.capStart && d.y === y && x === d.x - 1) return true;
        if (d.tees && !d.capEnd && d.y === y && x === d.x + d.width) return true;
      }
      for (const p of panes) {
        if (p.edges.top && p.y === y && x >= p.x && x < p.x + p.width) return true;
        if (p.edges.bottom && p.y + p.height - 1 === y && x >= p.x && x < p.x + p.width)
          return true;
      }
      return false;
    };

    return { vertical, horizontal };
  }

  /** True when the pane sits immediately on either side of the divider — the
   *  shared border is that pane's border too, so it highlights with it. */
  #touches(divider: Divider, pane: Pane): boolean {
    const ref = this.#dividerRefs.get(divider);
    return ref ? dividerTouchesPane(this.#layout, ref.path, ref.index, pane.id) : false;
  }

  /**
   * Take a pane out of the layout and hand it over, alive — the source half of
   * a break-pane. The process keeps running and its terminal keeps its state;
   * only ownership moves.
   *
   * The same eviction `close` performs, stopping one step earlier. Both take
   * the pane out of the arrangement and let the survivors grow into the space;
   * they differ only in what happens to the pane that fell out, which is why
   * #project hands it back rather than deciding.
   *
   * Returns the pane, or null when this window does not hold it.
   */
  detachPane(pane: Pane): Pane | null {
    // Works zoomed or not: the arrangement is read from the layout, which under
    // a zoom is the one the zoom captured, and projecting the result is what
    // drops the zoom. Closing the zoomed pane itself is the same path.
    const layout = this.exportLayout();
    if (placementOf(layout, pane.id) === null) return null;
    // Losing a pane moves the window off whatever preset it matched: the
    // arrangement now has one fewer pane than the preset describes.
    const [evicted] = this.#project(closeLayout(layout, pane.id), null);
    return evicted ?? null;
  }

  /** Adopt a pane and its session, detached from another window — break-pane's
   *  destination half. The process and its terminal state are untouched; only
   *  ownership moves, so the session's hooks are re-pointed here and an exit
   *  closes the pane in the window it now lives in. The caller detaches first,
   *  so the pane arrives unmounted and with no other owner. */
  adopt(session: SessionHandle, pane: Pane, scope: Scope.Closeable) {
    // The newcomer is hung straight off the root rather than projected, so the
    // zoom has to come down first: a zoomed window has its other panes
    // unmounted, and adding a second pane beside the zoomed one would leave
    // them stranded there with no arrangement on screen to rejoin.
    this.#unzoom();
    this.#sessions.push(session);
    // The scope comes from the window that relinquished it — see the note on
    // #scopes for why it travels rather than being re-forked here. Required,
    // not optional: a session in a window without a scope is one nothing will
    // ever release, and making that unrepresentable is cheaper than detecting it.
    this.#scopes.set(session, scope);
    this.#bind(session);
    this.#panes.push(pane);
    pane.onFocusRequest = (p) => this.onModelFocus?.(p.id);
    this.#mount(appendPane(this.#layout, { id: pane.id, content: contentFor(session) }), null);
  }

  /** Close a pane and destroy its view. The daemon owns stopping a backend when
   * this was its last view; a pane projection never owns that decision. */
  close(pane: Pane) {
    if (!this.detachPane(pane)) return;
    pane.destroyRecursively();
    // #project refocused a survivor (which notified) or left the window
    // empty — and an empty window needs the app told, so it can close it or
    // decide what to show next.
    if (this.#panes.length === 0) this.onChange?.();
  }

  /**
   * This window's arrangement, as data that can be stored and rebuilt.
   *
   * The model remains resident while zoom merely changes its projection to one
   * pane, so export never has to infer an arrangement from mounted renderables.
   * Dividers are absent from the model because one is derivable between every
   * adjacent sibling pair.
   */
  exportLayout(): Layout {
    return this.#layout;
  }

  /**
   * Rebuild the window from a new arrangement, returning the panes it had no
   * slot for.
   *
   * A reshape always drops the zoom. The layout a zoom would return to is the
   * one being replaced, so keeping it would mean unzooming later into an
   * arrangement that no longer describes this window.
   */
  #project(wanted: Layout, preset: LayoutPreset | null): Pane[] {
    this.#state.zoom = null;
    return this.#mount(wanted, preset);
  }

  /**
   * Put the window on screen as `wanted` says, under whatever zoom is in force.
   *
   * Two passes, because "which panes exist" and "how they are arranged" are
   * different questions and only the first is settled by the layout alone.
   * Separating them is what lets a zoom mount one pane without the others being
   * destroyed or parked somewhere off the tree: they are still panes of this
   * window, still in `#panes`, still fed by the sync fan-out — just not shown.
   */
  #mount(wanted: Layout, preset: LayoutPreset | null): Pane[] {
    const byId = new Map(this.#sessions.map((session) => [session.id, session]));
    // An arbitrary layout matches no preset, so that is the default.
    this.#state.preset = preset;

    // Who fills which slot is decided before anything is built, in two passes.
    // A slot naming a pane that exists must get that pane, so those are claimed
    // first — one interleaved pass would let an earlier slot take, on session
    // alone, the very pane a later slot named outright.
    const spare = new Set(this.#dismantle());
    this.#panes.length = 0;
    const filled = new Map<string, Pane>();

    const claim = (slot: PaneRef, match: (pane: Pane) => boolean) => {
      if (filled.has(slot.id)) return;
      for (const pane of spare) {
        if (!match(pane)) continue;
        filled.set(slot.id, pane);
        spare.delete(pane);
        return;
      }
    };
    // Both planes, in one list: which pane fills a slot has nothing to do with
    // where that slot is placed, and a pane that floats after a rebuild may
    // well be the same one that was tiled before it.
    const slots = layoutRefs(wanted);
    for (const slot of slots) claim(slot, (pane) => pane.id === slot.id);
    for (const slot of slots)
      claim(slot, (pane) => {
        const session = paneSession(slot.content);
        // A sessionless spare pane (client-rendered plugin) has no session to
        // match a session-backed slot by.
        return session !== undefined && pane.session !== null && pane.session.id === session;
      });

    // PASS ONE — which panes exist. Every slot ends up with a pane, reused or
    // freshly made, and `#panes` comes out in layout order whether or not the
    // pane is going to be mounted.
    for (const slot of slots) {
      const session = paneSession(slot.content);
      const pane =
        filled.get(slot.id) ??
        // A sessionless plugin slot makes no session lookup; it fills from its
        // content alone.
        this.#makePane(slot.content, session ? (byId.get(session) ?? null) : null, slot.id);
      filled.set(slot.id, pane);
      this.#panes.push(pane);
    }

    // An imported layout may name foreign pane IDs. The live pane keeps its own
    // identity, and the resident model records that resolved identity once,
    // before any renderables are built from it.
    const requestedFocus = wanted.focus ? filled.get(wanted.focus) : undefined;
    const next = requestedFocus ?? this.#panes[0];
    const panesById = new Map<string, Pane>();
    const materialize = (node: LayoutNode): LayoutNode => {
      if (node.type === "pane") {
        const pane = filled.get(node.id)!;
        panesById.set(pane.id, pane);
        return { ...node, id: pane.id, content: withSession(node.content, pane.session?.id) };
      }
      return { ...node, children: node.children.map(materialize) };
    };
    const materializeFloat = (float: LayoutFloat): LayoutFloat => {
      const pane = filled.get(float.id)!;
      panesById.set(pane.id, pane);
      return { ...float, id: pane.id, content: withSession(float.content, pane.session?.id) };
    };
    const materializeDock = (slot: PaneRef): PaneRef => {
      const pane = filled.get(slot.id)!;
      panesById.set(pane.id, pane);
      return { ...slot, id: pane.id, content: withSession(slot.content, pane.session?.id) };
    };
    const dockStrips = wanted.docks ?? emptyDockStrips();
    this.#layout = makeLayout({
      root: wanted.root ? materialize(wanted.root) : null,
      floats: wanted.floats.map(materializeFloat),
      docks: {
        left: dockStrips.left.map(materializeDock),
        right: dockStrips.right.map(materializeDock),
        top: dockStrips.top.map(materializeDock),
        bottom: dockStrips.bottom.map(materializeDock),
      },
      dockSizes: wanted.dockSizes,
      focus: next?.id,
    });

    const build = (node: LayoutNode, path: LayoutPath): Renderable => {
      if (node.type === "pane") {
        const pane = panesById.get(node.id)!;
        tile(pane, node.weight);
        return pane;
      }
      if (node.type === "container") {
        const renderer = layoutKindRenderer(node.kind);
        const children = node.children.map((child, i) => build(child, [...path, i]));
        // A container whose plugin is no longer loaded has no renderer to
        // arrange its children — fall back to a plain flex box rather than
        // refusing to mount the window.
        if (!renderer) {
          const box = new BoxRenderable(this.#ctx, { id: `container-${nextId++}` });
          setWeight(box, node.weight);
          children.forEach((child) => box.add(child));
          return box;
        }
        return renderer.render(this.#ctx, node, children);
      }
      const box = new BoxRenderable(this.#ctx, { id: `split-${nextId++}` });
      setDirection(box, node.direction);
      setWeight(box, node.weight);
      fill(box, node, path);
      return box;
    };

    // Dividers are derived, never serialized: one sits between every adjacent
    // pair.
    const fill = (
      box: BoxRenderable,
      node: Extract<LayoutNode, { type: "split" }>,
      path: LayoutPath,
    ) => {
      node.children.forEach((child, i) => {
        if (i > 0) box.add(this.#makeDivider(node.direction, path, i - 1));
        box.add(build(child, [...path, i]));
      });
    };

    // PASS TWO — how they are arranged. A split at the root goes *into* the
    // root box rather than under a fresh one: the root carries the outermost
    // axis itself, and an extra level here would be a shape exportLayout
    // immediately collapses away.
    const zoom = this.#state.zoom;
    const hasDocks = DOCK_SIDES.some((side) => dockStrips[side].length > 0);
    const buildDocks = (center: BoxRenderable) => {
      const size = (side: DockSide) =>
        dockStrips[side].length === 0
          ? 0
          : (this.#layout.dockSizes?.[side] ?? dockDefaultSize(side));
      // Geometry caps every strip at half its viewport axis. Keep the same cap
      // in Yoga, where percentages also keep it true after a terminal resize.
      const limit = (side: DockSide) =>
        side === "left" || side === "right"
          ? { maxWidth: "50%" as const }
          : { maxHeight: "50%" as const };
      const add = (box: BoxRenderable, side: DockSide) => {
        setDirection(box, side === "left" || side === "right" ? "column" : "row");
        dockStrips[side].forEach((slot, index) => {
          if (index > 0) {
            box.add(
              new Divider(this.#ctx, {
                id: `dock-divider-${side}-${nextId++}`,
                axis: side === "left" || side === "right" ? "column" : "row",
              }),
            );
          }
          const pane = panesById.get(slot.id);
          if (pane) {
            tile(pane, 1);
            box.add(pane);
          }
        });
      };
      const top = new BoxRenderable(this.#ctx, {
        id: `dock-top-${nextId++}`,
        height: size("top"),
        ...limit("top"),
      });
      const bottom = new BoxRenderable(this.#ctx, {
        id: `dock-bottom-${nextId++}`,
        height: size("bottom"),
        ...limit("bottom"),
      });
      const body = new BoxRenderable(this.#ctx, {
        id: `dock-body-${nextId++}`,
        flexGrow: 1,
        flexDirection: "row",
      });
      const centerColumn = new BoxRenderable(this.#ctx, {
        id: `dock-center-column-${nextId++}`,
        flexGrow: 1,
        flexDirection: "column",
      });
      const left = new BoxRenderable(this.#ctx, {
        id: `dock-left-${nextId++}`,
        width: size("left"),
        ...limit("left"),
      });
      const right = new BoxRenderable(this.#ctx, {
        id: `dock-right-${nextId++}`,
        width: size("right"),
        ...limit("right"),
      });
      add(top, "top");
      add(bottom, "bottom");
      add(left, "left");
      add(right, "right");
      body.add(left);
      centerColumn.add(top);
      centerColumn.add(center);
      body.add(centerColumn);
      body.add(right);
      this.root.add(body);
      this.root.add(bottom);
    };
    const center = new BoxRenderable(this.#ctx, { id: `dock-center-${nextId++}`, flexGrow: 1 });
    if (zoom) {
      // One pane, no dividers, and every other pane left unmounted. Nothing
      // else has to be remembered for the way back: `zoom.from` is the whole
      // arrangement, and projecting it again is what restores it.
      const pane = panesById.get(zoom.pane);
      if (pane) {
        tile(pane, 1);
        (hasDocks ? center : this.root).add(pane);
      }
    } else if (this.#layout.root === null) {
      // Nothing to build: closing the last pane empties the window, which is a
      // state it really has until the app decides to close it. A window that is
      // only floats lands here too, and the loop below puts them up.
    } else if (this.#layout.root.type === "split") {
      setDirection(hasDocks ? center : this.root, this.#layout.root.direction);
      fill(hasDocks ? center : this.root, this.#layout.root, []);
    } else {
      (hasDocks ? center : this.root).add(build(this.#layout.root, []));
    }
    if (hasDocks) {
      setDirection(this.root, "column");
      buildDocks(center);
    }

    // Floats last, so they are over the tiled tree in paint order, and by
    // percentage so a terminal resize reflows them without the model being
    // touched. Absolute takes them out of the flex pass entirely: the tiled
    // panes size as though the float were not there, which is the whole
    // difference between floating and tiling.
    for (const float of this.#layout.floats) {
      const pane = panesById.get(float.id);
      // A float that IS the zoom target was already mounted filling the window.
      if (!pane || zoom?.pane === float.id) continue;
      pane.position = "absolute";
      pane.left = `${float.x * 100}%`;
      pane.top = `${float.y * 100}%`;
      pane.width = `${float.width * 100}%`;
      pane.height = `${float.height * 100}%`;
      this.root.add(pane);
    }

    if (next) {
      // Deliberately NOT clearing the focus first, the way this used to:
      // focus() records the pane being left as last-pane, and a rebuild that
      // moves focus is a change of mind exactly like a selection — tmux's
      // window_set_active_pane does this bookkeeping after a split, a close or
      // an arrange too. The one exception is a rebuild that keeps the same pane
      // focused, which focus() sees as no change and leaves the pair alone.
      this.focus(next);
    } else {
      // An empty window has no focus and nothing for last-pane to toggle to.
      this.#state.focus = null;
      this.#layout = makeLayout({ ...this.#layout, focus: undefined });
    }
    this.#refreshChrome();
    this.onChange?.();
    this.#ctx.requestRender();
    return [...spare];
  }

  /**
   * Strip the window back to bare panes, returning them.
   *
   * Boxes and dividers are the derived half of the tree, so they are destroyed
   * rather than reused; the panes are the part that owns state worth keeping.
   *
   * The panes come from `#panes` rather than from walking the tree, because a
   * zoom leaves most of them unmounted and a walk would miss exactly those —
   * reporting the window as having lost the panes it is merely not showing.
   * Taking them off their parents first also leaves the walk with nothing but
   * derived nodes to destroy.
   */
  #dismantle(): Pane[] {
    const panes = [...this.#panes];
    for (const pane of panes) (pane.parent as BoxRenderable | null)?.remove(pane);
    const walk = (box: BoxRenderable) => {
      // Children are copied before removal — removing while iterating the live
      // child list skips every other one.
      for (const child of box.getChildren().slice()) {
        box.remove(child);
        if (child instanceof Divider) child.destroy();
        else if (child instanceof BoxRenderable) {
          walk(child);
          child.destroy();
        }
      }
    };
    walk(this.root);
    return panes;
  }

  /** Release every session and free its terminal. The finalizer `Window.make`
   *  installs, so nothing calls it by hand; idempotent, safe on an exit path.
   *
   *  Panes come down FIRST. A pane renders straight out of its session's
   *  terminal, so freeing the terminal under a still-mounted pane is a
   *  use-after-free into ghostty — a segfault on the next frame, not an
   *  exception. */
  get release(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const pane of this.#panes.slice()) this.close(pane);
      for (const session of this.#sessions.slice()) yield* this.#releaseSession(session);
      this.#sessions.length = 0;
    });
  }
}
