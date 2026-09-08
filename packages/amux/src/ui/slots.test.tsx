/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ValidComponent } from "solid-js";
import { App } from "./App.tsx";
import {
  createSlotRegistry,
  SlotConflictError,
  type SlotRegistry,
  type DockOccupant,
  type FloatOccupant,
  type OverlayOccupant,
  type Slots,
} from "./slots.ts";
import { testSlots } from "./test-slots.ts";
import { createPluginContributions } from "../plugin/contributions.ts";

const WIDTH = 24;
const HEIGHT = 6;
const LEFT = 6;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Regions with the owner already applied: no check here is about who owns a
 *  panel, only about where it lands. */
type LegacyPanel =
  | ({
      region: "top" | "bottom" | "left" | "right";
      anchor: "app" | "center";
      order?: number;
    } & DockOccupant)
  | ({ region: "overlay" | "float"; order?: number } & (OverlayOccupant | FloatOccupant));
type DockedSlots = Omit<Slots, "register"> & { register: (panel: LegacyPanel) => () => void };

/** A renderer with the region layout mounted on it, and nothing docked yet. */
async function mount() {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
  const { slots, owner } = testSlots(t.renderer);
  cleanup.push(() => t.renderer.destroy());
  return {
    slots: {
      ...slots,
      register: (panel: LegacyPanel) => {
        const slot =
          panel.region === "overlay"
            ? "overlay"
            : panel.region === "float"
              ? "float"
              : `${panel.region}.${(panel as { anchor: "app" | "center" }).anchor}`;
        const {
          region: _region,
          anchor: _anchor,
          order,
          ...occupant
        } = panel as LegacyPanel & { anchor?: string };
        return slots.register(owner, slot as never, occupant as never, order);
      },
    },
    async draw() {
      await render(
        () => <App slots={slots} paneHost={paneHost} size={{ width: WIDTH, height: HEIGHT }} />,
        t.renderer,
      );
      await t.renderOnce();
      await t.renderOnce();
      return t.captureCharFrame().split("\n");
    },
  };
}

/** A panel that paints one row of its dock, so a row says where it starts and
 *  panels stacked in the same dock stay told apart. */
const filled = (char: string) => () => (
  <text style={{ width: "100%", height: 1 }}>{char.repeat(WIDTH)}</text>
);

function leftDock(slots: DockedSlots, size = () => LEFT) {
  slots.register({
    id: "test.left",
    region: "left",
    anchor: "app",
    size,
    component: filled("L"),
  });
}

test("a top dock anchored to the app spans the left dock as well", async () => {
  const { slots, draw } = await mount();
  leftDock(slots);
  slots.register({
    id: "test.bar",
    region: "top",
    anchor: "app",
    size: () => 1,
    component: filled("T"),
  });

  const rows = await draw();
  expect(rows[0]!.slice(0, 3)).toBe("TTT");
  // The left dock starts under it, not beside it.
  expect(rows[1]!.slice(0, LEFT)).toBe("L".repeat(LEFT));
});

test("a top dock anchored to the centre sits beside the left dock instead", async () => {
  const { slots, draw } = await mount();
  leftDock(slots);
  slots.register({
    id: "test.tabs",
    region: "top",
    anchor: "center",
    size: () => 1,
    component: filled("T"),
  });

  const rows = await draw();
  // The row the tab bar is on belongs to the left dock up to its width, and to
  // the tab bar after it. This is the whole reason a dock declares an anchor:
  // the same "top, height 1" panel lands in a different place.
  expect(rows[0]!.slice(0, LEFT)).toBe("L".repeat(LEFT));
  expect(rows[0]![LEFT]).toBe("T");
});

test("a dock is as thick as its thickest visible panel", async () => {
  const { slots, draw } = await mount();
  const [wide, setWide] = createSignal(false);
  leftDock(slots);
  slots.register({
    id: "test.left-wide",
    region: "left",
    anchor: "app",
    // Registered throughout, so the dock keeps its box while the panel is away.
    visible: wide,
    size: () => LEFT * 2,
    component: filled("W"),
  });

  const rows = await draw();
  expect(rows[0]!.slice(0, LEFT)).toBe("L".repeat(LEFT));
  expect(rows[0]![LEFT]).not.toBe("L");

  setWide(true);
  const grown = await draw();
  // Both panels are as wide as the dock now, whichever of them asked for it.
  expect(grown[0]!.slice(0, LEFT * 2)).toBe("L".repeat(LEFT * 2));
  expect(grown[1]!.slice(0, LEFT * 2)).toBe("W".repeat(LEFT * 2));
});

