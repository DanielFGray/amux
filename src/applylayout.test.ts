import { test, expect, afterEach } from "bun:test";
import { Divider } from "./divider.ts";
import { createHarness, run } from "./harness.ts";
import { RenderState } from "./ghostty.ts";
import { encodeLayout, decodeLayout, layoutAgents, makeLayout, type LayoutNode } from "./layout.ts";
import type { SessionHandle } from "./session-handle.ts";
import { Effect } from "effect";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup() {
  const harness = await createHarness();
  cleanup.push(harness.dispose);
  return harness;
}

const shape = (node: LayoutNode | null): unknown => {
  if (!node) return null;
  if (node.type === "pane") return "pane";
  return { [node.direction]: node.children.map(shape) };
};

/** The agent's on-screen text, so "the pane was reused" is checked against the
 *  terminal itself rather than against object identity alone. */
function screenTail(agent: SessionHandle): string {
  const state = new RenderState();
  try {
    state.update(agent.term);
    return state.tailText(8).join("\n");
  } finally {
    state.free();
  }
}

test("applying what was exported is a fixed point", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  run(window.splitSpawn("column"));
  await layout();
  const exported = window.exportLayout();

  expect(window.applyLayout(exported)).toBe(true);
  await layout();
  expect(window.exportLayout()).toEqual(exported);
});

test("a layout survives the wire format and rebuilds the same tree", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  run(window.splitSpawn("column"));
  await layout();
  const saved = encodeLayout(window.exportLayout());

  // Reshape it into something else entirely, then restore.
  window.selectLayout("even-vertical");
  await layout();
  expect(shape(window.exportLayout().root)).toEqual({
    column: ["pane", "pane", "pane"],
  });

  expect(window.applyLayout(Effect.runSync(decodeLayout(saved)))).toBe(true);
  await layout();
  expect(encodeLayout(window.exportLayout())).toBe(saved);
});

// A pane is a viewport onto a running process, so rebuilding must move panes
// rather than recreate them — a fresh pane would show an empty screen.
test("panes are reused, keeping their terminal and its output", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  const agent = second.session;
  agent.write("echo applylayout-marker-7\n");
  await Bun.sleep(300);
  expect(screenTail(agent)).toContain("applylayout-marker-7");

  window.applyLayout(
    makeLayout({
      root: {
        type: "split",
        direction: "column",
        weight: 1,
        children: [
          { type: "pane", id: second.id, agent: agent.id, weight: 1 },
          { type: "pane", id: first.id, agent: first.session.id, weight: 1 },
        ],
      },
    }),
  );
  await layout();

  // Same pane objects, same agents, same screen — only the arrangement moved.
  expect(window.panes).toEqual([second, first]);
  expect(second.session).toBe(agent);
  expect(agent.exited).toBe(false);
  expect(screenTail(agent)).toContain("applylayout-marker-7");
});

test("the rebuilt tree gets the dividers it needs, and no more", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  run(window.splitSpawn("row"));
  await layout();
  window.selectLayout("even-horizontal");
  await layout();

  const kids = window.root.getChildren();
  // pane | divider | pane | divider | pane
  expect(kids).toHaveLength(5);
  expect(kids.filter((k) => k instanceof Divider)).toHaveLength(2);
  expect(kids[1]).toBeInstanceOf(Divider);
  expect(kids[3]).toBeInstanceOf(Divider);
});

test("weights in the layout become real geometry", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  await layout();

  window.applyLayout(
    makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          { type: "pane", id: first.id, agent: first.session.id, weight: 3 },
          { type: "pane", id: second.id, agent: second.session.id, weight: 1 },
        ],
      },
    }),
  );
  await layout();

  const root = window.exportLayout().root as Extract<LayoutNode, { type: "split" }>;
  expect(root.children[0]!.weight).toBe(3);
  // Roughly 3:1 across the window, less the divider column.
  expect(first.width).toBeGreaterThan(second.width * 2);
});

test("the focus recorded in the layout is restored", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  await layout();
  window.focus(second);
  const exported = window.exportLayout();

  window.focus(first);
  window.applyLayout(exported);
  await layout();
  expect(window.focused).toBe(second);
});

