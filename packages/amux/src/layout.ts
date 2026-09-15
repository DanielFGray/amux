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

import { Effect, Match, Option, Schema as S, SchemaIssue } from "effect";
import type { SplitDirection } from "./window.ts";
import {
  PaneAgentSessionSnapshotSchema,
  persistedAgentSessionFromSnapshot,
  type PaneAgentSessionSnapshot,
} from "./agent-session.ts";
import {
  MAX_DESCRIPTOR_BYTES,
  MAX_LAYOUT_BYTES,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_NODES,
} from "./limits.ts";

/** The format written into session.json and any exported string. */
export const LAYOUT_VERSION = 1;

export type LayoutNode = LayoutPane | LayoutSplit | LayoutContainer;

/**
 * Opaque JSON owned by a registration, held as text. Core never looks inside.
 * Field schemas use this so save files and frames still nest real JSON
 * (`S.flip`); only the owner decodes with `S.fromJsonString(ownerSchema)`.
 * Precedent: plugin-lsp `LspJsonText` (9888955).
 */
export const OwnerJsonText = S.flip(S.fromJsonString(S.Unknown));
export type OwnerJsonText = typeof OwnerJsonText.Type;

/** Byte-length bound shared by Type-side text and the flipped field schema. */
const descriptorWithinLimit = S.makeFilter(
  (value: string) =>
    Buffer.byteLength(value) <= MAX_DESCRIPTOR_BYTES ||
    `descriptor exceeds the ${MAX_DESCRIPTOR_BYTES}-byte limit`,
);

/**
 * Type-side bounds for descriptor JSON text that is already encoded
 * (encodeOwner / in-process changes). Does not flip — input is the text.
 * Needed so a Type-side string is not run through {@link OwnerJsonText}
 * decode (Encoded→Type), which would treat the text as nested JSON and
 * stringify it again.
 */
export const DescriptorTextSchema = S.String.pipe(S.check(descriptorWithinLimit));

/**
 * A plugin pane's descriptor field schema: nests as real JSON in parents;
 * Type is sized JSON text.
 */
export const DescriptorSchema = OwnerJsonText.pipe(S.check(descriptorWithinLimit));
export type Descriptor = typeof DescriptorSchema.Type;

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
      readonly descriptor: OwnerJsonText;
      readonly session?: string;
      /**
       * Session that occupied this leaf before a replace-in-place open.
       * Keeps that backend alive while the plugin view owns the pane; closing
       * the plugin (or session.reveal) restores it. Not a viewport — see
       * `paneSession`.
       */
      readonly displaced?: string;
    };

/** The session a pane's content views, if its content has one. */
export function paneSession(content: PaneContent): string | undefined {
  return content.kind === "pty" ? content.session : content.session;
}

/**
 * Sessions this pane keeps alive: the one it views, plus a displaced
 * backend held off-layout by a replace-in-place plugin open.
 */
export function paneRetainedSessions(content: PaneContent): readonly string[] {
  const session = paneSession(content);
  const displaced = content.kind === "plugin" ? content.displaced : undefined;
  if (session !== undefined && displaced !== undefined && session !== displaced)
    return [session, displaced];
  if (session !== undefined) return [session];
  if (displaced !== undefined) return [displaced];
  return [];
}

/**
 * The registered plugin view key for a component session's pane —
 * `provider` names the session view a plugin registered (see
 * `SessionViewsTag.register`), the only key that ever resolves to anything.
 * `declaredAgent` is read only as a fallback for a session persisted before
 * `provider` existed; a session written by today's `addSession` always has
 * `provider` set, so that branch never fires on new data. `"component"` is a
 * terminal default with no registered view, rendered as a blank placeholder.
 */
