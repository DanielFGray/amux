/**
 * A window's split tree, as data.
 *
 * Window owns this model; Boxes, Dividers and panes are a projection wired to
 * agents and a renderer. The model contains everything that defines an
 * arrangement: nesting, axis, relative sizes, and which agent sits in each leaf.
 *
 * Two things need it. Session restore (ts-fa1fdf) has to rebuild a window tree
 * from session.json, and there is nothing else to rebuild *from*: the persisted
 * format currently records a flat agent list per window, which cannot express
 * how those agents were arranged. And a control API needs to hand a layout out
 * and take one back, the way herdr's layout.export/layout.apply do.
 *
 * Dividers are deliberately absent. One sits between every adjacent sibling
 * pair, so their placement is derivable rather than authored — recording them
 * would let a decoded layout disagree with what the window would build.
 *
 * WindowState, at the foot of this file, is the rest of what a window is once
 * the renderer is taken away: focus, last-pane, zoom, sync and preset. It sits
 * beside Layout rather than on Window because none of it needs a renderer
 * either, and a headless window is the two of them together.
 */

import { Effect, ParseResult, Schema as S } from "effect";
import type { SplitDirection } from "./window.ts";
import { MAX_LAYOUT_BYTES, MAX_LAYOUT_DEPTH, MAX_LAYOUT_NODES } from "./limits.ts";

/** The format written into session.json and any exported string. */
export const LAYOUT_VERSION = 1;

export type LayoutNode = LayoutPane | LayoutSplit;

/** A JSON value, the shape a plugin pane's descriptor is validated against. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * What fills a pane: a pty session, or a plugin view.
 *
 * This is the split the plugin stress test forced. A pane used to BE a view of
 * a session — its identity and its content were one `agent` id, so nothing that
 * was not a session could ever fill a pane. Content now stands apart: a pty
 * pane references a session; a plugin pane references a registered pane type
 * plus a descriptor, and may additionally reference a session when it has a
 * daemon backend (the agent harness does). A plugin pane with no session is a
 * real state, not an error — it is a client-rendered view (the editor).
 */
export type PaneContent =
  | { readonly kind: "pty"; readonly session: string }
  | {
      readonly kind: "plugin";
      readonly type: string;
      readonly descriptor: JsonValue;
      readonly session?: string;
    };

/** The session a pane's content views, if its content has one. */
export function paneSession(content: PaneContent): string | undefined {
  return content.kind === "pty" ? content.session : content.session;
}

/** Rewrite a pane's content with a resolved session id. Materializing an
 *  imported layout hands the resident model the session that actually fills the
 *  pane — the pty case already names it, a session-backed plugin pane gets its
 *  worker confirmed. A pane that resolves to no session (a client-rendered
 *  plugin pane, and a bug for pty content) keeps its content as it is. */
export function withSession(content: PaneContent, session: string | undefined): PaneContent {
  return session === undefined ? content : { ...content, session };
}

/**
 * A pane's identity, and what it is a viewport onto.
 *
 * Two panes can show the same session — that is what revealing an agent twice
 * leaves behind — so a session id cannot name a pane, and a layout that had
 * only session ids could not say which of the two had focus, or which one a
 * command meant. The pane id is the missing half: `content` says what you are
 * looking at, `id` says which viewport you are looking through.
 *
 * Ids are unique across the whole process rather than within a window, because
 * break-pane moves a pane between windows and its identity has to survive that.
 * They are what a control API targets, the way tmux addresses panes by `%3`.
 */
export interface PaneRef {
  id: string;
  content: PaneContent;
}

export interface LayoutPane extends PaneRef {
  type: "pane";
  /** Flex weight, relative to siblings. */
  weight: number;
}

export interface LayoutSplit {
  type: "split";
  direction: SplitDirection;
  weight: number;
  /** Two or more. A one-child split is a split in name only and is collapsed. */
  children: LayoutNode[];
}

/**
 * A pane placed over the tiled tree instead of inside it.
 *
 * Where a pane is placed is independent of what fills it: a terminal can float
 * and a component can tile. So a float is the same PaneRef, differing only in
 * how it is sized — by its own rectangle rather than against siblings, which is
 * why it has a rect where a LayoutPane has a weight.
 *
 * The rect is fractions of the window rather than cells, because a float has to
 * survive a resize: a rectangle captured at 200 columns is off the edge at 100.
 * Fractions are also what the renderer wants, since an absolutely positioned
 * node takes percentages and yoga reflows it without the model being touched.
 *
 * No `type` discriminant. A LayoutNode needs one because pane and split share a
 * union; a float does not, because the array it lives in is what says it floats.
 */
export interface LayoutFloat extends PaneRef {
  /** Left and top edges, as a fraction of the window. */
  x: number;
  y: number;
  /** Size, as a fraction of the window. */
  width: number;
  height: number;
}

