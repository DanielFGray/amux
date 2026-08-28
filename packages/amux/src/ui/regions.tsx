/** @jsxImportSource @opentui/solid */
import { Show, createComponent, type JSX } from "solid-js";
import type { CliRenderer, KeyEvent, PluginContext } from "@opentui/core";
import { createSlot, createSolidSlotRegistry, type SolidPlugin } from "@opentui/solid";
import { Divider } from "../divider.ts";
import type {
  ContributionTable,
  PluginContributions,
  PluginInstance,
} from "../plugin/contributions.ts";
import type { DockSide } from "../layout.ts";

/**
 * Where a panel can be put, and what the app draws around it.
 *
 * The four edges are docks; `center` is not a region because it is not a slot —
 * it is the pane mux, an imperative BoxRenderable the workspace owns. `overlay`
 * is the modal stack and `float` is transient chrome that never takes focus.
 */
export type { DockSide } from "../layout.ts";
export type Region = DockSide | "overlay" | "float";

/**
 * Which box an edge dock hangs off.
 *
 * `app` spans the whole screen — a global status bar. `center` spans the pane
 * area only, so it sits beside the docks anchored to the app rather than above
 * them. herdr's window list is `top`/`center`: it is one row at the top of the
 * pane area, next to the sidebar, and a naive app-wide top dock would silently
 * move it above the sidebar. Anchor is required for that reason: it decides
 * what a side *means*, and defaulting it would make a panel's declared region
 * change meaning the day a second dock appears.
 */
export type Anchor = "app" | "center";

export type DockSlot = `${DockSide}.${Anchor}`;
export type SlotName = DockSlot | "overlay" | "float";

/** What a docked panel is told about where it landed. */
export interface DockSlotProps {
  side: DockSide;
  anchor: Anchor;
}
/** Modals size themselves against the screen. */
export interface OverlaySlotProps {
  width: number;
  height: number;
}
/** Transient chrome lines up with the pane area rather than the screen. */
export interface FloatSlotProps {
  left: number;
  width: number;
  height: number;
}

export type RegionSlots = Record<DockSlot, DockSlotProps> & {
  overlay: OverlaySlotProps;
  float: FloatSlotProps;
};

interface PanelBase {
  /** Namespaced, because it is the plugin id the slot registry sorts and
   *  reports errors against. */
  id: string;
  /** Ascending: lower renders first — further from the pane area in a dock,
   *  further down the modal stack in the overlay. */
  order?: number;
  title?: string;
  /** Panels stay registered while they are off screen, so a dock keeps its box
   *  in the child list instead of being reparented every time it reappears. */
  visible?: () => boolean;
}

export interface DockPanel extends PanelBase {
  region: DockSide;
  anchor: Anchor;
  /** How thick the panel needs its dock to be: width for left/right, height
   *  for top/bottom. An accessor because it is usually an option. */
  size: () => number;
  /** A floor under `size`, for a panel whose size comes from a drag. */
  minSize?: number;
  /** Whether the dock's inner edge is draggable. The divider is the dock's, not
   *  the panel's: two panels stacked in one dock share one edge, so a drag is
   *  reported to every resizable panel in the dock with the same delta. */
  resizable?: boolean;
  /** How much thicker the dock should be, sign already resolved so that
   *  positive always means bigger whichever edge was dragged. */
  onResize?: (delta: number) => void;
  component: (props: DockSlotProps) => JSX.Element;
}

export interface OverlayPanel extends PanelBase {
  region: "overlay";
  /**
   * Keys the keymap did not claim, while this is the topmost visible overlay.
   *
   * Returns whether the app consumed the key: false leaves it to focus routing,
   * which is how a modal with a text input gets its characters.
   */
  keys?: (event: KeyEvent) => boolean;
  component: (props: OverlaySlotProps) => JSX.Element;
}

export interface FloatPanel extends PanelBase {
  region: "float";
  component: (props: FloatSlotProps) => JSX.Element;
}

export type Panel = DockPanel | OverlayPanel | FloatPanel;

/** The dock edge a drag handle covers: the one facing the pane area. */
const INNER_EDGE = {
  left: { top: 0, right: 0, bottom: 0 },
  right: { top: 0, left: 0, bottom: 0 },
  top: { left: 0, right: 0, bottom: 0 },
  bottom: { left: 0, right: 0, top: 0 },
} as const satisfies Record<
  DockSide,
  { top?: number; right?: number; bottom?: number; left?: number }
>;

export interface Regions {
  /** Put a panel on screen. Returns its disposer, the shape a scope finalizer
   *  wants. The panel appears once the host commits the instance that made it. */
  register: (owner: PluginInstance, panel: Panel) => () => void;
  /** The slot component the layout renders. */
  Slot: ReturnType<typeof createSlot<RegionSlots>>;
  /** Whether anything is registered for a dock at all, visible or not. */
  declared: (side: DockSide, anchor: Anchor) => boolean;
  /** A dock's thickness: the most any visible panel in it asks for. */
  thickness: (side: DockSide, anchor: Anchor) => number;
  /** The dock's drag handle, or null when the dock is empty or fixed. */
  divider: (side: DockSide, anchor: Anchor) => Divider | null;
  /** The visible overlay on top of the stack, which owns unhandled keys. */
  topOverlay: () => OverlayPanel | null;
}

export type RegionReader = Omit<Regions, "register">;