export function componentViewType(session: {
  readonly provider?: string;
  readonly declaredAgent?: string | null;
}): string {
  return session.provider ?? session.declaredAgent ?? "component";
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
  /**
   * Trusted foreign-agent conversation ref for crash resume (ep-c96a99).
   * Follows the pane across windows/spaces; re-validated on decode.
   */
  agentSession?: PaneAgentSessionSnapshot;
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
 * An arrangement core does not know the meaning of — a container whose
 * sizing/positioning model is owned entirely by whichever plugin registered
 * `kind` (see docs/adr/0004-arrangement-kind-is-an-open-registry.md). A
 * niri-style scrolling column strip is one instance of this, defined and
 * registered by plugin-niri; core has no scrolling/viewport/offset concept
 * anywhere in this file.
 *
 * `weight` plays the same role it does on `LayoutPane`/`LayoutSplit`: this
 * node's own share of space within *its* parent. `children` is a plain
 * `LayoutNode` array — core's generic traversal (pane collection, node/depth
 * budgets, collapse) walks it without needing to know what `kind` means.
 * Anything the kind needs beyond plain children (niri's per-column size,
 * its scroll offset) lives inside `arrangement`, an opaque JSON-shaped value
 * only the owning plugin's registered schema and renderer interpret.
 */
export interface LayoutContainer {
  type: "container";
  kind: string;
  weight: number;
  children: readonly LayoutNode[];
  arrangement: unknown;
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
  /** The tiling algorithm that produced this layout (ts-b3df09), purely
   *  informational: ADR 0003's tree shape already carries full arrangement
   *  fidelity (including niri's "scroll" node), so nothing reads this to
   *  decide how to interpret `root`. */
  algorithmId?: string;
  algorithmVersion?: number;
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

/** Session ids the layout needs to keep alive, in pane order.
 *
 * Includes a replace-host's displaced backend: that session has no viewport
 * but must survive reload the same way `afterPaneRemoved` keeps it. */
export function layoutSessions(layout: Layout): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const pane of layoutRefs(layout)) {
    for (const session of paneRetainedSessions(pane.content)) {
      if (seen.has(session)) continue;
      seen.add(session);
      ids.push(session);
    }
  }
  return ids;
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
  algorithmId,
  algorithmVersion,
}: {
  root: LayoutNode | null;
  floats?: readonly LayoutFloat[];
  docks?: DockStrips;
  dockSizes?: Partial<Record<DockSide, number>>;
  focus?: string;
  algorithmId?: string;
  algorithmVersion?: number;
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
        algorithmId,
        algorithmVersion,
      }
    : {
        version: LAYOUT_VERSION,
        root,
        floats,
        docks: docks ? normalizedDocks : undefined,
        dockSizes: dockSizes ? { ...dockSizes } : undefined,
        algorithmId,
        algorithmVersion,
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
  if (children.length === 1) {
    // A one-child split is that child. A one-child container is not: its kind's
    // arrangement (niri column width + scroll offset) stays meaningful for a
    // lone column, and collapsing it to a bare pane/stack is what made a
    // single-column niri window reappear as a vertical split after reattach.
    if (node.type === "container") return { ...node, children };
    return { ...children[0]!, weight: node.weight };
  }

  // A child split along the same axis as its parent is flattened into it: the
  // live tree only nests when the axis alternates (see Window.split), so a
  // same-axis nesting is another shape that could never be rebuilt as written.
  // Only meaningful between two splits — a container's nesting is its owning
  // kind's business, not core's to flatten.
  const flattened =
    node.type === "split"
      ? children.flatMap((child) =>
          child.type === "split" && child.direction === node.direction
            ? redistribute(child.children, child.weight)
            : [child],
        )
      : children;

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
    Match.value(at).pipe(
      Match.when(Match.is(from), () => move(pane, b)),
      Match.when(Match.is(to), () => move(pane, a)),
      Match.orElse(() => pane),
    ),
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
 * Rewrite one pane's full content across every plane that places it.
 *
 * Used for replace-in-place opens (plugin/editor into the calling leaf) and
 * for restoring a displaced session. The pane's id and placement never
 * change. A pane the layout does not place is left alone.
 */
export function setPaneContent(layout: Layout, paneId: string, content: PaneContent): Layout {
  const rewriteRef = (pane: PaneRef): PaneRef => (pane.id !== paneId ? pane : { ...pane, content });
  const rewriteFloat = (float: LayoutFloat): LayoutFloat => {
    const rewritten = rewriteRef(float);
    return rewritten === float ? float : { ...float, content: rewritten.content };
  };
  const dockStrips = layout.docks ?? emptyDockStrips();
  const root = rewriteTiledContent(layout.root, paneId, content);
  const floats = layout.floats.map(rewriteFloat);
  const docks = {
    left: dockStrips.left.map(rewriteRef),
    right: dockStrips.right.map(rewriteRef),
    top: dockStrips.top.map(rewriteRef),
    bottom: dockStrips.bottom.map(rewriteRef),
  } as DockStrips;
  return makeLayout({ ...layout, root, floats, docks });
}

/**
 * Rewrite one pane's descriptor across every plane that places it.
 *
 * The descriptor-update command's transform (ts-a4e25e). Only the remount
 * contract a plugin view reads back changes. A non-plugin pane, or a pane
 * the layout does not place, is left alone.
 */
export function setPaneDescriptor(
  layout: Layout,
  paneId: string,
  descriptor: OwnerJsonText,
): Layout {
  const pane = layoutRefs(layout).find((item) => item.id === paneId);
  if (!pane || pane.content.kind !== "plugin") return layout;
  return setPaneContent(layout, paneId, { ...pane.content, descriptor });
}

const sameAgentSession = (
  left: PaneAgentSessionSnapshot | undefined,
  right: PaneAgentSessionSnapshot | undefined,
): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.source === right.source &&
    left.agent === right.agent &&
    left.kind === right.kind &&
    left.value === right.value);