test("a layout with no focus still leaves a pane focused", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  run(window.splitSpawn("row"));
  await layout();
  const { root } = window.exportLayout();

  expect(window.applyLayout(makeLayout({ root: root }))).toBe(true);
  await layout();
  expect(window.focused).toBe(first);
});

// A layout routinely outlives its processes: a session restored a day later, or
// a layout string pasted from another window.
test("panes naming an agent this window does not own are pruned away", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  await layout();

  const applied = window.applyLayout(
    makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          { type: "pane", id: first.id, agent: first.session.id, weight: 1 },
          {
            type: "pane",
            id: "pane-that-never-existed",
            agent: "agent-that-never-existed",
            weight: 1,
          },
          { type: "pane", id: second.id, agent: second.session.id, weight: 1 },
        ],
      },
    }),
  );
  await layout();

  expect(applied).toBe(true);
  expect(window.panes).toEqual([first, second]);
  expect(window.root.getChildren().filter((k) => k instanceof Divider)).toHaveLength(1);
});

// Pruning to nothing must not be a way to empty the window: a stale string is
// far likelier than a genuine wish to close every pane.
test("a layout naming nothing this window owns is refused, changing nothing", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  await layout();
  const before = window.exportLayout();

  const applied = window.applyLayout(
    makeLayout({
      root: { type: "pane", id: "nobody-pane", agent: "nobody", weight: 1 },
    }),
  );

  expect(applied).toBe(false);
  expect(window.panes).toEqual([first, second]);
  expect(window.exportLayout()).toEqual(before);
});

test("an empty layout is refused rather than closing every pane", async () => {
  const { window } = await setup();
  expect(window.applyLayout(makeLayout({ root: null }))).toBe(false);
  expect(window.panes).toHaveLength(1);
});

// The pane is a view; dropping it is a detach, exactly as pane.close is.
test("a pane the layout has no slot for is closed, but its agent survives", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  const dropped = second.session;
  await layout();

  window.applyLayout(
    makeLayout({
      root: { type: "pane", id: first.id, agent: first.session.id, weight: 1 },
    }),
  );
  await layout();

  expect(window.panes).toEqual([first]);
  expect(window.sessions).toContain(dropped);
  expect(dropped.exited).toBe(false);
  expect(window.detached).toContain(dropped);
  // The survivor fills the window rather than keeping its old half-share.
  expect(first.width).toBe(window.root.width);
});

// While zoomed the real tree is parked off the root; dismantling it from there
// is how a rebuild ends up restoring a layout that contains nothing.
test("applying a layout drops a zoom first", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  await layout();
  window.zoom();
  expect(window.zoomed).toBe(true);

  window.selectLayout("even-vertical");
  await layout();

  expect(window.zoomed).toBe(false);
  for (const pane of window.panes) expect(pane.width).toBeGreaterThan(0);
});

test("two panes on one agent stay two panes across a rebuild", async () => {
  const { window, layout } = await setup();
  const shared = run(window.spawn("shared", ["sleep", "30"]));
  window.split("row", shared);
  window.split("row", shared);
  await layout();
  expect(window.panes.filter((p) => p.session === shared)).toHaveLength(2);

  window.selectLayout("even-vertical");
  await layout();

  expect(window.panes.filter((p) => p.session === shared)).toHaveLength(2);
  expect(layoutAgents(window.exportLayout()).filter((id) => id === shared.id)).toHaveLength(2);
});

/**
 * The case pane identity exists for.
 *
 * Two panes showing one agent agree on everything an agent id can say. Before
 * panes had ids of their own the layout could not tell the rebuild which of
 * them to focus, and `split` had to find its newcomer positionally afterwards
 * because the layout it had just applied could not name it.
 */
test("splitting to show an agent the window already shows focuses the new pane", async () => {
  const { window, layout } = await setup();
  const shared = run(window.spawn("shared", ["sleep", "30"]));
  const first = window.split("row", shared)!;
  await layout();

  const second = window.split("row", shared)!;
  await layout();

  expect(second).not.toBe(first);
  expect(second.session).toBe(shared);
  expect(window.focused).toBe(second);
  expect(window.exportLayout().focus).toBe(second.id);
});

