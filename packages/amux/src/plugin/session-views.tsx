/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { PaneView } from "../component-pane.tsx";
import type { PluginContributions, PluginInstance } from "./contributions.ts";
import { ComponentRuntime } from "./component-runtime.ts";

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
  const runtime = new ComponentRuntime();
  return {
    register: (owner, type, view) => {
      // A registration has its own fiber rather than sharing its plugin's
      // lifecycle. That keeps the inverse limited to this pane type while the
      // runtime makes a withdrawn or replaced provider update the live view.
      const id = `session-view:${owner.id}:${owner.generation}:${type}`;
      // Claim eagerly: registration errors have always been reported to the
      // caller synchronously, and a host needs that before it can commit a
      // replacement generation.
      const dispose = views.add(owner, type, view);
      runtime.add({
        id,
        async *run() {
          yield dispose;
        },
      });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        // Registry disposers have always withdrawn synchronously. Retain that
        // contract while the fiber finishes (or, if still loading, eventually
        // observes) the same scoped inverse.
        dispose();
        runtime.remove(id);
      };
    },
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