/**
 * Attach or clear a pane's persisted agent conversation ref across every plane.
 * Conversation follows the pane (herdr PaneSnapshot.agent_session).
 */
export function setPaneAgentSession(
  layout: Layout,
  paneId: string,
  agentSession: PaneAgentSessionSnapshot | undefined,
): Layout {
  const pane = layoutRefs(layout).find((item) => item.id === paneId);
  if (!pane || sameAgentSession(pane.agentSession, agentSession)) return layout;

  const withSession = (ref: PaneRef): PaneRef => {
    if (ref.id !== paneId) return ref;
    if (agentSession === undefined) {
      if (ref.agentSession === undefined) return ref;
      const { agentSession: _drop, ...rest } = ref;
      return rest;
    }
    return { ...ref, agentSession };
  };

  const rewriteTiled = (node: LayoutNode | null): LayoutNode | null => {
    if (!node) return null;
    if (node.type === "pane") {
      const next = withSession(node);
      return next === node ? node : { ...node, ...next, type: "pane", weight: node.weight };
    }
    return {
      ...node,
      children: node.children.map(rewriteTiled) as LayoutNode[],
    };
  };
  const rewriteFloat = (float: LayoutFloat): LayoutFloat => {
    const next = withSession(float);
    return next === float ? float : { ...float, ...next };
  };
  const dockStrips = layout.docks ?? emptyDockStrips();
  const docks = {
    left: dockStrips.left.map(withSession),
    right: dockStrips.right.map(withSession),
    top: dockStrips.top.map(withSession),
    bottom: dockStrips.bottom.map(withSession),
  } as DockStrips;
  return makeLayout({
    ...layout,
    root: rewriteTiled(layout.root),
    floats: layout.floats.map(rewriteFloat),
    docks,
  });
}

