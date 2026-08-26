/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { PaneView } from "../component-pane.tsx";
import type { PluginContributions, PluginInstance } from "./contributions.ts";

export interface SessionViews {
  readonly register: (owner: PluginInstance, type: string, view: PaneView) => () => void;
  readonly view: PaneView;
  readonly has: (type: string) => boolean;
}

/**
 * The views a plugin can put inside a pane, one per pane type.
 *
 * Two instances of one plugin may hold the same pane type during a reload; the
 * table decides which of them a pane is looking at, so nothing here has to know
 * that a reload is happening.
 */
export function createSessionViews(contributions: PluginContributions): SessionViews {
  const views = contributions.table<PaneView>();
  return {
    register: (owner, type, view) => views.add(owner, type, view),
    view: (props) => (
      <Show
        when={views.get(props.paneType)}
        keyed
        fallback={<text>Pane type '{props.paneType}' is unavailable.</text>}
      >
        {(view: PaneView) => view(props)}
      </Show>
    ),
    has: (type) => views.get(type) !== undefined,
  };
}
