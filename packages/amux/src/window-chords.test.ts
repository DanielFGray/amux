/** @effect-diagnostics *:skip-file */
import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { Effect } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createBindings,
  contextCommand,
  nextKeys,
  pendingStrokes,
  pendingStrokeDisplay,
} from "./bindings.ts";
import { CONTEXT_PRIORITY, type ContextSpec } from "./key-context.ts";
import { KeyInvocation, createCountAccumulator } from "./key-invocation.ts";
import { setPaneSize, computeRects } from "./geometry.ts";
import { LAYOUT_VERSION, type Layout, type LayoutNode } from "./layout.ts";

const pane = (id: string, weight = 1): LayoutNode => ({
  type: "pane",
  id,
  content: { kind: "pty", session: id },
  weight,
});
const split = (direction: "row" | "column", children: LayoutNode[]): LayoutNode => ({
  type: "split",
  direction,
  weight: 1,
  children,
});
const layoutOf = (root: LayoutNode): Layout => ({
  version: LAYOUT_VERSION,
  root,
  floats: [],
});

const pendingDisplays = (bindings: ReturnType<typeof createBindings>) =>
  bindings.keymap.getPendingSequence().map(pendingStrokeDisplay);

/**
 * Window sticky mode: bare keys on the mode context; entry is the only
 * `<prefix>ctrl+w` binding so it fires without waiting on longer chords.
 */
const windowModeFixture = (bindings: ReturnType<typeof createBindings>) => {
  const [windowMode, setWindowMode] = createSignal(false);
  const windowCount = createCountAccumulator();
  const entry: ContextSpec = {
    id: "amux.window.entry",
    active: () => !windowMode(),
    priority: CONTEXT_PRIORITY.APP_MODE,
    rebindable: false,
  };
  const mode: ContextSpec = {
    id: "amux.window",
    active: windowMode,
    priority: CONTEXT_PRIORITY.APP_MODE,
    rebindable: true,
    beforeDispatch: (input) => {
      if (windowCount.offer(input.event, input.bound)) {
        input.notifyPending();
        input.consume({ preventDefault: true });
        input.event.preventDefault();
        return;
      }
      if (windowCount.digits() !== "") input.setData("count", windowCount.count());
    },
    handle: () => true,
  };
  const disposeGrammar = bindings.pending.register({
    id: "amux.window.grammar",
    role: "grammar",
    strokes: () => {
      if (!windowMode()) return [];
      const digits = windowCount.digits();
      return digits === "" ? [] : [digits];
    },
  });
  const wrap = (spec: Parameters<typeof contextCommand>[1]) =>
    contextCommand(mode, {
      ...spec,
      run: spec.run.pipe(Effect.ensuring(Effect.sync(() => windowCount.reset()))),
    });
  return {
    windowMode,
    entry,
    mode,
    disposeGrammar,
    enter: contextCommand(entry, {
      name: "window.mode",
      key: "<prefix>ctrl+w",
      desc: "window mode",
      group: "window",
      run: Effect.sync(() => setWindowMode(true)),
    }),
    leave: wrap({
      name: "window.mode.leave",
      key: "escape",
      desc: "leave window mode",
      group: "window",
      hidden: true,
      run: Effect.sync(() => setWindowMode(false)),
    }),
    wrap,
  };
};

test("setPaneSize widens a tiled pane to an absolute column count", () => {
  const before = layoutOf(split("row", [pane("a"), pane("b")]));
  const size = { cols: 40, rows: 10 };
  const after = setPaneSize(before, size, "a", "cols", 10);
  const rects = computeRects(after, size);
  expect(rects.get("a")!.width).toBe(10);
});

test("setPaneSize with null cells maximizes a float on that axis", () => {
  const before: Layout = {
    version: LAYOUT_VERSION,
    root: pane("tiled"),
    floats: [
      {
        id: "floated",
        content: { kind: "pty", session: "sf" },
        x: 0.25,
        y: 0.25,
        width: 0.25,
        height: 0.25,
      },
    ],
  };
  const size = { cols: 40, rows: 20 };
  const after = setPaneSize(before, size, "floated", "cols", null);
  expect(after.floats[0]!.width).toBe(1);
  expect(after.floats[0]!.x).toBe(0);
});

test("window mode arms at once; count 80| shows in showcmd then clears", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    let seen: number | undefined;
    const bindings = createBindings(t.renderer, [], {
      keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
      onUnhandled: () => true,
      timeoutlenMs: 5000,
    });
    const { windowMode, enter, leave, wrap, mode, disposeGrammar } = windowModeFixture(bindings);
    bindings.setCommands([
      enter,
      leave,
      wrap({
        name: "pane.window-width",
        key: "|",
        desc: "set width",
        group: "window",
        run: Effect.gen(function* () {
          const inv = yield* KeyInvocation;
          seen = inv.data.count;
        }),
      }),
    ]);

    t.mockInput.pressKey("s", { ctrl: true });
    await Bun.sleep(10);
    expect(pendingDisplays(bindings)).toEqual(["<prefix>"]);
    t.mockInput.pressKey("w", { ctrl: true });
    await Bun.sleep(10);
    expect(windowMode()).toBe(true);
    expect(pendingDisplays(bindings)).toEqual([]);
    expect(
      nextKeys(bindings, bindings.commands(), [mode], []).flatMap((g) =>
        g.entries.map((e) => e.keys.join("")),
      ),
    ).toContain("|");

    t.mockInput.pressKey("8");
    t.mockInput.pressKey("0");
    await Bun.sleep(10);
    expect(pendingStrokes(bindings.pending, "grammar").join("")).toBe("80");

    t.mockInput.pressKey("|");
    await Bun.sleep(10);
    expect(seen).toBe(80);
    expect(pendingDisplays(bindings)).toEqual([]);
    expect(pendingStrokes(bindings.pending, "grammar")).toEqual([]);
    expect(windowMode()).toBe(true);
    disposeGrammar();
  } finally {
    t.renderer.destroy();
  }
});

test("window sticky mode stays armed for a second command until Escape", async () => {
  const t = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true });
  try {
    const fired: string[] = [];
    const bindings = createBindings(t.renderer, [], {
      keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
      onUnhandled: () => true,
      timeoutlenMs: 5000,
    });
    const { windowMode, enter, leave, wrap, disposeGrammar } = windowModeFixture(bindings);
    bindings.setCommands([
      enter,
      leave,
      wrap({
        name: "pane.window-focus-left",
        key: "h",
        desc: "focus left",
        group: "window",
        run: Effect.sync(() => void fired.push("h")),
      }),
      wrap({
        name: "pane.window-focus-right",
        key: "l",
        desc: "focus right",
        group: "window",
        run: Effect.sync(() => void fired.push("l")),
      }),
    ]);

    t.mockInput.pressKey("s", { ctrl: true });
    t.mockInput.pressKey("w", { ctrl: true });
    await Bun.sleep(10);
    expect(windowMode()).toBe(true);
    t.mockInput.pressKey("h");
    await Bun.sleep(10);
    t.mockInput.pressKey("l");
    await Bun.sleep(10);
    expect(fired).toEqual(["h", "l"]);
    expect(windowMode()).toBe(true);
    expect(pendingDisplays(bindings)).toEqual([]);

    t.mockInput.pressEscape();
    await Bun.sleep(10);
    expect(pendingDisplays(bindings)).toEqual([]);
    expect(windowMode()).toBe(false);
    disposeGrammar();
  } finally {
    t.renderer.destroy();
  }
});
