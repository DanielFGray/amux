/**
 * Where a `LayoutContainer`'s `kind` (layout.ts) becomes how to draw it.
 *
 * Kept as its own small module rather than folded into an existing registry
 * because neither existing one fits: `ui/slots.ts`'s registry unconditionally
 * bridges every registered entry through Solid/opentui JSX (`sync()`), which
 * a plain BoxRenderable-building function is not; `TilingAlgorithmsTag`
 * (plugin/services.ts) elects one `TilingAlgorithm` per window, but a kind
 * and an algorithm are many-to-many — niri's own tree mixes `kind: "scroll"`
 * at the root with plain `LayoutSplit` nodes for each column, and any future
 * algorithm can reuse "split" the same way. See
 * docs/adr/0004-arrangement-kind-is-an-open-registry.md.
 *
 * Renderers are a contributions table owned by a `PluginInstance`: visibility
 * follows host commit, so a reload's replacement and a failed candidate are
 * both handled the same way as session views. Window reads the lookup from
 * `WorkspaceEnv` (`LayoutKinds` in env.ts).
 */
import type { Renderable, RenderContext } from "@opentui/core";
import type { LayoutContainer } from "./layout.ts";
import type { PluginContributions, PluginInstance } from "./plugin/contributions.ts";

/** Chrome helpers Window passes into a kind renderer — drag handles between
 *  that container's children, so a scroll strip can host the same divider
 *  targets a split tree gets from `fill()`. */
export interface LayoutKindChrome {
  /** Divider between children `index` and `index + 1` of this container. */
  makeDivider(index: number): Renderable;
}

export interface LayoutKindRenderer {
  /** `children` are already materialized — this only arranges them. `chrome`
   *  is optional so a kind that needs no drag handles can ignore it. */
  render(
    ctx: RenderContext,
    node: LayoutContainer,
    children: readonly Renderable[],
    chrome?: LayoutKindChrome,
  ): Renderable;
  /** Whether a pane inside this container has a neighbour on `side` along
   *  `axis` — Window chrome asks so gap=false mode can leave internal seams
   *  bare. Omit when the kind has no neighbour geometry of its own. */
  hasNeighbour?(
    node: LayoutContainer,
    paneId: string,
    axis: "row" | "column",
    side: -1 | 1,
  ): boolean;
  /** Live-echo a divider drag onto the last-rendered strip without remounting. */
  patchDivider?(node: LayoutContainer, index: number, delta: number): boolean;
  /** Apply a new scroll arrangement onto the live strip (sizes/offset) without
   *  tearing down dividers — Window.project uses this so a resize-divider
   *  command does not destroy the captured drag target mid-gesture. */
  applyArrangement?(node: LayoutContainer): boolean;
}

export interface LayoutKinds {
  readonly register: (
    owner: PluginInstance,
    kind: string,
    renderer: LayoutKindRenderer,
  ) => () => void;
  /** `kind`'s committed renderer, or undefined when none is loaded. */
  readonly renderer: (kind: string) => LayoutKindRenderer | undefined;
}

/**
 * The renderers a plugin can claim for a layout container kind.
 *
 * Two instances of one plugin may hold the same kind during a reload; the
 * table decides which of them Window is looking at.
 */
export function createLayoutKinds(contributions: PluginContributions): LayoutKinds {
  const renderers = contributions.table<LayoutKindRenderer>();
  return {
    register: renderers.add,
    renderer: (kind) => renderers.get(kind),
  };
}
