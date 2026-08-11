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

import { Effect, Schema as S } from "effect";
import type { SplitDirection } from "./window.ts";
import { MAX_LAYOUT_BYTES, MAX_LAYOUT_DEPTH, MAX_LAYOUT_NODES } from "./limits.ts";

/** The format written into session.json and any exported string. */
export const LAYOUT_VERSION = 1;

export type LayoutNode = LayoutPane | LayoutSplit;

/**
 * A pane's identity, and what it is a viewport onto.
 *
 * Two panes can show the same agent — that is what revealing an agent twice
 * leaves behind — so an agent id cannot name a pane, and a layout that had only
 * agent ids could not say which of the two had focus, or which one a command
 * meant. The pane id is the missing half: `agent` says what you are looking at,
 * `id` says which viewport you are looking through.
 *
 * Ids are unique across the whole process rather than within a window, because
 * break-pane moves a pane between windows and its identity has to survive that.
 * They are what a control API targets, the way tmux addresses panes by `%3`.
 */
export interface PaneRef {
  id: string;
  /** Agent.id. */
  agent: string;
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

/** Where a pane sits. The other axis of a pane, orthogonal to what fills it. */
export type Placement = "tiled" | "floating";

export interface Layout {
  version: typeof LAYOUT_VERSION;
  /** The tiled plane. Null for a window with nothing tiled — a real state
   *  during teardown, and while a float is all a window has. */
  root: LayoutNode | null;
  /** The floating plane, bottom to top. Usually empty. */
  floats: readonly LayoutFloat[];
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
  return [...layoutPanes(layout.root), ...layout.floats];
}

/** Agent ids the layout expects to exist, in pane order. */
export function layoutAgents(layout: Layout): string[] {
  return layoutRefs(layout).map((pane) => pane.agent);
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
  focus,
}: {
  root: LayoutNode | null;
  floats?: readonly LayoutFloat[];
  focus?: string;
}): Layout {
  const placed = [...layoutPanes(root), ...floats];
  const present = focus !== undefined && placed.some((pane) => pane.id === focus);
  return present
    ? { version: LAYOUT_VERSION, root, floats, focus }
    : { version: LAYOUT_VERSION, root, floats };
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
    agent: into.agent,
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
  const index = layoutPanes(layout.root).findIndex((pane) => pane.id === paneId);
  const floats = layout.floats.filter((float) => float.id !== paneId);
  if (index === -1 && floats.length === layout.floats.length) return layout;

  const root =
    index === -1
      ? layout.root
      : collapse(rewritePanes(layout.root, (pane) => (pane.id === paneId ? null : pane)));
  const survivors = layoutPanes(root);
  const heir = index === -1 ? undefined : survivors[Math.min(index, survivors.length - 1)];
  const remaining = [...survivors, ...floats];
  const focus = layout.focus === paneId ? (heir ?? remaining.at(-1))?.id : layout.focus;
  return makeLayout({ ...layout, root, floats, focus });
}

/** Which plane a layout places a pane in, or null if it does not place it. */
export function placementOf(layout: Layout, paneId: string): Placement | null {
  if (layout.floats.some((float) => float.id === paneId)) return "floating";
  return layoutPanes(layout.root).some((pane) => pane.id === paneId) ? "tiled" : null;
}

/**
 * A new float's rectangle: centred, two thirds of the window each way.
 *
 * One constant rather than an argument because nothing yet has an opinion —
 * moving and resizing a float is its own gesture, and until that exists every
 * float would be handed the same numbers by every caller.
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
    const float: LayoutFloat = { id: target.id, agent: target.agent, ...NEW_FLOAT };
    // Onto the end: the newly floated pane is the one the user is looking at,
    // and the end of the list is the top of the stack.
    return makeLayout({ ...layout, root, floats: [...layout.floats, float], focus: paneId });
  }

  const target = layout.floats.find((float) => float.id === paneId)!;
  const without = makeLayout({
    ...layout,
    floats: layout.floats.filter((float) => float.id !== paneId),
  });
  return appendPane(without, { id: target.id, agent: target.agent });
}

/**
 * Remove panes whose agent is gone, keeping the rest of the shape.
 *
 * Restore has to cope with a layout outliving its processes: a session saved
 * with four agents may come back with two that still exist. Dropping the dead
 * leaves and collapsing what is left preserves the arrangement of the
 * survivors, which is much closer to what the user had than starting over.
 */