export type DockSide = "left" | "right" | "top" | "bottom";
export const DOCK_SIDES = ["left", "right", "top", "bottom"] as const;
export type DockStrips = { readonly [side in DockSide]: readonly PaneRef[] };
export const emptyDockStrips = (): DockStrips => ({ left: [], right: [], top: [], bottom: [] });
export const dockDefaultSize = (side: DockSide): number =>
  side === "left" || side === "right" ? 40 : 12;

/** Where a pane sits. The other axis of a pane, orthogonal to what fills it. */
export type Placement = "tiled" | "floating" | DockSide;

export interface Layout {
  version: typeof LAYOUT_VERSION;
  /** The tiled plane. Null for a window with nothing tiled — a real state
   *  during teardown, and while a float is all a window has. */
  root: LayoutNode | null;
  /** The floating plane, bottom to top. Usually empty. */
  floats: readonly LayoutFloat[];
  /** Ordered panes in the four fixed-cell edge strips. */
  docks?: DockStrips;
  /** User-adjusted strip thicknesses, in cells. */
  dockSizes?: Partial<Record<DockSide, number>>;
  /** PaneRef.id of the pane that had focus, if the layout still places it. */
  focus?: string;
}

let nextPaneId = 0;

/**
 * Mint a pane id.
 *
 * Here rather than next to TerminalPane because identity belongs to the model:
 * a pane in a headless daemon is a LayoutPane and nothing else, and it still
 * has to be nameable. The renderer borrows the id it is given as its own tree
 * id, so a pane has one identifier rather than a model id and a view id that
 * could drift.
 */
export function newPaneId(): string {
  return `pane-${nextPaneId++}`;
}

/** Keep the generator ahead of every id a decoded layout brought back, so a
 *  fresh pane can never collide with a persisted one. Called from parseNode,
 *  which is the one door layouts from outside this process come through. */
function reservePaneId(id: string) {
  const n = /^pane-(\d+)$/.exec(id);
  if (n) nextPaneId = Math.max(nextPaneId, Number(n[1]) + 1);
}

/** Every pane in the tree, left to right, depth first — the order `^a o` walks. */
export function layoutPanes(node: LayoutNode | null): LayoutPane[] {
  if (!node) return [];
  if (node.type === "pane") return [node];
  return node.children.flatMap(layoutPanes);
}

/**
 * Every pane the layout places, whichever plane it is in: tiled in walk order,
 * then floating bottom to top.
 *
 * Anything asking "does this layout have that pane" wants this rather than
 * layoutPanes — focus, pruning and the window's slot filling are all about
 * placement in general, and a float is placed.
 */
export function layoutRefs(layout: Layout): PaneRef[] {
  return [
    ...layoutPanes(layout.root),
    ...DOCK_SIDES.flatMap((side) => (layout.docks ?? emptyDockStrips())[side]),
    ...layout.floats,
  ];
}

/** Session ids the layout expects to exist, in pane order, dropping panes whose
 *  content has no session (a client-only plugin pane names none). */
export function layoutSessions(layout: Layout): string[] {
  return layoutRefs(layout).flatMap((pane) => {
    const session = paneSession(pane.content);
    return session === undefined ? [] : [session];
  });
}

/**
 * Assemble a layout, keeping the focus only if the result still places its pane.
 *
 * Every path that produces a Layout has to answer this, because every one of
 * them can drop the focused pane: collapsing, pruning dead agents, parsing
 * hand-written input, and reading a live window whose focus has moved. A focus
 * naming a pane that is not there would rebuild a window with nothing focused,
 * so it is dropped here rather than at four separate call sites.
 *
 * Takes the layout as an object so that a transform of one plane spreads the
 * other through — `makeLayout({ ...layout, root })` cannot forget the floats
 * the way a positional argument list silently would.
 *
 * Key order is fixed for the same reason encodeLayout is stable — two equal
 * layouts must serialize to equal strings.
 */
export function makeLayout({
  root,
  floats = [],
  docks,
  dockSizes,
  focus,
}: {
  root: LayoutNode | null;
  floats?: readonly LayoutFloat[];
  docks?: DockStrips;
  dockSizes?: Partial<Record<DockSide, number>>;
  focus?: string;
}): Layout {
  const sourceDocks = docks ?? emptyDockStrips();
  const normalizedDocks = {
    left: [...sourceDocks.left],
    right: [...sourceDocks.right],
    top: [...sourceDocks.top],
    bottom: [...sourceDocks.bottom],
  } as DockStrips;
  const placed = [
    ...layoutPanes(root),
    ...DOCK_SIDES.flatMap((side) => normalizedDocks[side]),
    ...floats,
  ];
  const present = focus !== undefined && placed.some((pane) => pane.id === focus);
  return present
    ? {
        version: LAYOUT_VERSION,
        root,
        floats,
        docks: docks ? normalizedDocks : undefined,
        dockSizes: dockSizes ? { ...dockSizes } : undefined,
        focus,
      }
    : {
        version: LAYOUT_VERSION,
        root,
        floats,
        docks: docks ? normalizedDocks : undefined,
        dockSizes: dockSizes ? { ...dockSizes } : undefined,
      };
}