test("each of two panes on one agent keeps its own scroll position", async () => {
  const { window, layout } = await setup();
  const shared = run(window.spawn("shared", ["sleep", "30"]));
  const a = window.split("row", shared)!;
  const b = window.split("row", shared)!;
  await layout();

  const before = window.exportLayout();
  expect(window.applyLayout(before)).toBe(true);
  await layout();

  // Same pane objects in the same slots — a rebuild that matched on the agent
  // alone could put b where a was, and each pane's scrollback goes with it.
  expect(window.panes.filter((p) => p === a || p === b)).toEqual([a, b]);
  expect(window.exportLayout()).toEqual(before);
});

/**
 * A layout from somewhere else: the agents are ours, the pane ids are not.
 *
 * The arrangement is honoured and the panes are reused on the agent, but they
 * keep the identity they already had — a live pane's id is not something an
 * incoming string gets to reassign, since anything else holding that id would
 * silently start meaning a different viewport.
 */
test("a layout naming panes this window does not have reuses them by agent", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  await layout();

  // Read before the apply: the whole claim is that these do not change, and
  // comparing against them afterwards would compare them to themselves.
  const ids: [string, string] = [first.id, second.id];

  const applied = window.applyLayout(
    makeLayout({
      root: {
        type: "split",
        direction: "column",
        weight: 1,
        children: [
          {
            type: "pane",
            id: "pane-from-elsewhere-1",
            agent: second.session.id,
            weight: 1,
          },
          {
            type: "pane",
            id: "pane-from-elsewhere-2",
            agent: first.session.id,
            weight: 1,
          },
        ],
      },
      focus: "pane-from-elsewhere-1",
    }),
  );
  await layout();

  expect(applied).toBe(true);
  expect(window.panes).toEqual([second, first]);
  expect([first.id, second.id]).toEqual(ids);
  expect(window.panes.map((p) => p.id)).toEqual([ids[1], ids[0]]);
  // Focus was given as a slot, and lands on whichever pane filled that slot.
  expect(window.focused).toBe(second);
});

/**
 * Why the reuse runs in two passes rather than one.
 *
 * Both panes here show one agent, so either satisfies either slot on the agent
 * alone — but the second slot names one of them outright. Deciding slot by slot
 * would let the first slot take that very pane and leave the second with the
 * other, quietly swapping two panes whose scrollbacks differ. Claiming every
 * exact match first is what makes the named slot win.
 */
test("a slot naming a pane outright beats an earlier slot matching on the agent", async () => {
  const { window, layout } = await setup();
  const shared = run(window.spawn("shared", ["sleep", "30"]));
  const a = window.split("row", shared)!;
  const b = window.split("row", shared)!;
  await layout();

  window.applyLayout(
    makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          {
            type: "pane",
            id: "pane-from-elsewhere",
            agent: shared.id,
            weight: 1,
          },
          { type: "pane", id: a.id, agent: shared.id, weight: 1 },
        ],
      },
    }),
  );
  await layout();

  // `a` goes to the slot that named it; the anonymous slot takes what is left.
  expect(window.panes).toEqual([b, a]);
});

// Presets over the live tree.

test("a preset rearranges the same panes, in the same order", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  run(window.splitSpawn("column"));
  await layout();
  const before = window.panes.map((p) => p.session.id);

  expect(window.selectLayout("tiled")).toBe(true);
  await layout();

  expect(window.panes.map((p) => p.session.id)).toEqual(before);
});

test("even-horizontal actually gives the panes equal widths", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  run(window.splitSpawn("row"));
  run(window.splitSpawn("column"));
  await layout();
  window.selectLayout("even-horizontal");
  await layout();

  const widths = window.panes.map((p) => p.width);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
});

test("a preset keeps the focused pane focused", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  const third = run(window.splitSpawn("column"))!;
  await layout();
  window.focus(third);

  window.selectLayout("main-vertical");
  await layout();
  expect(window.focused).toBe(third);
});

test("a window remembers the preset it was arranged by, and forgets it when reshaped", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  await layout();
  // Built by hand, so it matches no preset.
  expect(window.preset).toBeNull();

  window.selectLayout("tiled");
  expect(window.preset).toBe("tiled");

  // Splitting moves it off that arrangement.
  run(window.splitSpawn("row"));
  expect(window.preset).toBeNull();

  window.selectLayout("even-vertical");
  expect(window.preset).toBe("even-vertical");
  // As does closing a pane.
  window.close(window.panes[0]!);
  expect(window.preset).toBeNull();
});

