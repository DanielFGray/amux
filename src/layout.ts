/**
 * A window's split tree, as data.
 *
 * The renderable tree in window.ts is the live layout, but it cannot be stored,
 * compared, or sent anywhere: it is Boxes, Dividers and panes wired to agents
 * and a renderer. This is the same shape reduced to what actually defines a
 * layout — nesting, axis, relative sizes, and which agent sits in each leaf.
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
 */

import type { SplitDirection } from "./window.ts"

/** The format written into session.json and any exported string. */
export const LAYOUT_VERSION = 1

export type LayoutNode = LayoutPane | LayoutSplit

export interface LayoutPane {
  type: "pane"
  /** Agent.id. A layout is a shape plus an assignment of agents to slots. */
  agent: string
  /** Flex weight, relative to siblings. See divider.ts getWeight. */
  weight: number
}

export interface LayoutSplit {
  type: "split"
  direction: SplitDirection
  weight: number
  /** Two or more. A one-child split is a split in name only and is collapsed. */
  children: LayoutNode[]
}

export interface Layout {
  version: typeof LAYOUT_VERSION
  /** Absent for a window with no panes, which is a real state during teardown. */
  root: LayoutNode | null
  /** Agent.id of the pane that had focus, if it is still in the tree. */
  focus?: string
}

/** Every pane in the tree, left to right, depth first — the order `^a o` walks. */
export function layoutPanes(node: LayoutNode | null): LayoutPane[] {
  if (!node) return []
  if (node.type === "pane") return [node]
  return node.children.flatMap(layoutPanes)
}

/** Agent ids the layout expects to exist, in pane order. */
export function layoutAgents(layout: Layout): string[] {
  return layoutPanes(layout.root).map((pane) => pane.agent)
}

/**
 * Assemble a layout, keeping the focus only if its pane is still in the tree.
 *
 * Every path that produces a Layout has to answer this, because every one of
 * them can drop the focused pane: collapsing, pruning dead agents, parsing
 * hand-written input, and reading a live window whose focus has moved. A focus
 * naming a pane that is not there would rebuild a window with nothing focused,
 * so it is dropped here rather than at four separate call sites.
 *
 * Key order is fixed for the same reason encodeLayout is stable — two equal
 * layouts must serialize to equal strings.
 */
export function makeLayout(root: LayoutNode | null, focus?: string): Layout {
  const present = focus !== undefined && layoutPanes(root).some((pane) => pane.agent === focus)
  return present ? { version: LAYOUT_VERSION, root, focus } : { version: LAYOUT_VERSION, root }
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
  if (!node) return null
  if (node.type === "pane") return node

  const children = node.children.map(collapse).filter((child): child is LayoutNode => child !== null)
  if (children.length === 0) return null
  if (children.length === 1) return { ...children[0]!, weight: node.weight }

  // A child split along the same axis as its parent is flattened into it: the
  // live tree only nests when the axis alternates (see Window.split), so a
  // same-axis nesting is another shape that could never be rebuilt as written.
  const flattened = children.flatMap((child) =>
    child.type === "split" && child.direction === node.direction
      ? redistribute(child.children, child.weight)
      : [child],
  )

  return { ...node, children: flattened }
}

/** Scale a flattened split's children so they keep their share of the space the
 *  nested split used to occupy. */
function redistribute(children: LayoutNode[], weight: number): LayoutNode[] {
  const total = children.reduce((sum, child) => sum + child.weight, 0)
  if (total <= 0) return children
  return children.map((child) => ({ ...child, weight: (child.weight / total) * weight }))
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
  let seen = 0
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (node.type === "pane") return fn(node, seen++)
    const children = node.children.map(walk).filter((child): child is LayoutNode => child !== null)
    return children.length ? { ...node, children } : null
  }
  return root ? walk(root) : null
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
 * Focus moves to the new pane, as it does in tmux. It is named by agent id like
 * every other focus, so splitting to show an agent this window is ALREADY
 * showing leaves the focus ambiguous — the first pane showing it wins. That is
 * the modelling gap pane identity closes (ep-ceb468 phase 2); until then
 * Window.split finds the newcomer by position instead.
 */
export function splitLayout(
  layout: Layout,
  index: number,
  direction: SplitDirection,
  agent: string,
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
            { type: "pane", agent, weight: 1 },
          ],
        },
  )
  return makeLayout(collapse(root), agent)
}

/**
 * Exchange the agents in two panes.
 *
 * Slots keep their weights and the agents move between them, which is what
 * tmux's swap-pane does and what Window.swap arrived at the long way round: it
 * moved the renderables and then handed each the other's weight. Focus is an
 * agent id, so it follows the agent to its new slot for free.
 */
export function swapLayout(layout: Layout, from: number, to: number): Layout {
  const panes = layoutPanes(layout.root)
  const a = panes[from]
  const b = panes[to]
  if (!a || !b || from === to) return layout
  const root = rewritePanes(layout.root, (pane, at) =>
    at === from ? { ...pane, agent: b.agent } : at === to ? { ...pane, agent: a.agent } : pane,
  )
  return makeLayout(collapse(root), layout.focus)
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
    if (node.type === "pane") return alive(node.agent) ? node : null
    const children = node.children
      .map(filter)
      .filter((child): child is LayoutNode => child !== null)
    return children.length ? { ...node, children } : null
  }

  const root = layout.root ? collapse(filter(layout.root)) : null
  return makeLayout(root, layout.focus)
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
] as const

export type LayoutPreset = (typeof LAYOUT_PRESETS)[number]

export function isLayoutPreset(value: unknown): value is LayoutPreset {
  return typeof value === "string" && (LAYOUT_PRESETS as readonly string[]).includes(value)
}