test("the topmost overlay draws over an overlay opened earlier", async () => {
  const { slots } = await mount();
  const [prompt, setPrompt] = createSignal(false);

  slots.register({
    id: "test.settings",
    region: "overlay",
    order: 10,
    component: filled("S"),
  });
  slots.register({
    id: "test.prompt",
    region: "overlay",
    order: 40,
    visible: prompt,
    component: filled("P"),
  });

  expect(slots.topOverlay()?.id).toBe("test.settings");
  setPrompt(true);
  // Opened last and ordered highest, so it draws over the settings window —
  // key resolution now lives in the contexts model (key-context.test.ts),
  // not here.
  expect(slots.topOverlay()?.id).toBe("test.prompt");
});

test("an overlay that is not up is not the top overlay", async () => {
  const { slots } = await mount();
  slots.register({
    id: "test.closed",
    region: "overlay",
    visible: () => false,
    component: filled("C"),
  });

  expect(slots.topOverlay()).toBeNull();
});

test("a panel that throws does not take the rest of the screen with it", async () => {
  const { slots, draw } = await mount();

  leftDock(slots);
  slots.register({
    id: "test.broken",
    region: "left",
    anchor: "app",
    size: () => LEFT,
    component: () => {
      throw new Error("panel is broken");
    },
  });

  const rows = await draw();
  expect(rows[0]!.slice(0, LEFT)).toBe("L".repeat(LEFT));
});

test("a same-priority single-slot collision names the existing occupant", async () => {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  cleanup.push(() => t.renderer.destroy());
  const registry = createSlotRegistry(t.renderer, createPluginContributions());
  const owner = { id: "test.slot", generation: 1 };
  registry.declare(owner, { name: "single", kind: "single" });
  registry.register(owner, { slot: "single", priority: 10, content: "first" });
  expect(() =>
    registry.register(
      { id: "other.slot", generation: 1 },
      { slot: "single", priority: 10, content: "second" },
    ),
  ).toThrow(SlotConflictError);
  expect(registry.resolve<string>("single")).toEqual(["first"]);
});

test("a single slot replaces its native winner and promotes the loser", async () => {
  const t = await createTestRenderer({ width: 24, height: 2 });
  cleanup.push(() => t.renderer.destroy());
  const registry = createSlotRegistry(t.renderer, createPluginContributions());
  const owner = { id: "test.slot", generation: 1 };
  registry.declare(owner, { name: "single", kind: "single" });
  const native = Reflect.get(registry, "_native") as {
    resolveEntries: (name: string) => readonly { id: string }[];
  };
  const first = registry.register(owner, {
    slot: "single",
    priority: 10,
    content: () => <text>first</text>,
  });
  const second = registry.register(
    { id: "other.slot", generation: 1 },
    { slot: "single", priority: 20, content: () => <text>second</text> },
  );
  const initialEntries = native.resolveEntries("single");
  expect(initialEntries).toHaveLength(1);
  expect(initialEntries[0]?.id).toContain("test.slot");
  first();
  const promotedEntries = native.resolveEntries("single");
  expect(promotedEntries).toHaveLength(1);
  expect(promotedEntries[0]?.id).toContain("other.slot");
  second();
});