/**
 * Drop the structure that carries no information.
 *
 * A split with one child is that child — it renders identically and only
 * differs in how many Boxes deep it sits. These arise legitimately: closing a
 * pane leaves its sibling alone in a split, and a decoded layout that kept the
 * husk would rebuild an extra nesting level that the live tree collapses away,
 * so a round trip would not be a fixed point.
 *
 * The collapsed child inherits the husk's weight, because the husk is what the
 * parent was sizing against.
 */
export function collapse(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "pane") return node;

  const children = node.children
    .map(collapse)
    .filter((child): child is LayoutNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return { ...children[0]!, weight: node.weight };

  // A child split along the same axis as its parent is flattened into it: the
  // live tree only nests when the axis alternates (see Window.split), so a
  // same-axis nesting is another shape that could never be rebuilt as written.
  const flattened = children.flatMap((child) =>
    child.type === "split" && child.direction === node.direction
      ? redistribute(child.children, child.weight)
      : [child],
  );

  return { ...node, children: flattened };
}

/** Scale a flattened split's children so they keep their share of the space the
 *  nested split used to occupy. */
function redistribute(children: LayoutNode[], weight: number): LayoutNode[] {
  const total = children.reduce((sum, child) => sum + child.weight, 0);
  if (total <= 0) return children;
  return children.map((child) => ({ ...child, weight: (child.weight / total) * weight }));
}

/**
 * Rewrite panes by their position in pane order.
 *
 * Position and not agent id: two panes can show the same agent — that is what
 * revealing an agent twice leaves behind, and what a layout with a repeated id
 * means — and only position tells them apart. Returning null from `fn` removes
 * that pane; the caller collapses whatever husk that leaves.
 *
 * A position no pane has is therefore not an error to raise but a rewrite that
 * never fires, which is what leaves an out-of-range edit as a no-op rather than
 * as a throw halfway through building a tree.
 */
function rewritePanes(
  root: LayoutNode | null,
  fn: (pane: LayoutPane, at: number) => LayoutNode | null,
): LayoutNode | null {
  let seen = 0;
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (node.type === "pane") return fn(node, seen++);
    const children = node.children.map(walk).filter((child): child is LayoutNode => child !== null);
    return children.length ? { ...node, children } : null;
  };
  return root ? walk(root) : null;
}

/**
 * Split the pane at `index`, putting `agent` in the new half.
 *
 * The arrangement as a *transformation of data* rather than surgery on a
 * renderable tree — Window.split does the same thing to Boxes and Dividers, and
 * this is the part of it that a headless process could do.
 *
 * The weights work out without a special case, which is the pleasant surprise
 * here. The pane becomes an even two-child split standing in its own slot, and
 * collapse() flattens that into a same-axis parent by scaling the children to
 * the space the husk occupied — so each half comes out at half the original
 * weight, which is exactly the "newcomer takes half" rule tmux follows and
 * Window.split used to write out by hand. Splitting a pane the user had dragged
 * to a weight of 69 gives two panes of 34.5, not a 69 against a fresh 1.
 *
 * Focus moves to the new pane, as it does in tmux — named by its own pane id,
 * so splitting to show an agent this window is already showing lands on the
 * newcomer rather than on the first pane that happens to share its agent.
 */
export function splitLayout(
  layout: Layout,
  index: number,
  direction: SplitDirection,
  pane: PaneRef,
): Layout {
  const root = rewritePanes(layout.root, (target, at) =>
    at !== index
      ? target
      : {
          type: "split",
          direction,
          weight: target.weight,
          children: [
            { ...target, weight: 1 },
            { type: "pane", ...pane, weight: 1 },
          ],
        },
  );
  return makeLayout({ ...layout, root: collapse(root), focus: pane.id });
}

/** Append a pane to the root row, preserving the existing slots and weights. */
export function appendPane(layout: Layout, ref: PaneRef): Layout {
  const pane: LayoutPane = { type: "pane", ...ref, weight: 1 };
  if (!layout.root) return makeLayout({ ...layout, root: pane, focus: ref.id });
  const root =
    layout.root.type === "split" && layout.root.direction === "row"
      ? { ...layout.root, children: [...layout.root.children, pane] }
      : {
          type: "split" as const,
          direction: "row" as const,
          weight: 1,
          children: [{ ...layout.root, weight: 1 }, pane],
        };
  return makeLayout({ ...layout, root, focus: ref.id });
}

/**
 * Exchange the panes in two slots.
 *
 * Slots keep their weights and the panes move between them, which is what
 * tmux's swap-pane does and what Window.swap arrived at the long way round: it
 * moved the renderables and then handed each the other's weight. A pane keeps
 * its identity through the move, so focus needs no adjusting — it still names
 * the pane the user was in, wherever that pane now sits.
 */