function rewriteTiledContent(
  node: LayoutNode | null,
  paneId: string,
  content: PaneContent,
): LayoutNode | null {
  if (!node) return null;
  if (node.type === "pane") {
    if (node.id !== paneId) return node;
    return { ...node, content };
  }
  return {
    ...node,
    children: node.children.map((child) =>
      rewriteTiledContent(child, paneId, content),
    ) as LayoutNode[],
  };
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
 * Remove panes whose session is gone, keeping the rest of the shape.
 *
 * Restore has to cope with a layout outliving its processes: a session saved
 * with four agents may come back with two that still exist. Dropping the dead
 * leaves and collapsing what is left preserves the arrangement of the
 * survivors, which is much closer to what the user had than starting over.
 *
 * A replace-host's `displaced` keepalive is cleared the same way: once that
 * backend is gone there is nothing to restore, and leaving the stale id makes
 * the workspace fail reference checks.
 */
export function prune(layout: Layout, alive: (session: string) => boolean): Layout {
  const dockStrips = layout.docks ?? emptyDockStrips();
  const keepContent = (content: PaneContent): PaneContent => {
    if (content.kind !== "plugin" || content.displaced === undefined) return content;
    if (alive(content.displaced)) return content;
    const { displaced: _dead, ...rest } = content;
    return rest;
  };
  const keepPane = <P extends PaneRef>(pane: P): P | null => {
    const session = paneSession(pane.content);
    // A sessionless pane (client-only plugin) has nothing to outlive and is
    // never pruned: it does not depend on a process to exist. Its displaced
    // keepalive may still be stripped when that backend dies.
    if (session !== undefined && !alive(session)) return null;
    const content = keepContent(pane.content);
    return content === pane.content ? pane : { ...pane, content };
  };
  const filter = (node: LayoutNode): LayoutNode | null => {
    if (node.type === "pane") return keepPane(node);
    const children = node.children
      .map(filter)
      .filter((child): child is LayoutNode => child !== null);
    return children.length ? { ...node, children } : null;
  };

  const root = layout.root ? collapse(filter(layout.root)) : null;
  const floats = layout.floats.flatMap((float) => {
    const kept = keepPane(float);
    return kept ? [{ ...float, content: kept.content }] : [];
  });
  const docks: DockStrips = {
    left: dockStrips.left.flatMap((pane) => {
      const kept = keepPane(pane);
      return kept ? [kept] : [];
    }),
    right: dockStrips.right.flatMap((pane) => {
      const kept = keepPane(pane);
      return kept ? [kept] : [];
    }),
    top: dockStrips.top.flatMap((pane) => {
      const kept = keepPane(pane);
      return kept ? [kept] : [];
    }),
    bottom: dockStrips.bottom.flatMap((pane) => {
      const kept = keepPane(pane);
      return kept ? [kept] : [];
    }),
  };
  // A session dying takes its pane with it, and that pane may be the focused
  // one. Focus moves the way closeLayout moves it on a close: to the pane at
  // the dead one's position, or to the last survivor — never left dangling,
  // or the window comes back with nothing focused (natural exit, session.kill).
  const before = layoutRefs(layout);
  const focusIndex =
    layout.focus === undefined ? -1 : before.findIndex((pane) => pane.id === layout.focus);
  const after = [...layoutPanes(root), ...DOCK_SIDES.flatMap((side) => docks[side]), ...floats];
  const focus =
    layout.focus !== undefined && !after.some((pane) => pane.id === layout.focus)
      ? (after[Math.min(focusIndex, after.length - 1)] ?? after.at(-1))?.id
      : layout.focus;
  return makeLayout({ ...layout, root, floats, docks, focus });
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

const LayoutPresetSchema = S.Literals([...LAYOUT_PRESETS]);
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

const paneId = S.String.pipe(S.check(S.isMinLength(1))).annotate({
  message: "pane needs a pane id",
});
const sessionId = S.String.pipe(S.check(S.isMinLength(1))).annotate({
  message: "content needs a session id",
});
export const PaneContentSchema: S.Codec<PaneContent> = S.Union([
  S.Struct({
    kind: S.Literals(["pty"]),
    session: sessionId.pipe(S.annotateKey({ messageMissingKey: "pty content needs a session id" })),
  }),
  S.Struct({
    kind: S.Literals(["plugin"]),
    type: S.String.pipe(
      S.check(S.isMinLength(1)),
      S.annotateKey({ messageMissingKey: "plugin content needs a pane type" }),
    ),
    descriptor: DescriptorSchema.pipe(
      S.annotateKey({ messageMissingKey: "plugin content needs a descriptor" }),
    ),
    session: S.optional(sessionId),
    displaced: S.optional(sessionId),
  }),
]) as S.Codec<PaneContent>;
const weight = S.Finite.pipe(
  S.check(S.isGreaterThan(0, { message: "weight must be a positive number" })),
);
const origin = S.Finite.pipe(
  S.check(S.isGreaterThanOrEqualTo(0)),
  S.check(S.isLessThan(1)),
).annotate({
  message: "must be a fraction of the window",
});
const size = S.Finite.pipe(
  S.check(S.isGreaterThan(0, { message: "must be a fraction of the window" })),
  S.check(S.isLessThanOrEqualTo(1, { message: "must be a fraction of the window" })),
);

const LayoutPaneSchema = S.Struct({
  type: S.Literals(["pane"]),
  content: PaneContentSchema.pipe(S.annotateKey({ messageMissingKey: "pane needs content" })),
  id: paneId.pipe(S.annotateKey({ messageMissingKey: "pane needs a pane id" })),
  weight: weight.pipe(S.withDecodingDefaultType(Effect.succeed(1))),
  agentSession: S.optional(PaneAgentSessionSnapshotSchema),
});

// The recursive schema's array is readonly and its optional field encoding does
// not match the mutable, defaulted public node model, so the boundary cast is
// required to use the decoded value as LayoutNode.
//
// The "container" arm only checks the generic envelope — kind is some
// non-empty string, children recurse as ordinary LayoutNodes, arrangement is
// unknown. Per-kind validation of `arrangement` is a second pass a caller
// runs against that kind's own registered schema (see
// docs/adr/0004-arrangement-kind-is-an-open-registry.md); this schema alone
// deliberately cannot express it, since which kinds exist is not known here.
const LayoutNodeSchema = S.Union([
  LayoutPaneSchema,
  S.Struct({
    type: S.Literals(["split"]),
    direction: S.Literals(["row", "column"]).annotate({
      message: 'split needs direction "row" or "column"',
    }),
    weight: weight.pipe(S.withDecodingDefaultType(Effect.succeed(1))),
    children: S.Array(S.suspend((): S.Codec<LayoutNode> => LayoutNodeSchema))
      .pipe(S.check(S.isMinLength(1)))
      .annotate({ message: "split needs children" }),
  }),
  S.Struct({
    type: S.Literals(["container"]),
    kind: S.String.pipe(S.check(S.isMinLength(1))).annotate({
      message: "container needs a kind",
    }),
    weight: weight.pipe(S.withDecodingDefaultType(Effect.succeed(1))),
    arrangement: S.Unknown,
    children: S.Array(S.suspend((): S.Codec<LayoutNode> => LayoutNodeSchema))
      .pipe(S.check(S.isMinLength(1)))
      .annotate({ message: "container needs children" }),
  }),
]) as S.Codec<LayoutNode>;

export const LayoutSchema = S.Struct({
  version: S.Literal(LAYOUT_VERSION).annotate({
    message: `unsupported layout version (expected ${LAYOUT_VERSION})`,
  }),
  root: S.NullOr(LayoutNodeSchema).pipe(S.withDecodingDefaultType(Effect.succeed(null))),
  floats: S.Array(
    S.Struct({
      id: paneId.pipe(S.annotateKey({ messageMissingKey: "float needs a pane id" })),
      content: PaneContentSchema.pipe(S.annotateKey({ messageMissingKey: "float needs content" })),
      agentSession: S.optional(PaneAgentSessionSnapshotSchema),
      x: origin,
      y: origin,
      width: size,
      height: size,
    }),
  ).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
  docks: S.optional(
    S.Struct({
      left: S.Array(
        S.Struct({
          id: paneId,
          content: PaneContentSchema,
          agentSession: S.optional(PaneAgentSessionSnapshotSchema),
        }),
      ).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
      right: S.Array(
        S.Struct({
          id: paneId,
          content: PaneContentSchema,
          agentSession: S.optional(PaneAgentSessionSnapshotSchema),
        }),
      ).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
      top: S.Array(
        S.Struct({
          id: paneId,
          content: PaneContentSchema,
          agentSession: S.optional(PaneAgentSessionSnapshotSchema),
        }),
      ).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
      bottom: S.Array(
        S.Struct({
          id: paneId,
          content: PaneContentSchema,
          agentSession: S.optional(PaneAgentSessionSnapshotSchema),
        }),
      ).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
    }),
  ),
  dockSizes: S.optional(
    S.Struct({
      left: S.optional(S.Int.pipe(S.check(S.isGreaterThan(1)))),
      right: S.optional(S.Int.pipe(S.check(S.isGreaterThan(1)))),
      top: S.optional(S.Int.pipe(S.check(S.isGreaterThan(1)))),
      bottom: S.optional(S.Int.pipe(S.check(S.isGreaterThan(1)))),
    }),
  ),
  focus: S.optional(paneId),
  algorithmId: S.optional(S.String),
  algorithmVersion: S.optional(S.Int),
});

/** Serialize for session.json or the wire.
 *
 * Encodes through {@link LayoutSchema}: its Struct field order is the stable
 * key order (equal layouts stringify equal), and {@link OwnerJsonText} flip
 * nests descriptors as real JSON. No hand-rolled nestContent/order pass.
 */
export function encodeLayout(layout: Layout): Effect.Effect<string, LayoutFormatError> {
  const normalized = makeLayout({ ...layout, root: collapse(layout.root) });
  return S.encodeEffect(S.fromJsonString(LayoutSchema))(normalized).pipe(
    Effect.mapError(
      (error) => new LayoutFormatError({ message: `layout encode failed: ${formatSchemaError(error)}` }),
    ),
  );
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
  return S.decodeEffect(S.fromJsonString(S.Unknown))(text).pipe(
    Effect.mapError((error) => new LayoutFormatError({ message: `layout is not JSON: ${error}` })),
    Effect.flatMap(parseLayout),
  );
}

export function parseLayout(value: unknown): Effect.Effect<Layout, LayoutFormatError> {
  return S.decodeUnknownEffect(LayoutSchema)(value).pipe(
    Effect.mapError((error) => new LayoutFormatError({ message: formatSchemaError(error) })),
    Effect.flatMap(validateDecodedLayout),
  );
}

const standardSchemaFormatter = SchemaIssue.makeFormatterStandardSchemaV1();

function formatSchemaError(error: S.SchemaError): string {
  const issues = standardSchemaFormatter(error.issue).issues;
  // A node is a union, so every member that does not recognize the node's
  // `type` reports that discriminant alongside the real complaint from the
  // member that did recognize it. Rank a discriminant mismatch last, then take
  // the deepest issue: "unknown type" is only the answer when no member
  // accepted the node at all.
  const rank = (issue: (typeof issues)[number]) => {
    const path = (issue.path ?? []) as ReadonlyArray<PropertyKey>;
    return (path.at(-1) === "type" ? 0 : 1_000) + path.length;
  };
  const issue = [...issues].sort((left, right) => rank(right) - rank(left))[0];
  if (!issue) return "layout is invalid";
  const path = (issue.path ?? []) as ReadonlyArray<PropertyKey>;
  if (path.at(-1) === "type") {
    return `${formatPath(path.slice(0, -1))} has unknown type`;
  }
  const formatted = formatPath(path);
  return formatted ? `${formatted} ${issue.message}` : issue.message;
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
      if (node.type === "pane") {
        reservePaneId(node.id);
        return Effect.void;
      }
      return Effect.forEach(node.children, (child) => visit(child, depth + 1)).pipe(Effect.asVoid);
    };
    const root = decoded.root;
    if (root) yield* visit(root, 1);
    const floats = decoded.floats;
    for (const float of floats) {
      if (++nodes > MAX_LAYOUT_NODES)
        return yield* new LayoutFormatError({
          message: `layout exceeds maximum node count ${MAX_LAYOUT_NODES}`,
        });
      reservePaneId(float.id);
    }
    const docks = decoded.docks ?? emptyDockStrips();
    for (const side of DOCK_SIDES) for (const pane of docks[side]) reservePaneId(pane.id);
    const sanitizeRef = <T extends PaneRef>(pane: T): T => {
      if (pane.agentSession === undefined) return pane;
      if (Option.isSome(persistedAgentSessionFromSnapshot(pane.agentSession))) return pane;
      const { agentSession: _drop, ...rest } = pane;
      return rest as T;
    };
    const sanitizeNode = (node: LayoutNode | null): LayoutNode | null => {
      if (!node) return null;
      if (node.type === "pane") return sanitizeRef(node);
      return { ...node, children: node.children.map(sanitizeNode) as LayoutNode[] };
    };
    return makeLayout({
      root: collapse(sanitizeNode(root)),
      floats: floats.map(sanitizeRef),
      docks:
        decoded.docks !== undefined
          ? ({
              left: docks.left.map(sanitizeRef),
              right: docks.right.map(sanitizeRef),
              top: docks.top.map(sanitizeRef),
              bottom: docks.bottom.map(sanitizeRef),
            } as DockStrips)
          : undefined,
      dockSizes: decoded.dockSizes,
      focus: decoded.focus,
      algorithmId: decoded.algorithmId,
      algorithmVersion: decoded.algorithmVersion,
    });
  });
}
