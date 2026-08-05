import { test, expect } from "vitest";
import {
  LAYOUT_VERSION,
  LayoutFormatError,
  closeLayout,
  collapse,
  decodeLayout,
  encodeLayout,
  layoutAgents,
  layoutPanes,
  newPaneId,
  nextPreset,
  parseLayout,
  presetLayout,
  prune,
  splitLayout,
  swapLayout,
  LAYOUT_PRESETS,
  type Layout,
  type LayoutNode,
} from "./layout.ts";

/** Panes are named after the agent they show, since most cases here have one
 *  pane per agent; the cases that do not say so explicitly. */
const pane = (agent: string, weight = 1, id = agent): LayoutNode => ({
  type: "pane",
  id,
  agent,
  weight,
});
const split = (direction: "row" | "column", children: LayoutNode[], weight = 1): LayoutNode => ({
  type: "split",
  direction,
  weight,
  children,
});

const layout = (root: LayoutNode | null, focus?: string): Layout =>
  focus ? { version: LAYOUT_VERSION, root, focus } : { version: LAYOUT_VERSION, root };

test("panes are listed left to right, depth first", () => {
  const tree = split("row", [pane("a"), split("column", [pane("b"), pane("c")]), pane("d")]);
  expect(layoutPanes(tree).map((p) => p.agent)).toEqual(["a", "b", "c", "d"]);
});

test("a layout round-trips through encode and decode", () => {
  const original = layout(
    split("row", [pane("a", 2), split("column", [pane("b"), pane("c", 3)], 5)]),
    "c",
  );
  expect(parseLayout(JSON.parse(encodeLayout(original)))).toEqual(original);
});

test("encoding is stable, so equal layouts produce equal strings", () => {
  const a = layout(split("row", [pane("x"), pane("y")]));
  const b = layout(split("row", [pane("x"), pane("y")]));
  expect(encodeLayout(a)).toBe(encodeLayout(b));
});

// The live tree collapses a one-child split away, so a decoded layout that kept
// the husk would rebuild an extra nesting level and the round trip would not be
// a fixed point. This is the case that closing a pane produces.
test("a split with one child collapses to that child and inherits its weight", () => {
  expect(collapse(split("row", [pane("only")], 7))).toEqual(pane("only", 7));
});

test("collapsing is recursive, so nested husks all disappear", () => {
  const nested = split("row", [split("column", [split("row", [pane("deep")])])], 4);
  expect(collapse(nested)).toEqual(pane("deep", 4));
});