export function swapLayout(layout: Layout, from: number, to: number): Layout {
  const panes = layoutPanes(layout.root);
  const a = panes[from];
  const b = panes[to];
  if (!a || !b || from === to) return layout;
  const move = (pane: LayoutPane, into: LayoutPane): LayoutPane => ({
    ...pane,
    id: into.id,
    content: into.content,
  });
  const root = rewritePanes(layout.root, (pane, at) =>
    at === from ? move(pane, b) : at === to ? move(pane, a) : pane,
  );
  return makeLayout({ ...layout, root: collapse(root) });
}

/**
 * Take a pane out of the arrangement, whichever plane it was placed in.
 *
 * By id rather than by position, because position only orders the tiled plane —
 * a float has none, and every caller was looking the id up to get an index
 * anyway.
 *
 * Tiled survivors keep their relative proportions and grow into the freed
 * space, which is what tmux's layout_close_pane does — and here it needs no
 * arithmetic at all, because weights are relative to siblings. Two panes left
 * at 0.25 and 0.5 simply become a third and two thirds of the row. The one case
 * that WOULD have needed a fixup, a lone survivor stranded at its old half
 * share, is the one collapse() already handles by giving it the husk's weight.
 *
 * Focus moves to the tiled pane that took its place, or to the last one when
 * the closed pane was at the end — tmux's rule. Failing that it falls to
 * whatever the layout still places, topmost first, which is the only sensible
 * answer for a closed float and for a tiled pane whose window is now just a
 * float. Decided here rather than by the caller because after the collapse
 * there is no longer an index to count from, only pane ids.
 *
 * Closing the last pane leaves an empty layout. That is a real state, not an
 * error: a window with nothing in it is what the app closes.
 */
export function closeLayout(layout: Layout, paneId: string): Layout {
  const dockStrips = layout.docks ?? emptyDockStrips();
  const index = layoutPanes(layout.root).findIndex((pane) => pane.id === paneId);
  const floats = layout.floats.filter((float) => float.id !== paneId);
  const docks: DockStrips = {
    left: dockStrips.left.filter((pane) => pane.id !== paneId),
    right: dockStrips.right.filter((pane) => pane.id !== paneId),
    top: dockStrips.top.filter((pane) => pane.id !== paneId),
    bottom: dockStrips.bottom.filter((pane) => pane.id !== paneId),
  };
  const dockChanged = DOCK_SIDES.some((side) => docks[side].length !== dockStrips[side].length);
  if (index === -1 && floats.length === layout.floats.length && !dockChanged) return layout;

  const root =
    index === -1
      ? layout.root
      : collapse(rewritePanes(layout.root, (pane) => (pane.id === paneId ? null : pane)));
  const survivors = layoutPanes(root);
  const heir = index === -1 ? undefined : survivors[Math.min(index, survivors.length - 1)];
  const remaining = [...survivors, ...DOCK_SIDES.flatMap((side) => docks[side]), ...floats];
  const focus = layout.focus === paneId ? (heir ?? remaining.at(-1))?.id : layout.focus;
  return makeLayout({ ...layout, root, floats, docks, focus });
}

/** Which plane a layout places a pane in, or null if it does not place it. */
export function placementOf(layout: Layout, paneId: string): Placement | null {
  const dockStrips = layout.docks ?? emptyDockStrips();
  if (layout.floats.some((float) => float.id === paneId)) return "floating";
  for (const side of DOCK_SIDES)
    if (dockStrips[side].some((pane) => pane.id === paneId)) return side;
  return layoutPanes(layout.root).some((pane) => pane.id === paneId) ? "tiled" : null;
}

export function setDock(layout: Layout, paneId: string, side: DockSide): Layout {
  const dockStrips = layout.docks ?? emptyDockStrips();
  const current = placementOf(layout, paneId);
  if (current === null || current === side) return layout;
  const target = layoutRefs(layout).find((pane) => pane.id === paneId)!;
  const docks: DockStrips = {
    left: dockStrips.left.filter((pane) => pane.id !== paneId),
    right: dockStrips.right.filter((pane) => pane.id !== paneId),
    top: dockStrips.top.filter((pane) => pane.id !== paneId),
    bottom: dockStrips.bottom.filter((pane) => pane.id !== paneId),
  };
  const root =
    current === "tiled"
      ? collapse(rewritePanes(layout.root, (pane) => (pane.id === paneId ? null : pane)))
      : layout.root;
  const floats =
    current === "floating" ? layout.floats.filter((float) => float.id !== paneId) : layout.floats;
  const nextDocks = {
    ...docks,
    [side]: [...docks[side], { id: target.id, content: target.content }],
  } as DockStrips;
  return makeLayout({ ...layout, root, floats, docks: nextDocks, focus: paneId });
}

