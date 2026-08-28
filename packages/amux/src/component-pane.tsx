/** @jsxImportSource @opentui/solid */
import { RendererContext, _render } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { createSignal, type Accessor, type Signal } from "solid-js";
import { BoxRenderable, type CliRenderer, type RenderContext } from "@opentui/core";
import { Pane } from "./pane.ts";
import type { SessionHandle } from "./session-handle.ts";
import type { JsonValue } from "./layout.ts";

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
  /** The pane type, which is what selected this view. */
  paneType: string;
  /** The content's descriptor — the plugin's own, opaque to the pane host. */
  descriptor: JsonValue;
  /** The content rect, the pane's own less the sides it draws. */
  width: Accessor<number>;
  height: Accessor<number>;
  /** Whether this pane is the window's focused one. A view that takes typing
   *  must gate its input's `focused` on this, or an unfocused pane's composer
   *  swallows the keys meant for whichever pane the user is actually in. */
  active: Accessor<boolean>;
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
 * The other half of SessionHandle.kind: a pty session's bytes go through an emulator
 * to a grid, and a component session's semantic frames go through a Solid
 * component to renderables. Both are leaves of the same split tree — they tile,
 * split, focus, zoom and close identically, because all of that is the Pane
 * base and none of it asks what fills the frame.
 *
 * The subtree is mounted into a content box this pane positions itself rather
 * than into the pane node, because the pane node has to stay a pure flex item:
 * see the note on Pane's inset. The box is absolutely placed and so takes no
 * part in the split's sizing, which is what keeps a component leaf the exact
 * rectangle geometry.ts says it is.
 */
export class ComponentPane extends Pane {
  #content: BoxRenderable;
  #dispose: (() => void) | null = null;
  // The frame, as the view sees it. Signals rather than fields because the
  // subtree is Solid: a resize or a focus change has to propagate, not just be
  // readable.
  #size: Signal<{ width: number; height: number }> = createSignal({ width: 1, height: 1 });
  #focus: Signal<boolean> = createSignal(false);

  constructor(
    ctx: RenderContext,
    options: {
      id: string;
      session: SessionHandle | null;
      paneType: string;
      descriptor?: JsonValue;
      view?: PaneView;
    },
  ) {
    super(ctx, options);
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
      // A plugin pane is selected by its durable content, never by the
      // process a session happens to be running.
      paneType: options.paneType,
      descriptor: options.descriptor ?? {},
      width: () => {
        this.#size[0]();
        return this.content.width;
      },
      height: () => {
        this.#size[0]();
        return this.content.height;
      },
      active: this.#focus[0],
    };
    this.#dispose = _render(
      () => <RendererContext.Provider value={renderer}>{view(props)}</RendererContext.Provider>,
      this.#content,
    );
  }

  /**
   * Not this pane's to consume.
   *
   * OpenTUI already routes a keystroke to whichever renderable holds focus, and
   * the composer inside this subtree is one. Claiming the key here would
   * preventDefault it and that input would never see a character — the whole
   * reason bindings.ts only prevents the default when the app really took it.
   */
  override handleKey(): boolean {
    return false;
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
