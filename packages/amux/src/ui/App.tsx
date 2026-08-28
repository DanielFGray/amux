/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { BoxRenderable } from "@opentui/core";
import type { Anchor, DockSide, RegionReader } from "./regions.tsx";

export interface AppProps {
  /** Every panel on screen. The app declares them; this file only decides
   *  where a region lands and how big it is. */
  regions: RegionReader;
  /** The imperative pane tree, adopted as a child so splits keep their own
   *  layout code and their cell-blitting renderables untouched. It is the one
   *  thing here that is not a panel: it is the mux, not a view of it. */
  paneHost: BoxRenderable;
  size: { width: number; height: number };
  /** Breathing room around the pane tree. On the pane host alone: a dock is
   *  chrome and sits flush against the edge it is docked to. */
  padding?: number;
}

/**
 * The screen, as regions.
 *
 * Two nested frames. The outer one is the app: its docks span the whole screen.
 * The inner one is the pane area, and its docks sit beside the outer docks
 * rather than above them — which is where herdr's window list lives, one row at
 * the top of the pane area next to the sidebar, and why a dock declares an
 * anchor rather than only a side.
 *
 * A dock's resize handle is an invisible hitbox over the dock's own inner edge,
 * so the panes keep drawing all four of their own borders and resizing a dock
 * costs the pane area no cell.
 */
export function App(props: AppProps) {
  /** Where the pane area starts, so transient chrome lines up with it rather
   *  than covering the docks. */
  const paneLeft = () =>
    props.regions.thickness("left", "app") + props.regions.thickness("left", "center");

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
      <Dock regions={props.regions} side="top" anchor="app" />

      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <Dock regions={props.regions} side="left" anchor="app" />

        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          <Dock regions={props.regions} side="top" anchor="center" />

          <box style={{ flexGrow: 1, flexDirection: "row" }}>
            <Dock regions={props.regions} side="left" anchor="center" />
            <box style={{ flexGrow: 1, flexDirection: "row", padding: props.padding ?? 0 }}>
              {props.paneHost}
            </box>
            <Dock regions={props.regions} side="right" anchor="center" />
          </box>

          <Dock regions={props.regions} side="bottom" anchor="center" />
        </box>

        <Dock regions={props.regions} side="right" anchor="app" />
      </box>

      <Dock regions={props.regions} side="bottom" anchor="app" />

      <Dynamic
        component={props.regions.Slot}
        name="float"
        left={paneLeft()}
        width={props.size.width - paneLeft()}
        height={props.size.height}
      />
      <Dynamic
        component={props.regions.Slot}
        name="overlay"
        width={props.size.width}
        height={props.size.height}
      />
    </box>
  );
}

/**
 * One edge dock: an ordered stack of panels, as thick as the thickest of them,
 * with its resize handle over its own inner edge.
 *
 * The box stays in its parent's child list for as long as anything is
 * registered here, even at thickness zero. Reparenting the pane box when a dock
 * comes back can leave its first border at the old sibling geometry for one
 * render.
 */
function Dock(props: { regions: RegionReader; side: DockSide; anchor: Anchor }) {
  const across = () => props.side === "left" || props.side === "right";
  const size = () => props.regions.thickness(props.side, props.anchor);

  return (
    <Show when={props.regions.declared(props.side, props.anchor)}>
      <box
        style={{
          ...(across() ? { width: size(), height: "100%" } : { height: size(), width: "100%" }),
          flexShrink: 0,
          flexDirection: "column",
          // The drag handle is positioned against this box.
          position: "relative",
        }}
      >
        <Dynamic
          component={props.regions.Slot}
          name={`${props.side}.${props.anchor}`}
          side={props.side}
          anchor={props.anchor}
        />
        {props.regions.divider(props.side, props.anchor)}
      </box>
    </Show>
  );
}