export function undockPane(layout: Layout, paneId: string): Layout {
  const dockStrips = layout.docks ?? emptyDockStrips();
  const side = DOCK_SIDES.find((candidate) =>
    dockStrips[candidate].some((pane) => pane.id === paneId),
  );
  if (!side) return layout;
  const target = dockStrips[side].find((pane) => pane.id === paneId)!;
  const docks = {
    ...dockStrips,
    [side]: dockStrips[side].filter((pane) => pane.id !== paneId),
  } as DockStrips;
  return appendPane(makeLayout({ ...layout, docks }), target);
}

/**
 * A new float's rectangle: centred, two thirds of the window each way.
 *
 * The default a pane is first floated with, when nothing has said where it
 * should sit. It is one constant rather than an argument because every caller
 * means the same thing by "just float it" — and it is not a rule, because the
 * transforms that move and resize a float (geometry.ts) and a decoded layout
 * each carry their own rect.
 */
const NEW_FLOAT = { x: 1 / 6, y: 1 / 6, width: 2 / 3, height: 2 / 3 };

/**
 * Move a pane between the tiled and floating planes.
 *
 * The tiled half is exactly closeLayout's removal, and the floating half is
 * exactly appendPane's insertion, because a pane leaving a plane is a pane
 * leaving a plane no matter where it goes next. What is NOT shared is focus:
 * changing a pane's placement never moves the focus off it, so the pane comes
 * out of one plane and into the other still focused, unlike a close.
 *
 * A pane the layout does not place, or one already in the plane asked for, is
 * left alone — this is a statement about where a pane is, so both are already
 * true.
 */
export function setPlacement(layout: Layout, paneId: string, placement: Placement): Layout {
  const current = placementOf(layout, paneId);
  if (current === null || current === placement) return layout;

  if (placement === "floating") {
    const target = layoutPanes(layout.root).find((pane) => pane.id === paneId)!;
    const root = collapse(rewritePanes(layout.root, (pane) => (pane.id === paneId ? null : pane)));
    const float: LayoutFloat = { id: target.id, content: target.content, ...NEW_FLOAT };
    // Onto the end: the newly floated pane is the one the user is looking at,
    // and the end of the list is the top of the stack.
    return makeLayout({ ...layout, root, floats: [...layout.floats, float], focus: paneId });
  }

  const target = layout.floats.find((float) => float.id === paneId)!;
  const without = makeLayout({
    ...layout,
    floats: layout.floats.filter((float) => float.id !== paneId),
  });
  return appendPane(without, { id: target.id, content: target.content });
}

/**
 * Remove panes whose agent is gone, keeping the rest of the shape.
 *
 * Restore has to cope with a layout outliving its processes: a session saved
 * with four agents may come back with two that still exist. Dropping the dead
 * leaves and collapsing what is left preserves the arrangement of the
 * survivors, which is much closer to what the user had than starting over.
 */
export function prune(layout: Layout, alive: (session: string) => boolean): Layout {
  const dockStrips = layout.docks ?? emptyDockStrips();
  const filter = (node: LayoutNode): LayoutNode | null => {
    if (node.type === "pane") {
      const session = paneSession(node.content);
      // A sessionless pane (client-only plugin) has nothing to outlive and is
      // never pruned: it does not depend on a process to exist.
      return session === undefined || alive(session) ? node : null;
    }
    const children = node.children
      .map(filter)
      .filter((child): child is LayoutNode => child !== null);
    return children.length ? { ...node, children } : null;
  };

  const root = layout.root ? collapse(filter(layout.root)) : null;
  return makeLayout({
    ...layout,
    root,
    floats: layout.floats.filter((float) => {
      const session = paneSession(float.content);
      return session === undefined || alive(session);
    }),
    docks: {
      left: dockStrips.left.filter((pane) => {
        const session = paneSession(pane.content);
        return session === undefined || alive(session);
      }),
      right: dockStrips.right.filter((pane) => {
        const session = paneSession(pane.content);
        return session === undefined || alive(session);
      }),
      top: dockStrips.top.filter((pane) => {
        const session = paneSession(pane.content);
        return session === undefined || alive(session);
      }),
      bottom: dockStrips.bottom.filter((pane) => {
        const session = paneSession(pane.content);
        return session === undefined || alive(session);
      }),
    },
  });
}

/**
 * The named arrangements tmux's select-layout offers, in its cycle order.
 *
 * A preset discards the current shape and rebuilds it from the pane *list*,
 * which is why it lives here rather than on Window: it is a function from
 * agents to a tree, and needs nothing from the renderer.
 */
export const LAYOUT_PRESETS = [
  "even-horizontal",
  "even-vertical",
  "main-horizontal",
  "main-vertical",
  "tiled",
] as const;

export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];

const LayoutPresetSchema = S.Literal(...LAYOUT_PRESETS);
export function isLayoutPreset(value: string | null): value is LayoutPreset {
  return S.is(LayoutPresetSchema)(value);
}

