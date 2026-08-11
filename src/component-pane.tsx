/** @jsxImportSource @opentui/solid */
import { RendererContext, _render } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { BoxRenderable, type CliRenderer, type RenderContext } from "@opentui/core";
import { Pane } from "./pane.ts";
import type { Session } from "./agent.ts";

/**
 * What draws a component session.
 *
 * One function for the whole workspace rather than one per pane: which view a
 * session gets is decided by the session, and a pane is a frame that mounts
 * whatever this answers. See PaneContent in env.ts for where it comes from.
 */
export type PaneView = (session: Session) => JSX.Element;

/**
 * A pane whose content is a Solid subtree rather than a terminal grid.
 *
 * The other half of Session.kind: a pty session's bytes go through an emulator
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

  constructor(
    ctx: RenderContext,
    options: { id: string; session: Session; view?: PaneView } & Record<string, any>,
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
    this.#dispose = _render(
      () => (
        <RendererContext.Provider value={renderer}>{view(this.session)}</RendererContext.Provider>
      ),
      this.#content,
    );
  }

  protected override onContentResize(): void {
    const { width, height } = this.content;
    // Absolute offsets are relative to the parent's own box, so the pane's
    // screen position is not part of them — only the sides it draws.
    this.#content.left = this.edges.left ? 1 : 0;
    this.#content.top = this.edges.top ? 1 : 0;
    this.#content.width = width;
    this.#content.height = height;
  }

  protected override destroySelf(): void {
    this.#dispose?.();
    this.#dispose = null;
    super.destroySelf();
  }
}
