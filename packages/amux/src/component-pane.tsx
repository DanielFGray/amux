/** @jsxImportSource @opentui/solid */
import { RendererContext, _render } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { createSignal, type Accessor, type Signal } from "solid-js";
import { BoxRenderable, type CliRenderer, type KeyEvent, type RenderContext } from "@opentui/core";
import type * as Scope from "effect/Scope";
import { Pane, PaneRenderable } from "./pane.ts";
import type { SessionHandle } from "./session-handle.ts";
import type { OwnerJsonText } from "./layout.ts";
import type { Options } from "./options.ts";
import { acquireRenderable } from "./bridge.ts";

/**
 * What a plugin pane's view is told about the frame it lives in.
 *
 * Everything here changes while the view is mounted — a split resizes it, a
 * focus change moves the keyboard — so each is an accessor rather than a value.
 * The pane's content is not: a pane shows the content it was given for its
 * whole life. `type` and `descriptor` come straight from the content; `session`
 * is that content's backend, empty when it has none (a client-rendered view
 * such as the editor). A view that needs a backend must gate on session being
 * non-empty, the same way an active gate is required of one that takes typing.
 */
export interface PaneViewProps {
  /** The pane's session id, or empty when the content has no backend. */
  sessionId: string;
  /** This pane's own id — how a view addresses itself, e.g. to close its
   *  pane (:q) or update its own descriptor (:e). The session id names the
   *  backend, which a client-only view has none of; the pane id names the
   *  frame, which every view has. */
  paneId: string;
  /** The pane type, which is what selected this view. */
  paneType: string;
  /** The content's descriptor — owner JSON text, opaque to the pane host. */
  descriptor: OwnerJsonText;
  /** The content rect, the pane's own less the sides it draws. */
  width: Accessor<number>;
  height: Accessor<number>;
  /** Whether this pane is the window's focused one. A view that takes typing
   *  must gate its input's `focused` on this, or an unfocused pane's composer
   *  swallows the keys meant for whichever pane the user is actually in. */
  active: Accessor<boolean>;
  /**
   * Hand text to the host clipboard via OSC 52 (same path as mouse selection
   * and keyboard copy mode). Optional `target` maps vim `"+` → clipboard and
   * `"*` → primary. No-op when the pane has no copy handler (tests/headless).
   */
  copyText: (text: string, target?: "clipboard" | "primary") => void;
  /**
   * Register a raw-key handler the pane consults while it is focused
   * (ts-bb14fd).
   *
   * A view whose content is a full-screen modal — a vim editor — needs every
   * key the keymap did not claim, which is precisely what OpenTUI's normal
   * focus routing cannot hand it: the routing only reaches renderables, and a
   * buffer renderer is not one. The view calls this once on mount with its
   * handler, and with `null` on teardown; while registered and focused, the
   * pane forwards each unclaimed key to it. A view without a handler keeps
   * OpenTUI's routing untouched.
   *
   * The handler returns whether it consumed the key, the same contract as
   * `Pane.handleKey`. Leader-prefixed and bound sequences are never consulted:
   * this only runs for keys the keymap did not claim, so the leader always
   * wins before any view sees a key.
   */
  captureKeys: (handler: ((event: KeyEvent) => boolean) | null) => void;
}

/**
 * What draws a component session.
 *
 * One function for the whole workspace rather than one per pane: which view a
 * session gets is decided by the session, and a pane is a frame that mounts
 * whatever this answers. See PaneViews in env.ts for where it comes from.
 */
export type PaneView = (props: PaneViewProps) => JSX.Element;

/**
 * A pane whose content is a Solid subtree rather than a terminal grid.
 *
 * The other half of SessionHandle.kind: a pty session's bytes go through an
 * emulator to a grid, and a component session's semantic frames go through a
 * Solid component to renderables. Both are leaves of the same split tree —
 * they tile, split, focus, zoom and close identically, because all of that is
 * the Pane wrapper and none of it asks what fills the frame.
 *
 * The subtree is mounted into a content box this view positions itself rather
 * than into the view node, because the view node has to stay a pure flex item:
 * see the note on PaneView's inset. The box is absolutely placed and so takes
 * no part in the split's sizing, which is what keeps a component leaf the
 * exact rectangle geometry.ts says it is.
 */