test("a disposed entry ID is never reused by another registration", async () => {
  const t = await createTestRenderer({ width: 24, height: 2 });
  cleanup.push(() => t.renderer.destroy());
  const registry = createSlotRegistry(t.renderer, createPluginContributions());
  const owner = { id: "test.slot", generation: 1 };
  registry.declare(owner, { name: "list", kind: "list" });
  const native = Reflect.get(registry, "_native") as {
    resolveEntries: (name: string) => readonly { id: string }[];
  };
  const first = registry.register(owner, { slot: "list", priority: 0, content: "first" });
  const second = registry.register(owner, { slot: "list", priority: 1, content: "second" });
  first();
  const third = registry.register(owner, { slot: "list", priority: 2, content: "third" });
  const withSecondAndThird = native.resolveEntries("list");
  expect(withSecondAndThird).toHaveLength(2);
  expect(new Set(withSecondAndThird.map((entry) => entry.id)).size).toBe(2);
  second();
  const withThirdOnly = native.resolveEntries("list");
  expect(withThirdOnly).toHaveLength(1);
  expect(withThirdOnly[0]?.id).toBe(withSecondAndThird[1]?.id);
  third();
});

test("disposing a list entry retracts only its own declared children", async () => {
  const t = await createTestRenderer({ width: 24, height: 2 });
  cleanup.push(() => t.renderer.destroy());
  const registry = createSlotRegistry(t.renderer, createPluginContributions());
  const owner = { id: "test.slot", generation: 1 };
  registry.declare(owner, { name: "list", kind: "list" });
  const first = registry.register(owner, {
    slot: "list",
    priority: 0,
    content: "first",
    children: [{ name: "child.first", kind: "list" }],
  });
  const second = registry.register(owner, {
    slot: "list",
    priority: 1,
    content: "second",
    children: [{ name: "child.second", kind: "list" }],
  });
  // The disposed entry is not the first in order: with no election on a
  // list-kind slot, its children still go with it — they must not leak.
  second();
  expect(registry.resolve<string>("list")).toEqual(["first"]);
  expect(() =>
    registry.register(owner, { slot: "child.second", priority: 0, content: "orphan" }),
  ).toThrow();
  // The sibling's subtree is untouched by the disposal.
  registry.register(owner, { slot: "child.first", priority: 0, content: "still here" });
  expect(registry.resolve<string>("child.first")).toEqual(["still here"]);
  first();
});

test("snapshot nests declared children with entries and the elected chain winner", async () => {
  const t = await createTestRenderer({ width: 24, height: 2 });
  cleanup.push(() => t.renderer.destroy());
  const registry = createSlotRegistry(t.renderer, createPluginContributions());
  const owner = { id: "test.slot", generation: 1 };
  registry.declare(owner, { name: "chain", kind: "chain" });
  registry.register(owner, {
    slot: "chain",
    priority: 1,
    selector: () => false,
    content: "loser",
    children: [{ name: "loser.child", kind: "list" }],
  });
  registry.register(owner, {
    slot: "chain",
    priority: 0,
    selector: () => true,
    content: "winner",
    children: [{ name: "winner.child", kind: "list" }],
  });

  const tree = registry.snapshot();
  const chain = tree.find((node) => node.name === "chain")!;
  expect(chain.kind).toBe("chain");
  expect(chain.entries).toHaveLength(2);
  const winner = chain.entries.find((entry) => entry.elected)!;
  expect(chain.elected).toBe(winner.id);
  expect(winner.owner).toBe("test.slot");
  expect(chain.entries.filter((entry) => entry.elected)).toHaveLength(1);
  // Only the elected entry's children are live: the loser's never exist.
  expect(chain.children.map((child) => child.name)).toEqual(["winner.child"]);
  expect(JSON.stringify(tree)).not.toContain("loser.child");
  expect(tree.find((node) => node.name === "root")).toBeDefined();
});

test("a higher-priority root candidate renders instead of the built-in frame", async () => {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  cleanup.push(() => t.renderer.destroy());
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
  const { slots } = testSlots(t.renderer);
  const registry = Reflect.get(slots, "_registry") as SlotRegistry;
  registry.register(
    { id: "test.frame", generation: 1 },
    {
      slot: "root",
      priority: 0,
      selector: () => true,
      content: () => <text>alternate frame</text>,
    },
  );
  await render(
    () => (
      <Dynamic
        component={slots.Slot as ValidComponent}
        name="root"
        mode="replace"
        slots={slots}
        paneHost={paneHost}
        size={{ width: WIDTH, height: HEIGHT }}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("alternate frame");
});