export function prune(layout: Layout, alive: (agent: string) => boolean): Layout {
  const filter = (node: LayoutNode): LayoutNode | null => {
    if (node.type === "pane") return alive(node.agent) ? node : null;
    const children = node.children
      .map(filter)
      .filter((child): child is LayoutNode => child !== null);
    return children.length ? { ...node, children } : null;
  };

  const root = layout.root ? collapse(filter(layout.root)) : null;
  return makeLayout({
    ...layout,
    root,
    floats: layout.floats.filter((float) => alive(float.agent)),
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

export function isLayoutPreset(value: unknown): value is LayoutPreset {
  return typeof value === "string" && (LAYOUT_PRESETS as readonly string[]).includes(value);
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

/** Serialize for session.json or the wire. Stable key order, so two equal
 *  layouts encode to equal strings and a diff of session.json stays readable. */
export function encodeLayout(layout: Layout): string {
  const normalized = makeLayout({ ...layout, root: collapse(layout.root) });
  return JSON.stringify({
    ...normalized,
    root: order(normalized.root),
    floats: normalized.floats.map(orderFloat),
  });
}

function orderFloat(float: LayoutFloat): LayoutFloat {
  return {
    id: float.id,
    agent: float.agent,
    x: float.x,
    y: float.y,
    width: float.width,
    height: float.height,
  };
}

function order(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "pane") {
    return { type: "pane", id: node.id, agent: node.agent, weight: node.weight };
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
  return Effect.try({
    try: () => JSON.parse(text),
    catch: (error) =>
      new LayoutFormatError({ message: `layout is not JSON: ${(error as Error).message}` }),
  }).pipe(Effect.flatMap((parsed) => parseLayout(parsed)));
}

export function parseLayout(value: unknown): Effect.Effect<Layout, LayoutFormatError> {
  return Effect.gen(function* () {
    if (!value || typeof value !== "object")
      return yield* new LayoutFormatError({ message: "layout must be an object" });
    const raw = value as Partial<Layout>;
    if (raw.version !== LAYOUT_VERSION) {
      return yield* new LayoutFormatError({
        message: `unsupported layout version ${String(raw.version)}`,
      });
    }
    const budget = { nodes: 0 };
    const root =
      raw.root === null || raw.root === undefined
        ? null
        : yield* parseNode(raw.root, "root", 1, budget);
    if (raw.focus !== undefined && typeof raw.focus !== "string") {
      return yield* new LayoutFormatError({ message: "focus must be a pane id" });
    }
    // Absent means no floats rather than a malformed layout: every layout
    // written before floats existed says nothing about them, and "nothing
    // floats" is what those layouts meant.
    if (raw.floats !== undefined && !Array.isArray(raw.floats)) {
      return yield* new LayoutFormatError({ message: "floats must be an array" });
    }
    const floats: LayoutFloat[] = [];
    for (const [at, value] of (raw.floats ?? []).entries()) {
      floats.push(yield* parseFloat(value, `floats[${at}]`, budget));
    }
    return makeLayout({ root: collapse(root), floats, focus: raw.focus });
  });
}

/** A float counts against the same node budget as a tiled pane: it is a pane,
 *  and the budget is about how much a layout can ask the window to build. */
function parseFloat(
  value: unknown,
  at: string,
  budget: { nodes: number },
): Effect.Effect<LayoutFloat, LayoutFormatError> {
  return Effect.gen(function* () {
    if (++budget.nodes > MAX_LAYOUT_NODES)
      return yield* new LayoutFormatError({
        message: `layout exceeds maximum node count ${MAX_LAYOUT_NODES}`,
      });
    if (!value || typeof value !== "object")
      return yield* new LayoutFormatError({ message: `${at} must be an object` });
    const raw = value as Record<string, unknown>;
    if (typeof raw.agent !== "string" || !raw.agent)
      return yield* new LayoutFormatError({ message: `${at} float needs an agent id` });
    if (typeof raw.id !== "string" || !raw.id)
      return yield* new LayoutFormatError({ message: `${at} float needs a pane id` });
    reservePaneId(raw.id);

    // Fractions of the window. An origin outside it or a size of zero would
    // rebuild as a pane nobody can see or reach, which is the class of layout
    // this function exists to refuse.
    const fraction = (key: "x" | "y" | "width" | "height") =>
      Effect.gen(function* () {
        const n = raw[key];
        if (typeof n !== "number" || !Number.isFinite(n))
          return yield* new LayoutFormatError({ message: `${at} ${key} must be a number` });
        const size = key === "width" || key === "height";
        if (size ? n <= 0 || n > 1 : n < 0 || n >= 1)
          return yield* new LayoutFormatError({
            message: `${at} ${key} must be a fraction of the window`,
          });
        return n;
      });

    return {
      id: raw.id,
      agent: raw.agent,
      x: yield* fraction("x"),
      y: yield* fraction("y"),
      width: yield* fraction("width"),
      height: yield* fraction("height"),
    };
  });
}

function parseNode(
  value: unknown,
  at: string,
  depth: number,
  budget: { nodes: number },
): Effect.Effect<LayoutNode, LayoutFormatError> {
  return Effect.gen(function* () {
    if (depth > MAX_LAYOUT_DEPTH)
      return yield* new LayoutFormatError({
        message: `layout exceeds maximum depth ${MAX_LAYOUT_DEPTH}`,
      });
    if (++budget.nodes > MAX_LAYOUT_NODES)
      return yield* new LayoutFormatError({
        message: `layout exceeds maximum node count ${MAX_LAYOUT_NODES}`,
      });
    if (!value || typeof value !== "object")
      return yield* new LayoutFormatError({ message: `${at} must be an object` });
    const raw = value as Record<string, unknown>;
    const weight = yield* parseWeight(raw.weight, at);

    if (raw.type === "pane") {
      if (typeof raw.agent !== "string" || !raw.agent) {
        return yield* new LayoutFormatError({ message: `${at} pane needs an agent id` });
      }
      if (typeof raw.id !== "string" || !raw.id) {
        return yield* new LayoutFormatError({ message: `${at} pane needs a pane id` });
      }
      reservePaneId(raw.id);
      return { type: "pane", id: raw.id, agent: raw.agent, weight };
    }

    if (raw.type === "split") {
      if (raw.direction !== "row" && raw.direction !== "column") {
        return yield* new LayoutFormatError({
          message: `${at} split needs direction "row" or "column"`,
        });
      }
      if (!Array.isArray(raw.children) || raw.children.length === 0) {
        return yield* new LayoutFormatError({ message: `${at} split needs children` });
      }
      const children = yield* Effect.all(
        raw.children.map((child, i) => parseNode(child, `${at}.children[${i}]`, depth + 1, budget)),
      );
      return { type: "split", direction: raw.direction, weight, children };
    }

    return yield* new LayoutFormatError({
      message: `${at} has unknown type ${JSON.stringify(raw.type)}`,
    });
  });
}

/** Weights are relative, so any positive finite number is meaningful; a
 *  non-positive one would render as a zero-width pane and is refused. */
function parseWeight(value: unknown, at: string): Effect.Effect<number, LayoutFormatError> {
  if (value === undefined) return Effect.succeed(1);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Effect.fail(
      new LayoutFormatError({ message: `${at} weight must be a positive number` }),
    );
  }
  return Effect.succeed(value);
}
