/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js";
import type { PaneView } from "../component-pane.tsx";

export interface SessionViews {
  readonly register: (type: string, view: PaneView) => () => void;
  readonly view: PaneView;
  readonly has: (type: string) => boolean;
}

export function createSessionViews(): SessionViews {
  const [views, setViews] = createSignal(new Map<string, PaneView>());

  return {
    register(type, view) {
      if (views().has(type)) throw new Error(`pane type '${type}' is already registered`);
      setViews((current) => new Map(current).set(type, view));
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        setViews((current) => {
          const next = new Map(current);
          next.delete(type);
          return next;
        });
      };
    },
    view: (props) => (
      <Show
        when={views().get(props.paneType)}
        keyed
        fallback={<text>Pane type '{props.paneType}' is unavailable.</text>}
      >
        {(view: PaneView) => view(props)}
      </Show>
    ),
    has: (type) => views().has(type),
  };
}
