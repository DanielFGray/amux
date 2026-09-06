import { BoxRenderable } from "@opentui/core";
import {
  definePlugin,
  OptionsTag,
  registerEnumValue,
  registerLayoutKindRenderer,
  type LayoutKindRenderer,
  type PluginDefinition,
} from "@danielfgray/amux";
import { Effect } from "effect";
import { niriTilingAlgorithm, type NiriArrangement } from "./niri.ts";

let nextId = 0;

// A scroll container materializes as opentui's own clip-plus-absolute-offset
// pattern rather than a divided flex row: its children carry an intrinsic
// size along the scroll axis (arrangement.sizes) instead of a
// sibling-relative weight, so there is nothing for core's divider bookkeeping
// to do here — see docs/adr/0004-arrangement-kind-is-an-open-registry.md.
const scrollRenderer: LayoutKindRenderer = {
  render(ctx, node, children) {
    const { offset, sizes } = node.arrangement as NiriArrangement;
    const viewport = new BoxRenderable(ctx, { id: `scroll-${nextId++}` });
    viewport.flexGrow = Math.max(0.0001, node.weight);
    viewport.flexBasis = 0;
    viewport.overflow = "hidden";
    const content = new BoxRenderable(ctx, { id: `scroll-content-${nextId++}` });
    content.flexDirection = "row";
    content.position = "absolute";
    const total = sizes.reduce((sum, size) => sum + size, 0);
    content.left = -offset;
    content.top = 0;
    content.width = total;
    content.height = "100%";
    children.forEach((child, i) => {
      child.width = sizes[i] ?? 0;
      content.add(child);
    });
    viewport.add(content);
    return viewport;
  },
};

export const niriPlugin: PluginDefinition = definePlugin({
  id: "amux.tiling.niri",
  inject: [OptionsTag],
  effect: () =>
    Effect.gen(function* () {
      yield* registerEnumValue({
        option: "behaviour.tilingAlgorithm",
        value: niriTilingAlgorithm.id,
      });
      yield* registerLayoutKindRenderer("scroll", scrollRenderer);
    }),
});

export default niriPlugin;