class ComponentPaneView extends PaneRenderable {
  #content: BoxRenderable;
  #dispose: (() => void) | null = null;
  // The frame, as the view sees it. Signals rather than fields because the
  // subtree is Solid: a resize or a focus change has to propagate, not just be
  // readable.
  #size: Signal<{ width: number; height: number }> = createSignal({ width: 1, height: 1 });
  #focus: Signal<boolean> = createSignal(false);
  /** The plugin's raw-key handler, when it registered one. Consulted only
   *  while this pane is the focused one; see PaneViewProps.captureKeys. */
  #captureKeys: ((event: KeyEvent) => boolean) | null = null;
  /** Durable content type this leaf was built for — see ComponentPane.paneType. */
  readonly paneType: string;

  constructor(
    ctx: RenderContext,
    options: {
      id: string;
      session: SessionHandle | null;
      paneType: string;
      descriptor?: OwnerJsonText;
      view?: PaneView;
    },
    optionsRuntime: Options,
  ) {
    super(ctx, options, optionsRuntime);
    this.paneType = options.paneType;
    this.#content = new BoxRenderable(ctx, {
      id: `${options.id}-content`,
      position: "absolute",
      flexDirection: "column",
      overflow: "hidden",
    });
    this.add(this.#content);
    this.onContentResize();

    const view = options.view;
    // No view registered is a real state, not an error: a workspace that never
    // named one (a test, a headless client) shows the frame and nothing in it.
    if (!view) return;
    // Every hook in @opentui/solid resolves the renderer through this context,
    // and a Renderable is constructed with the very object that implements it —
    // the interface is the narrow half of the renderer, not a different thing.
    const renderer = ctx as CliRenderer;
    const props: PaneViewProps = {
      sessionId: this.session?.id ?? "",
      // A pane addresses itself by its own id, not its session's — a
      // client-only view (:q, :e) needs the frame, and has no session.
      paneId: options.id,
      // A plugin pane is selected by its durable content, never by the
      // process a session happens to be running.
      paneType: options.paneType,
      descriptor: options.descriptor ?? "{}",
      width: () => {
        this.#size[0]();
        return this.content.width;
      },
      height: () => {
        this.#size[0]();
        return this.content.height;
      },
      active: this.#focus[0],
      copyText: (text, target) => {
        this.copyText(text, target);
      },
      captureKeys: (handler) => {
        this.#captureKeys = handler;
      },
    };
    this.#dispose = _render(
      () => <RendererContext.Provider value={renderer}>{view(props)}</RendererContext.Provider>,
      this.#content,
    );
  }

  /**
   * Hand the key to the view's registered raw-key handler — but only while
   * this pane is the focused one.
   *
   * The default (no handler, or not focused) is the old answer: return false
   * and let OpenTUI route the key to whichever renderable inside the subtree
   * holds focus, which is how a composer inside a chat view receives
   * characters. A view that registered a handler and has focus gets every
   * unclaimed key instead — the leader and bound sequences never reach here
   * (the keymap claims them first), so the leader always wins before the view
   * sees a key.
   */
  override handleKey(event: KeyEvent): boolean {
    if (!this.active) return false;
    return this.#captureKeys?.(event) ?? false;
  }

  protected override onActiveChange(active: boolean): void {
    this.#focus[1](active);
  }

  protected override onContentResize(): void {
    const { width, height } = this.content;
    // Absolute offsets are relative to the parent's own box, so the pane's
    // screen position is not part of them — only the sides it draws.
    this.#content.left = this.edges.left ? 1 : 0;
    this.#content.top = this.edges.top ? 1 : 0;
    this.#content.width = width;
    this.#content.height = height;
    this.#size[1]({ width, height });
  }

  protected override destroySelf(): void {
    this.#dispose?.();
    this.#dispose = null;
    super.destroySelf();
  }
}

export class ComponentPane extends Pane {
  private constructor(view: ComponentPaneView, scope: Scope.Closeable, id: string) {
    super(view, scope, id);
  }

  /** The content.type this leaf was mounted for. Remount when it changes. */
  get paneType(): string {
    return (this.view as ComponentPaneView).paneType;
  }

  /** Constructed with no parent — see the note on TerminalPane.make. */
  static make(
    ctx: RenderContext,
    options: {
      id: string;
      session: SessionHandle | null;
      paneType: string;
      descriptor?: OwnerJsonText;
      view?: PaneView;
    },
    optionsRuntime: Options,
  ): ComponentPane {
    const scope = Pane.makeScope();
    const view = Pane.acquire(
      scope,
      acquireRenderable(() => new ComponentPaneView(ctx, options, optionsRuntime)),
    );
    return new ComponentPane(view, scope, options.id);
  }

  override handleKey(event: KeyEvent): boolean {
    return (this.view as ComponentPaneView).handleKey(event);
  }
}