/**
 * The panel registry.
 *
 * Rendering, ordering and per-panel error isolation are @opentui/core's slot
 * registry — the same one a third-party plugin will register through. What is
 * ours is the region map above and the geometry below: dock thickness, the
 * resize dividers and the modal stack's top.
 *
 * Panels are kept as values as well as plugins because the layout needs to know
 * how thick a dock is and whether it has a draggable edge before it can draw
 * one, and a registered plugin is opaque JSX. Both come from the same
 * `register` call, and the geometry read out of the values is order-independent
 * (a maximum, an existence check), so it cannot disagree with the order the
 * registry renders in.
 *
 * The values live in a contribution table, which is what keeps an uncommitted
 * plugin's panels out of the layout: geometry reads only see the committed
 * ones, and a panel's own renderer checks that the table still points at it.
 */
export function createRegions(renderer: CliRenderer, contributions: PluginContributions): Regions {
  const panels = contributions.table<Panel>();
  const registry = createSolidSlotRegistry<RegionSlots>(
    renderer,
    {},
    {
      onPluginError(event) {
        console.error(
          `panel ${event.pluginId} failed during ${event.phase}` +
            (event.slot ? ` in ${event.slot}` : "") +
            `: ${event.error.message}`,
        );
      },
    },
  );
  const Slot = createSlot<RegionSlots>(registry);
  const dividers = new Map<DockSlot, Divider>();

  const registered = () => panels.all().map((entry) => entry.value);
  const inDock = (side: DockSide, anchor: Anchor) =>
    registered().filter(
      (panel): panel is DockPanel => panel.region === side && panel.anchor === anchor,
    );
  const showing = (panel: Panel) => panel.visible?.() ?? true;
  const visibleInDock = (side: DockSide, anchor: Anchor) => inDock(side, anchor).filter(showing);

  const thickness = (side: DockSide, anchor: Anchor) =>
    visibleInDock(side, anchor).reduce(
      (most, panel) => Math.max(most, Math.max(panel.size(), panel.minSize ?? 0)),
      0,
    );

  function divider(side: DockSide, anchor: Anchor): Divider | null {
    const dock = visibleInDock(side, anchor);
    if (thickness(side, anchor) <= 0) return null;
    if (!dock.some((panel) => panel.resizable)) return null;
    const key: DockSlot = `${side}.${anchor}`;
    const existing = dividers.get(key);
    if (existing) return existing;
    // A Divider rather than a component with mouse props: dragging a one-cell
    // target only works if the pointer is claimed on the press, and that is a
    // renderable-level concern. See the note in divider.ts.
    const made = new Divider(renderer, {
      id: `region-divider-${key}`,
      axis: side === "left" || side === "right" ? "row" : "column",
      onDrag: (delta) => {
        // The pointer moves the same way on both edges; growing does not.
        const grow = side === "left" || side === "top" ? delta : -delta;
        for (const panel of visibleInDock(side, anchor)) {
          if (panel.resizable) panel.onResize?.(grow);
        }
      },
    });
    // An invisible hitbox over the dock's own last row or column rather than a
    // line between the dock and the panes: the panes draw all four of their own
    // borders, so resizing a dock costs the pane area no cell and the frame
    // stays independent of what is docked next to it.
    made.hitboxOnly = true;
    made.position = "absolute";
    made.setPosition(INNER_EDGE[side]);
    made.zIndex = 1;
    dividers.set(key, made);
    return made;
  }

  return {
    Slot,
    declared: (side, anchor) => inDock(side, anchor).length > 0,
    thickness,
    divider,
    topOverlay() {
      const open = registered()
        .filter((panel): panel is OverlayPanel => panel.region === "overlay")
        .filter(showing);
      // Registration order breaks ties, which is the registry's own rule, so
      // the last one here is the one drawn on top.
      const stacked = open.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return stacked[stacked.length - 1] ?? null;
    },
    register(owner, panel) {
      const remove = panels.add(owner, panel.id, panel);
      const dispose = registry.register(panelPlugin(owner, panel, panels));
      return () => {
        dispose();
        remove();
      };
    },
  };
}

/**
 * A panel as the slot registry sees it: one renderer, in one slot.
 *
 * The slot registry keys plugins by id, so the generation goes into the id —
 * two generations of one plugin are two entries there, and only the one the
 * contribution table still points at draws anything.
 */
function panelPlugin(
  owner: PluginInstance,
  panel: Panel,
  panels: ContributionTable<Panel>,
): SolidPlugin<RegionSlots> {
  const visible = () => panels.get(panel.id) === panel && (panel.visible?.() ?? true);
  const id = `${panel.id}#${owner.generation}`;
  switch (panel.region) {
    case "overlay":
      return slotPlugin(id, panel, "overlay", (_ctx, props) => (
        <Show when={visible()}>{createComponent(panel.component, props)}</Show>
      ));
    case "float":
      return slotPlugin(id, panel, "float", (_ctx, props) => (
        <Show when={visible()}>{createComponent(panel.component, props)}</Show>
      ));
    default:
      return slotPlugin(id, panel, `${panel.region}.${panel.anchor}`, (_ctx, props) => (
        <Show when={visible()}>{createComponent(panel.component, props)}</Show>
      ));
  }
}

/** The one place a slot name is a computed key, so the cast is one line. */
function slotPlugin<K extends SlotName>(
  id: string,
  panel: Panel,
  name: K,
  render: (ctx: PluginContext, props: RegionSlots[K]) => JSX.Element,
): SolidPlugin<RegionSlots> {
  return {
    id,
    order: panel.order ?? 0,
    slots: { [name]: render } as SolidPlugin<RegionSlots>["slots"],
  };
}