// Window.split only nests when the axis alternates, so a same-axis nesting is a
// shape the live tree would never build and could not round-trip as written.
test("a same-axis child split is flattened into its parent", () => {
  const tree = split("row", [pane("a", 1), split("row", [pane("b"), pane("c")], 2)]);
  const flattened = collapse(tree) as Extract<LayoutNode, { type: "split" }>;
  expect(flattened.children.map((c) => (c.type === "pane" ? c.agent : "?"))).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("flattening preserves the share of space the nested split occupied", () => {
  const tree = split("row", [pane("a", 2), split("row", [pane("b", 1), pane("c", 3)], 4)]);
  const flattened = collapse(tree) as Extract<LayoutNode, { type: "split" }>;
  // b and c split the nested weight of 4 in a 1:3 ratio.
  expect(flattened.children.map((c) => c.weight)).toEqual([2, 1, 3]);
});

test("an alternating-axis nesting is left alone", () => {
  const tree = split("row", [pane("a"), split("column", [pane("b"), pane("c")])]);
  expect(collapse(tree)).toEqual(tree);
});

test("pruning drops panes whose agent is gone and keeps the survivors' shape", () => {
  const tree = split("row", [pane("a"), split("column", [pane("dead"), pane("c")])]);
  const pruned = prune(layout(tree), (id) => id !== "dead");
  // The column had two panes; losing one collapses it into the row.
  expect(layoutAgents(pruned)).toEqual(["a", "c"]);
  expect(pruned.root).toEqual(split("row", [pane("a"), pane("c")]));
});

test("pruning every pane leaves an empty layout rather than a husk", () => {
  const pruned = prune(layout(split("row", [pane("a"), pane("b")])), () => false);
  expect(pruned.root).toBeNull();
});

test("pruning clears a focus whose agent did not survive", () => {
  const pruned = prune(layout(split("row", [pane("a"), pane("b")]), "b"), (id) => id === "a");
  expect(pruned.focus).toBeUndefined();
});

test("pruning keeps a focus that did survive", () => {
  const pruned = prune(layout(split("row", [pane("a"), pane("b")]), "a"), (id) => id === "a");
  expect(pruned.focus).toBe("a");
});

// A focus naming a pane that is not in the tree would leave a rebuilt window
// with nothing focused, so it is dropped at the boundary rather than carried.
test("a focus not present in the tree is dropped on parse", () => {
  const parsed = parseLayout({ version: LAYOUT_VERSION, root: pane("a"), focus: "ghost" });
  expect(parsed.focus).toBeUndefined();
});

test("an empty layout round-trips", () => {
  expect(decodeLayout(encodeLayout(layout(null)))).toEqual(layout(null));
});

test("a missing weight defaults to an even share", () => {
  const parsed = parseLayout({
    version: LAYOUT_VERSION,
    root: { type: "split", direction: "row", children: [{ type: "pane", id: "a", agent: "a" }] },
  });
  expect(parsed.root).toEqual(pane("a", 1));
});

test("malformed JSON is refused as a value, not thrown from deep in a rebuild", () => {
  expect(() => decodeLayout("{not json")).toThrow(LayoutFormatError);
});

test("recursive layouts are bounded before they can exhaust the stack", () => {
  let root: any = { type: "pane", id: "deep-pane", agent: "deep-agent", weight: 1 };
  for (let i = 0; i < 65; i++) {
    root = {
      type: "split",
      direction: "row",
      weight: 1,
      children: [root, { type: "pane", id: `p-${i}`, agent: `a-${i}`, weight: 1 }],
    };
  }
  expect(() => parseLayout({ version: LAYOUT_VERSION, root })).toThrow("maximum depth");
});

test("an unsupported version is refused rather than guessed at", () => {
  expect(() => parseLayout({ version: 99, root: pane("a") })).toThrow(/unsupported layout version/);
});

test("a pane without an agent id is refused", () => {
  expect(() => parseLayout({ version: LAYOUT_VERSION, root: { type: "pane", weight: 1 } })).toThrow(
    /needs an agent id/,
  );
});

test("a pane without a pane id is refused", () => {
  expect(() =>
    parseLayout({ version: LAYOUT_VERSION, root: { type: "pane", agent: "a", weight: 1 } }),
  ).toThrow(/needs a pane id/);
});

// Otherwise a restored session's pane ids and the ones a later split mints
// would collide, and two different panes would answer to one name.
test("parsing reserves the pane ids it read, so fresh ones cannot collide", () => {
  const minted = Number(/\d+/.exec(newPaneId())![0]);
  parseLayout({
    version: LAYOUT_VERSION,
    root: { type: "pane", id: `pane-${minted + 500}`, agent: "a", weight: 1 },
  });
  expect(Number(/\d+/.exec(newPaneId())![0])).toBeGreaterThan(minted + 500);
});

test("a split without a valid direction is refused", () => {
  expect(() =>
    parseLayout({
      version: LAYOUT_VERSION,
      root: { type: "split", direction: "sideways", children: [pane("a")] },
    }),
  ).toThrow(/direction/);
});

test("a split with no children is refused", () => {
  expect(() =>
    parseLayout({
      version: LAYOUT_VERSION,
      root: { type: "split", direction: "row", children: [] },
    }),
  ).toThrow(/needs children/);
});

// A zero or negative weight renders as a pane with no cells, which reads as a
// pane that silently vanished.
test("a non-positive weight is refused", () => {
  expect(() => parseLayout({ version: LAYOUT_VERSION, root: pane("a", 0) })).toThrow(
    /positive number/,
  );
  expect(() => parseLayout({ version: LAYOUT_VERSION, root: pane("a", -3) })).toThrow(
    /positive number/,
  );
});

test("an unknown node type is refused", () => {
  expect(() => parseLayout({ version: LAYOUT_VERSION, root: { type: "tabs", weight: 1 } })).toThrow(
    /unknown type/,
  );
});

test("the error names where in the tree the problem is", () => {
  expect(() =>
    parseLayout({
      version: LAYOUT_VERSION,
      root: { type: "split", direction: "row", children: [pane("a"), { type: "pane" }] },
    }),
  ).toThrow(/root\.children\[1\]/);
});

// Presets.

/** The tree's shape, ignoring weights — what a preset is actually choosing. */
const shape = (node: LayoutNode | null): unknown => {
  if (!node) return null;
  if (node.type === "pane") return node.agent;
  return { [node.direction]: node.children.map(shape) };
};

const ids = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
const refs = (n: number) => ids(n).map((agent) => ({ id: agent, agent }));

test("even-horizontal is one row, even-vertical one column", () => {
  expect(shape(presetLayout(refs(3), "even-horizontal").root)).toEqual({ row: ["a", "b", "c"] });
  expect(shape(presetLayout(refs(3), "even-vertical").root)).toEqual({ column: ["a", "b", "c"] });
});

test("a main layout puts the first agent opposite the rest", () => {
  expect(shape(presetLayout(refs(4), "main-vertical").root)).toEqual({
    row: ["a", { column: ["b", "c", "d"] }],
  });
  expect(shape(presetLayout(refs(4), "main-horizontal").root)).toEqual({
    column: ["a", { row: ["b", "c", "d"] }],
  });
});

test("a main layout with a single other pane collapses to a plain split", () => {
  // Otherwise the rebuild would nest a one-child box the live tree never builds.
  expect(shape(presetLayout(refs(2), "main-vertical").root)).toEqual({ row: ["a", "b"] });
});

test("tiled grows as square as the count allows, filling row by row", () => {
  expect(shape(presetLayout(refs(1), "tiled").root)).toEqual("a");
  expect(shape(presetLayout(refs(2), "tiled").root)).toEqual({ row: ["a", "b"] });
  expect(shape(presetLayout(refs(4), "tiled").root)).toEqual({
    column: [{ row: ["a", "b"] }, { row: ["c", "d"] }],
  });
  // A short final row simply spreads across the width, as tmux's does.
  expect(shape(presetLayout(refs(5), "tiled").root)).toEqual({
    column: [{ row: ["a", "b", "c"] }, { row: ["d", "e"] }],
  });
});

test("every preset keeps the agents, in order, exactly once", () => {
  for (const preset of LAYOUT_PRESETS) {
    for (const n of [1, 2, 3, 5, 8]) {
      expect(layoutAgents(presetLayout(refs(n), preset))).toEqual(ids(n));
    }
  }
});

test("every preset alternates axes, so the live tree can rebuild it", () => {
  // Window.split only nests on an axis change; a same-axis nesting is a shape
  // that could be exported but never built, so no preset may emit one.
  const check = (node: LayoutNode, parent?: "row" | "column") => {
    if (node.type === "pane") return;
    expect(node.direction).not.toBe(parent);
    for (const child of node.children) check(child, node.direction);
  };
  for (const preset of LAYOUT_PRESETS) {
    for (const n of [1, 2, 3, 4, 5, 9]) {
      const root = presetLayout(refs(n), preset).root;
      if (root) check(root);
    }
  }
});

test("a preset keeps the focus when the agent is still there, drops it otherwise", () => {
  expect(presetLayout(refs(3), "tiled", "b").focus).toBe("b");
  expect(presetLayout(refs(3), "tiled", "zz").focus).toBeUndefined();
});

test("no agents is an empty layout, not a crash", () => {
  expect(presetLayout([], "tiled").root).toBeNull();
});

test("nextPreset walks the cycle and restarts from a hand-built layout", () => {
  expect(nextPreset(null)).toBe(LAYOUT_PRESETS[0]);
  const seen = [nextPreset(null)];
  for (let i = 1; i < LAYOUT_PRESETS.length; i++) seen.push(nextPreset(seen[i - 1]!));
  expect(seen).toEqual([...LAYOUT_PRESETS]);
  // And wraps.
  expect(nextPreset(LAYOUT_PRESETS[LAYOUT_PRESETS.length - 1]!)).toBe(LAYOUT_PRESETS[0]);
});

/**
 * Splitting, as a transformation of data.
 *
 * The half of Window.split that needs no renderer — and, once the daemon owns
 * the model (ep-ceb468), the whole of it.
 */
test("a split replaces a pane with itself and the newcomer", () => {
  const after = splitLayout(layout(pane("a")), 0, "row", { id: "b", agent: "b" });
  expect(after.root).toEqual(split("row", [pane("a"), pane("b")]));
  // tmux moves you into the pane you just made.
  expect(after.focus).toBe("b");
});

/**
 * The weights, which is the whole reason this can be written as one case.
 *
 * A pane dragged to 69 against a sibling at 31 must not split into 69 and a
 * fresh 1 — the newcomer would be a sliver a cell or two wide. Window.split
 * used to compute `weight / 2` by hand for the sibling case and inherit-then-
 * even for the nested one; here the nested even split is the only thing built,
 * and collapse()'s redistribution turns it into halves.
 */
test("splitting a resized pane gives the newcomer half of it", () => {
  const before = layout(split("row", [pane("a", 69), pane("b", 31)]), "b");
  const after = splitLayout(before, 1, "row", { id: "c", agent: "c" });

  // Flat, because the axis did not change: three panes in a row, which is what
  // tmux shows after two horizontal splits.
  expect(after.root).toEqual(split("row", [pane("a", 69), pane("b", 15.5), pane("c", 15.5)]));
});

test("splitting across the axis nests, and the new split inherits the slot", () => {
  const before = layout(split("row", [pane("a", 3), pane("b", 1)]), "a");
  const after = splitLayout(before, 0, "column", { id: "c", agent: "c" });

  expect(after.root).toEqual(
    split("row", [split("column", [pane("a"), pane("c")], 3), pane("b", 1)]),
  );
});

test("a split names a pane by position, so two panes on one agent are distinct", () => {
  const before = layout(split("row", [pane("a", 1, "p1"), pane("a", 1, "p2")]), "p1");
  const after = splitLayout(before, 1, "column", { id: "p3", agent: "b" });

  expect(after.root).toEqual(
    split("row", [pane("a", 1, "p1"), split("column", [pane("a", 1, "p2"), pane("b", 1, "p3")])]),
  );
});

/**
 * The reason panes have identity at all.
 *
 * Splitting to show an agent the window is ALREADY showing produces two panes
 * that agree on everything an agent id can say. Focus has to land on the one
 * just made, and before pane ids a layout simply could not express which that
 * was — Window.split worked around it by finding the newcomer positionally,
 * and restore focused whichever pane came first.
 */
test("focus names the pane a split just made, not another showing the same agent", () => {
  const before = layout(pane("a", 1, "p1"), "p1");
  const after = splitLayout(before, 0, "row", { id: "p2", agent: "a" });

  expect(layoutPanes(after.root).map((p) => p.id)).toEqual(["p1", "p2"]);
  expect(layoutPanes(after.root).map((p) => p.agent)).toEqual(["a", "a"]);
  expect(after.focus).toBe("p2");
});

test("a split at a position no pane has changes nothing", () => {
  const before = layout(split("row", [pane("a"), pane("b")]), "a");
  expect(splitLayout(before, 7, "row", { id: "c", agent: "c" }).root).toEqual(before.root);
});

/**
 * Swapping moves the panes, not the slots.
 *
 * The sizes belong to the arrangement and the panes move through it, which is
 * what tmux's swap-pane does — Window.swap arrives at the same place the long
 * way round, by moving renderables and then handing each the other's weight.
 */
test("a swap exchanges two panes and leaves the weights alone", () => {
  const before = layout(
    split("row", [pane("a", 3), split("column", [pane("b"), pane("c", 2)])]),
    "a",
  );
  const after = swapLayout(before, 0, 2);

  expect(after.root).toEqual(
    split("row", [pane("c", 3), split("column", [pane("b"), pane("a", 2)])]),
  );
  // A pane keeps its identity through the move, so the focus needed no fixing
  // up: it still names the pane the user was in, now in the other slot.
  expect(after.focus).toBe("a");
});

/**
 * Closing, as a transformation of data.
 *
 * The arithmetic detachPane used to do by hand turns out to be nothing at all:
 * weights are relative to siblings, so survivors grow into the freed space
 * without being touched.
 */
test("closing a pane leaves the survivors' proportions alone", () => {
  const before = layout(split("row", [pane("a", 1), pane("b", 2), pane("c", 3)]), "a");
  const after = closeLayout(before, 1);
  expect(after.root).toEqual(split("row", [pane("a", 1), pane("c", 3)]));
});

// The case that DID need a fixup imperatively: OpenTUI reads a weight as a
// fraction of the container, so a lone survivor left at its old half share
// renders half-width. collapse() already gives it the husk's weight.
test("the last survivor of a split inherits the whole slot", () => {
  const before = layout(split("row", [pane("a", 0.5), pane("b", 0.5)]), "a");
  expect(closeLayout(before, 1).root).toEqual(pane("a", 1));
});

test("closing collapses the husk it leaves, so the tree stays rebuildable", () => {
  const before = layout(split("row", [pane("a"), split("column", [pane("b"), pane("c")])]), "a");
  // The column is down to one child, which is the column's parent's child now.
  expect(closeLayout(before, 1).root).toEqual(split("row", [pane("a"), pane("c")]));
});

test("closing the focused pane moves focus to the one that took its place", () => {
  const before = layout(split("row", [pane("a"), pane("b"), pane("c")]), "b");
  expect(closeLayout(before, 1).focus).toBe("c");
});

// tmux's rule: there is no successor at the end, so focus falls back a place.
test("closing the last pane in order moves focus to the new last one", () => {
  const before = layout(split("row", [pane("a"), pane("b"), pane("c")]), "c");
  expect(closeLayout(before, 2).focus).toBe("b");
});

test("closing an unfocused pane leaves the focus where it was", () => {
  const before = layout(split("row", [pane("a"), pane("b"), pane("c")]), "c");
  expect(closeLayout(before, 0).focus).toBe("c");
});

// A window with nothing in it is a state it really has — the app closes it.
test("closing the only pane leaves an empty layout, not a husk", () => {
  const after = closeLayout(layout(pane("a"), "a"), 0);
  expect(after.root).toBeNull();
  expect(after.focus).toBeUndefined();
});

test("closing at a position no pane has changes nothing", () => {
  const before = layout(split("row", [pane("a"), pane("b")]), "a");
  expect(closeLayout(before, 7)).toEqual(before);
});

test("a swap with itself, or with a pane that is not there, changes nothing", () => {
  const before = layout(split("row", [pane("a"), pane("b")]), "a");
  expect(swapLayout(before, 0, 0)).toEqual(before);
  expect(swapLayout(before, 0, 5)).toEqual(before);
});