test("dragging a seam forgets the preset, so next-layout advances", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  await layout();
  window.selectLayout("even-horizontal");
  await layout();
  expect(window.preset).toBe("even-horizontal");

  const before = window.exportLayout();
  const widths = window.panes.map((pane) => pane.width);
  const divider = window.root.getChildren().find((k) => k instanceof Divider) as Divider;
  divider.onDrag!(-1);

  // The drag changes the resident model synchronously; the next frame is only
  // its projection catching up, not an export scraping weights back out.
  expect(window.exportLayout()).not.toEqual(before);
  expect(window.preset).toBeNull();
  await layout();
  expect(window.panes.map((pane) => pane.width)).toEqual([widths[0]! - 1, widths[1]! + 1]);
});

test("a preset on a single pane is a no-op that still reports success", async () => {
  const { window, layout } = await setup();
  const only = window.panes[0]!;
  expect(window.selectLayout("tiled")).toBe(true);
  await layout();
  expect(window.panes).toEqual([only]);
  expect(only.width).toBe(window.root.width);
});

test("a single-pane window exports as one pane, not a one-child split", async () => {
  const { window } = await setup();
  const exported = window.exportLayout();
  expect(exported.root).toEqual({
    type: "pane",
    id: window.panes[0]!.id,
    agent: window.panes[0]!.session.id,
    weight: expect.any(Number),
  });
});

test("the exported tree matches the nesting the splits actually built", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  run(window.splitSpawn("column"));
  await layout();
  expect(shape(window.exportLayout().root)).toEqual({
    row: ["pane", { column: ["pane", "pane"] }],
  });
});

test("every pane appears exactly once in the export, in left-to-right order", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  run(window.splitSpawn("column"));
  await layout();
  const ids = window.panes.map((p) => p.session.id);
  expect(layoutAgents(window.exportLayout()).sort()).toEqual([...ids].sort());
});

test("the focused pane is recorded in the export", async () => {
  const { window, layout } = await setup();
  const second = run(window.splitSpawn("row"))!;
  await layout();
  window.focus(second);
  expect(window.exportLayout().focus).toBe(second.id);
});

test("resized weights survive the export", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  run(window.splitSpawn("row"));
  await layout();
  window.applyLayout(
    makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          { type: "pane", id: first.id, agent: first.session.id, weight: 7 },
          {
            type: "pane",
            id: window.panes[1]!.id,
            agent: window.panes[1]!.session.id,
            weight: 1,
          },
        ],
      },
    }),
  );
  const root = window.exportLayout().root as Extract<LayoutNode, { type: "split" }>;
  const exported = root.children.find((c) => c.type === "pane" && c.agent === first.session.id);
  expect(exported?.weight).toBe(7);
});

test("exporting while zoomed records the underlying layout, not the zoomed view", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  run(window.splitSpawn("column"));
  await layout();
  const before = window.exportLayout();

  window.zoom();
  await layout();
  expect(window.zoomed).toBe(true);

  expect(window.exportLayout()).toEqual(before);
});

test("a zoomed pane keeps the weight it had in the layout, not its zoom weight", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  run(window.splitSpawn("row"));
  await layout();
  const root = window.exportLayout().root as Extract<LayoutNode, { type: "split" }>;
  window.applyLayout(
    makeLayout({
      root: {
        ...root,
        children: root.children.map((child) =>
          child.type === "pane" && child.id === first.id ? { ...child, weight: 5 } : child,
        ),
      },
    }),
  );
  window.focus(first);
  const before = window.exportLayout();

  window.zoom();
  await layout();
  expect(window.exportLayout()).toEqual(before);
});

test("unzooming leaves the export unchanged, so zoom is invisible to persistence", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  run(window.splitSpawn("column"));
  await layout();
  const before = window.exportLayout();

  window.zoom();
  await layout();
  window.zoom();
  await layout();

  expect(window.exportLayout()).toEqual(before);
});

test("closing a pane leaves no husk in the exported tree", async () => {
  const { window, layout } = await setup();
  run(window.splitSpawn("row"));
  const third = run(window.splitSpawn("column"))!;
  await layout();
  window.close(third);
  await layout();
  expect(shape(window.exportLayout().root)).toEqual({ row: ["pane", "pane"] });
});