/**
 * A window filled by one pane, and the arrangement to return to.
 *
 * Zoom used to be three fields of parked renderables — the pane, the slot it
 * was lifted out of, and the tree hung off to one side — because the tree was
 * the only place the arrangement existed, so preserving it meant keeping it
 * alive somewhere off-screen.
 *
 * It can be data instead, and exactly because of what a zoom does to the
 * screen: a zoomed window mounts one pane and NO DIVIDERS, and a drag is the
 * only thing that reshapes a tree behind the model's back. So nothing can
 * change the arrangement while a zoom is in effect, and the layout captured
 * when it started is still exact when it ends — not an approximation of the
 * tree, but the same answer the tree would have given.
 */
export interface Zoom {
  /** PaneRef.id of the pane filling the window. */
  pane: string;
  /** The arrangement to return to, captured when the zoom started. */
  from: Layout;
}

/**
 * A window's state apart from its arrangement.
 *
 * Everything here is either a pane ID or a flag, so a window in a process with
 * no renderer can hold all of it — which is the point. Focus and last-pane were
 * renderable references, and a reference cannot be stored, sent, or held by a
 * daemon; naming a pane by its id also makes a DANGLING one unrepresentable,
 * since an id that no pane answers to simply resolves to nothing. That replaces
 * the rule that every rebuild had to remember to clear a stale last-pane.
 *
 * It lives here rather than on Window for the same reason LayoutPreset does:
 * none of it needs the renderer.
 */
export interface WindowState {
  /** PaneRef.id of the focused pane. */
  focus: string | null;
  /** PaneRef.id of the pane focused before it — tmux's last-pane. */
  last: string | null;
  zoom: Zoom | null;
  /** Whether ordinary child input is replicated to every pane — tmux's
   *  synchronize-panes. A transient interactive mode, shown in the tab, never
   *  persisted or configured. */
  sync: boolean;
  /** The named layout this window currently matches, cleared by anything that
   *  reshapes or resizes the tree. Drives next-layout's cycle. */
  preset: LayoutPreset | null;
}

export function windowState(): WindowState {
  return { focus: null, last: null, zoom: null, sync: false, preset: null };
}

/** tmux's next-layout: step through the presets, starting the cycle over from
 *  a window whose layout was built by hand and matches no preset. */
export function nextPreset(current: LayoutPreset | null): LayoutPreset {
  const i = current ? LAYOUT_PRESETS.indexOf(current) : -1;
  return LAYOUT_PRESETS[(i + 1) % LAYOUT_PRESETS.length]!;
}

const pane = (ref: PaneRef, weight = 1): LayoutPane => ({ type: "pane", ...ref, weight });

const split = (direction: SplitDirection, children: LayoutNode[], weight = 1): LayoutNode =>
  children.length === 1
    ? { ...children[0]!, weight }
    : { type: "split", direction, weight, children };

/**
 * Build one of the named layouts over a list of panes.
 *
 * Panes keep their given order, so cycling layouts rearranges the same panes
 * rather than shuffling them — the property that makes next-layout usable at
 * all. Sizes come out even: a preset is a deliberate discard of hand-tuned
 * weights, which is the point of asking for one.
 *
 * Everything is passed through collapse(), so degenerate cases (one pane, a
 * main layout with nothing beside the main pane, a single-row tiling) come back
 * as the flat tree the live window would actually build.
 *
 * It arranges the tiled plane and takes no floats, because a preset is a shape
 * for panes that are sized against each other and a float is not one. A caller
 * holding floats keeps them: `makeLayout({ ...presetLayout(...), floats })`.
 */
export function presetLayout(
  panes: readonly PaneRef[],
  preset: LayoutPreset,
  focus?: string,
): Layout {
  if (panes.length === 0) return makeLayout({ root: null });
  const [first, ...rest] = panes as [PaneRef, ...PaneRef[]];

  const build = (): LayoutNode => {
    switch (preset) {
      case "even-horizontal":
        return split(
          "row",
          panes.map((ref) => pane(ref)),
        );
      case "even-vertical":
        return split(
          "column",
          panes.map((ref) => pane(ref)),
        );
      // The main pane takes half; tmux sizes it in cells, which we cannot do
      // here because a layout is resolution-independent.
      case "main-horizontal":
        return split("column", [
          pane(first),
          split(
            "row",
            rest.map((r) => pane(r)),
          ),
        ]);
      case "main-vertical":
        return split("row", [
          pane(first),
          split(
            "column",
            rest.map((r) => pane(r)),
          ),
        ]);
      case "tiled":
        return tiled(panes);
    }
  };

  return makeLayout({ root: collapse(rest.length === 0 ? pane(first) : build()), focus });
}

/** A grid as square as the count allows, filled row by row — tmux layout-set.c,
 *  where a short final row simply spreads across the full width. */
function tiled(panes: readonly PaneRef[]): LayoutNode {
  let columns = Math.floor(Math.sqrt(panes.length));
  if (columns * columns < panes.length) columns++;
  const rows: LayoutNode[] = [];
  for (let i = 0; i < panes.length; i += columns) {
    rows.push(
      split(
        "row",
        panes.slice(i, i + columns).map((ref) => pane(ref)),
      ),
    );
  }
  return split("column", rows);
}