/** tmux's next-layout: step through the presets, starting the cycle over from
 *  a window whose layout was built by hand and matches no preset. */
export function nextPreset(current: LayoutPreset | null): LayoutPreset {
  const i = current ? LAYOUT_PRESETS.indexOf(current) : -1
  return LAYOUT_PRESETS[(i + 1) % LAYOUT_PRESETS.length]!
}

const pane = (agent: string, weight = 1): LayoutPane => ({ type: "pane", agent, weight })

const split = (direction: SplitDirection, children: LayoutNode[], weight = 1): LayoutNode =>
  children.length === 1 ? { ...children[0]!, weight } : { type: "split", direction, weight, children }

/**
 * Build one of the named layouts over a list of agents.
 *
 * Agents keep their given order, so cycling layouts rearranges the same panes
 * rather than shuffling them — the property that makes next-layout usable at
 * all. Sizes come out even: a preset is a deliberate discard of hand-tuned
 * weights, which is the point of asking for one.
 *
 * Everything is passed through collapse(), so degenerate cases (one agent, a
 * main layout with nothing beside the main pane, a single-row tiling) come back
 * as the flat tree the live window would actually build.
 */
export function presetLayout(agents: string[], preset: LayoutPreset, focus?: string): Layout {
  if (agents.length === 0) return makeLayout(null)
  const [first, ...rest] = agents as [string, ...string[]]

  const build = (): LayoutNode => {
    switch (preset) {
      case "even-horizontal":
        return split("row", agents.map((agent) => pane(agent)))
      case "even-vertical":
        return split("column", agents.map((agent) => pane(agent)))
      // The main pane takes half; tmux sizes it in cells, which we cannot do
      // here because a layout is resolution-independent.
      case "main-horizontal":
        return split("column", [pane(first), split("row", rest.map((a) => pane(a)))])
      case "main-vertical":
        return split("row", [pane(first), split("column", rest.map((a) => pane(a)))])
      case "tiled":
        return tiled(agents)
    }
  }

  return makeLayout(collapse(rest.length === 0 ? pane(first) : build()), focus)
}

/** A grid as square as the count allows, filled row by row — tmux layout-set.c,
 *  where a short final row simply spreads across the full width. */
function tiled(agents: string[]): LayoutNode {
  let columns = Math.floor(Math.sqrt(agents.length))
  if (columns * columns < agents.length) columns++
  const rows: LayoutNode[] = []
  for (let i = 0; i < agents.length; i += columns) {
    rows.push(split("row", agents.slice(i, i + columns).map((agent) => pane(agent))))
  }
  return split("column", rows)
}

export class LayoutFormatError extends Error {}

/** Serialize for session.json or the wire. Stable key order, so two equal
 *  layouts encode to equal strings and a diff of session.json stays readable. */
export function encodeLayout(layout: Layout): string {
  const normalized = makeLayout(collapse(layout.root), layout.focus)
  return JSON.stringify({ ...normalized, root: order(normalized.root) })
}

function order(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null
  if (node.type === "pane") return { type: "pane", agent: node.agent, weight: node.weight }
  return {
    type: "split",
    direction: node.direction,
    weight: node.weight,
    children: node.children.map(order) as LayoutNode[],
  }
}

/**
 * Parse a layout, rejecting anything that would not rebuild.
 *
 * Hand-edited and cross-version input reaches this directly, and a malformed
 * layout must fail as a value rather than by throwing halfway through mutating
 * a live window — by the time applyLayout runs, the old tree is already gone.
 */
export function decodeLayout(text: string): Layout {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new LayoutFormatError(`layout is not JSON: ${(error as Error).message}`)
  }
  return parseLayout(parsed)
}

export function parseLayout(value: unknown): Layout {
  if (!value || typeof value !== "object") throw new LayoutFormatError("layout must be an object")
  const raw = value as Partial<Layout>
  if (raw.version !== LAYOUT_VERSION) {
    throw new LayoutFormatError(`unsupported layout version ${String(raw.version)}`)
  }
  const root = raw.root === null || raw.root === undefined ? null : parseNode(raw.root, "root")
  if (raw.focus !== undefined && typeof raw.focus !== "string") {
    throw new LayoutFormatError("focus must be an agent id")
  }
  return makeLayout(collapse(root), raw.focus)
}

function parseNode(value: unknown, at: string): LayoutNode {
  if (!value || typeof value !== "object") throw new LayoutFormatError(`${at} must be an object`)
  const raw = value as Record<string, unknown>
  const weight = parseWeight(raw.weight, at)

  if (raw.type === "pane") {
    if (typeof raw.agent !== "string" || !raw.agent) {
      throw new LayoutFormatError(`${at} pane needs an agent id`)
    }
    return { type: "pane", agent: raw.agent, weight }
  }

  if (raw.type === "split") {
    if (raw.direction !== "row" && raw.direction !== "column") {
      throw new LayoutFormatError(`${at} split needs direction "row" or "column"`)
    }
    if (!Array.isArray(raw.children) || raw.children.length === 0) {
      throw new LayoutFormatError(`${at} split needs children`)
    }
    return {
      type: "split",
      direction: raw.direction,
      weight,
      children: raw.children.map((child, i) => parseNode(child, `${at}.children[${i}]`)),
    }
  }

  throw new LayoutFormatError(`${at} has unknown type ${JSON.stringify(raw.type)}`)
}

/** Weights are relative, so any positive finite number is meaningful; a
 *  non-positive one would render as a zero-width pane and is refused. */
function parseWeight(value: unknown, at: string): number {
  if (value === undefined) return 1
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new LayoutFormatError(`${at} weight must be a positive number`)
  }
  return value
}