export class LayoutFormatError extends S.TaggedError<LayoutFormatError>()("LayoutFormatError", {
  message: S.String,
}) {}

const paneId = S.String.pipe(S.minLength(1)).annotations({ message: () => "pane needs a pane id" });
const sessionId = S.String.pipe(S.minLength(1)).annotations({
  message: () => "content needs a session id",
});
// A plugin pane's descriptor is opaque JSON the plugin validates; layout only
// carries it. Bounded by ts-a4e25e, which also defines what a pane type may put
// in it — here a value has to be JSON-shaped, and S.Unknown admits it.
export const PaneContentSchema: S.Schema<PaneContent> = S.Union(
  S.Struct({
    kind: S.Literal("pty"),
    session: S.propertySignature(sessionId).annotations({
      missingMessage: () => "pty content needs a session id",
    }),
  }),
  S.Struct({
    kind: S.Literal("plugin"),
    type: S.propertySignature(S.String.pipe(S.minLength(1))).annotations({
      missingMessage: () => "plugin content needs a pane type",
    }),
    descriptor: S.propertySignature(S.Unknown).annotations({
      missingMessage: () => "plugin content needs a descriptor",
    }),
    session: S.optional(sessionId),
  }),
) as S.Schema<PaneContent>;
const weight = S.Number.pipe(
  S.finite(),
  S.positive({ message: () => "weight must be a positive number" }),
);
const origin = S.Number.pipe(S.finite(), S.greaterThanOrEqualTo(0), S.lessThan(1)).annotations({
  message: () => "must be a fraction of the window",
});
const size = S.Number.pipe(
  S.finite(),
  S.positive({ message: () => "must be a fraction of the window" }),
  S.lessThanOrEqualTo(1, { message: () => "must be a fraction of the window" }),
);

const LayoutPaneSchema = S.Struct({
  type: S.Literal("pane"),
  content: S.propertySignature(PaneContentSchema).annotations({
    missingMessage: () => "pane needs content",
  }),
  id: S.propertySignature(paneId).annotations({ missingMessage: () => "pane needs a pane id" }),
  weight: S.optionalWith(weight, { default: () => 1 }),
});

// The recursive schema's array is readonly and its optional field encoding does
// not match the mutable, defaulted public node model, so the boundary cast is
// required to use the decoded value as LayoutNode.
const LayoutNodeSchema = S.Union(
  LayoutPaneSchema,
  S.Struct({
    type: S.Literal("split"),
    direction: S.Literal("row", "column").annotations({
      message: () => 'split needs direction "row" or "column"',
    }),
    weight: S.optionalWith(weight, { default: () => 1 }),
    children: S.Array(S.suspend((): S.Schema<LayoutNode> => LayoutNodeSchema))
      .pipe(S.minItems(1))
      .annotations({ message: () => "split needs children" }),
  }),
) as S.Schema<LayoutNode>;

const LayoutSchema = S.Struct({
  version: S.Number,
  root: S.optional(S.NullOr(LayoutNodeSchema)),
  floats: S.optional(
    S.Array(
      S.Struct({
        id: S.propertySignature(paneId).annotations({
          missingMessage: () => "float needs a pane id",
        }),
        content: S.propertySignature(PaneContentSchema).annotations({
          missingMessage: () => "float needs content",
        }),
        x: origin,
        y: origin,
        width: size,
        height: size,
      }),
    ),
  ),
  docks: S.optional(
    S.Struct({
      left: S.optional(
        S.Array(
          S.Struct({
            id: S.propertySignature(paneId),
            content: S.propertySignature(PaneContentSchema),
          }),
        ),
      ),
      right: S.optional(
        S.Array(
          S.Struct({
            id: S.propertySignature(paneId),
            content: S.propertySignature(PaneContentSchema),
          }),
        ),
      ),
      top: S.optional(
        S.Array(
          S.Struct({
            id: S.propertySignature(paneId),
            content: S.propertySignature(PaneContentSchema),
          }),
        ),
      ),
      bottom: S.optional(
        S.Array(
          S.Struct({
            id: S.propertySignature(paneId),
            content: S.propertySignature(PaneContentSchema),
          }),
        ),
      ),
    }),
  ),
  dockSizes: S.optional(
    S.Struct({
      left: S.optional(S.Int.pipe(S.greaterThan(1))),
      right: S.optional(S.Int.pipe(S.greaterThan(1))),
      top: S.optional(S.Int.pipe(S.greaterThan(1))),
      bottom: S.optional(S.Int.pipe(S.greaterThan(1))),
    }),
  ),
  focus: S.optional(paneId),
});

/** Serialize for session.json or the wire. Stable key order, so two equal
 *  layouts encode to equal strings and a diff of session.json stays readable. */
export function encodeLayout(layout: Layout): string {
  const normalized = makeLayout({ ...layout, root: collapse(layout.root) });
  const docks = normalized.docks ?? emptyDockStrips();
  const encodedDocks = Object.fromEntries(
    DOCK_SIDES.map((side) => [
      side,
      docks[side].map((pane) => ({ id: pane.id, content: pane.content })),
    ]),
  );
  const encoded = {
    ...normalized,
    root: order(normalized.root),
    floats: normalized.floats.map(orderFloat),
  };
  if (DOCK_SIDES.some((side) => docks[side].length > 0)) {
    Object.assign(encoded, { docks: encodedDocks });
  }
  return JSON.stringify(encoded);
}

function orderFloat(float: LayoutFloat): LayoutFloat {
  return {
    id: float.id,
    content: float.content,
    x: float.x,
    y: float.y,
    width: float.width,
    height: float.height,
  };
}

function order(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "pane") {
    return { type: "pane", id: node.id, content: node.content, weight: node.weight };
  }
  return {
    type: "split",
    direction: node.direction,
    weight: node.weight,
    children: node.children.map(order) as LayoutNode[],
  };
}

/**
 * Parse a layout, rejecting anything that would not rebuild.
 *
 * Hand-edited and cross-version input reaches this directly, and a malformed
 * layout must fail as a value rather than by throwing halfway through mutating
 * a live window — by the time applyLayout runs, the old tree is already gone.
 */
export function decodeLayout(text: string): Effect.Effect<Layout, LayoutFormatError> {
  if (Buffer.byteLength(text) > MAX_LAYOUT_BYTES)
    return Effect.fail(new LayoutFormatError({ message: "layout is too large" }));
  return S.decodeUnknown(S.parseJson(S.Unknown) as S.Schema<unknown, string, never>)(text).pipe(
    Effect.mapError((error) => new LayoutFormatError({ message: `layout is not JSON: ${error}` })),
    Effect.flatMap(parseLayout),
  );
}

export function parseLayout(value: unknown): Effect.Effect<Layout, LayoutFormatError> {
  return S.decodeUnknown(LayoutSchema)(value).pipe(
    Effect.mapError((error) => new LayoutFormatError({ message: formatSchemaError(error) })),
    Effect.flatMap(validateDecodedLayout),
  );
}

function formatSchemaError(error: ParseResult.ParseError): string {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  // Prefer the deepest issue; at equal depth, a missing field is more specific than a type error.
  const issue = [...issues].sort(
    (left, right) => right.path.length - left.path.length || (left._tag === "Missing" ? -1 : 1),
  )[0];
  if (!issue) return "layout is invalid";
  if (issue.path.at(-1) === "type") {
    return `${formatPath(issue.path.slice(0, -1))} has unknown type`;
  }
  const path = formatPath(issue.path);
  return path ? `${path} ${issue.message}` : issue.message;
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : index === 0 ? String(part) : `.${String(part)}`,
    )
    .join("");
}

function validateDecodedLayout(
  decoded: S.Schema.Type<typeof LayoutSchema>,
): Effect.Effect<Layout, LayoutFormatError> {
  return Effect.gen(function* () {
    if (decoded.version !== LAYOUT_VERSION)
      return yield* new LayoutFormatError({
        message: `unsupported layout version ${String(decoded.version)}`,
      });
    let nodes = 0;
    const visit = (node: LayoutNode, depth: number): Effect.Effect<void, LayoutFormatError> => {
      if (depth > MAX_LAYOUT_DEPTH)
        return Effect.fail(
          new LayoutFormatError({ message: `layout exceeds maximum depth ${MAX_LAYOUT_DEPTH}` }),
        );
      if (++nodes > MAX_LAYOUT_NODES)
        return Effect.fail(
          new LayoutFormatError({
            message: `layout exceeds maximum node count ${MAX_LAYOUT_NODES}`,
          }),
        );
      if (node.type === "pane") reservePaneId(node.id);
      return node.type === "split"
        ? Effect.forEach(node.children, (child) => visit(child, depth + 1)).pipe(Effect.asVoid)
        : Effect.void;
    };
    const root = decoded.root ?? null;
    if (root) yield* visit(root, 1);
    const floats = decoded.floats ?? [];
    for (const float of floats) {
      if (++nodes > MAX_LAYOUT_NODES)
        return yield* new LayoutFormatError({
          message: `layout exceeds maximum node count ${MAX_LAYOUT_NODES}`,
        });
      reservePaneId(float.id);
    }
    const rawDocks = decoded.docks ?? {};
    const docks = Object.fromEntries(
      DOCK_SIDES.map((side) => [side, rawDocks[side] ?? []]),
    ) as DockStrips;
    for (const side of DOCK_SIDES) for (const pane of docks[side]) reservePaneId(pane.id);
    return makeLayout({
      root: collapse(root),
      floats,
      docks: decoded.docks !== undefined ? docks : undefined,
      dockSizes: decoded.dockSizes,
      focus: decoded.focus,
    });
  });
}
