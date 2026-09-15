/** @effect-diagnostics *:skip-file */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import { createBindings, nextKeys, pendingStrokes } from "./bindings.ts";
import { KeyInvocation } from "./key-invocation.ts";
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

test("chord feed accumulates count while prefix ctrl+w is pending", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    let seen: number | undefined;
    const bindings = createBindings(
      t.renderer,
      [
        {
          name: "pane.window-width",
          key: "<prefix>ctrl+w|",
          desc: "set width",
          group: "window",
          run: Effect.gen(function* () {
            const inv = yield* KeyInvocation;
            seen = inv.data.count;
          }),
        },
      ],
      {
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        onUnhandled: () => true,
        timeoutlenMs: 5000,
      },
    );
    bindings.chords.registerMode({
      id: "amux.window",
      strokes: ["<prefix>", "ctrl+w"],
    });

    t.mockInput.pressKey("s", { ctrl: true });
    await Bun.sleep(10);
    expect(bindings.chords.pending()).toEqual(["<prefix>"]);
    t.mockInput.pressKey("w", { ctrl: true });
    await Bun.sleep(10);
    expect(bindings.chords.pending()).toEqual(["<prefix>", "ctrl+w"]);
    expect(bindings.chords.activeMode()?.id).toBe("amux.window");
    expect(
      nextKeys(
        bindings,
        bindings.commands(),
        [],
        [{ display: "<prefix>" }, { display: "ctrl+w" }],
      ).flatMap((g) => g.entries.map((e) => e.keys.join(""))),
    ).toContain("|");

    t.mockInput.pressKey("8");
    t.mockInput.pressKey("0");
    await Bun.sleep(10);
    expect(pendingStrokes(bindings.pending, "count").join("")).toBe("80");
    expect(bindings.chords.pending()).toEqual(["<prefix>", "ctrl+w"]);

    t.mockInput.pressKey("|");
    await Bun.sleep(10);
    expect(seen).toBe(80);
    // Sticky minimode: still in window mode after the command.
    expect(bindings.chords.pending()).toEqual(["<prefix>", "ctrl+w"]);
    expect(bindings.chords.activeMode()?.id).toBe("amux.window");
    expect(pendingStrokes(bindings.pending, "count").join("")).toBe("");
  } finally {
    t.renderer.destroy();
  }
});

test("window minimode stays armed for a second command until Escape", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const bindings = createBindings(
      t.renderer,
      [
        {
          name: "pane.window-focus-left",
          key: "<prefix>ctrl+wh",
          desc: "focus left",
          group: "window",
          run: Effect.sync(() => void fired.push("h")),
        },
        {
          name: "pane.window-focus-right",
          key: "<prefix>ctrl+wl",
          desc: "focus right",
          group: "window",
          run: Effect.sync(() => void fired.push("l")),
        },
      ],
      {
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        onUnhandled: () => true,
        timeoutlenMs: 5000,
      },
    );
    bindings.chords.registerMode({
      id: "amux.window",
      strokes: ["<prefix>", "ctrl+w"],
    });

    t.mockInput.pressKey("s", { ctrl: true });
    t.mockInput.pressKey("w", { ctrl: true });
    await Bun.sleep(10);
    t.mockInput.pressKey("h");
    await Bun.sleep(10);
    t.mockInput.pressKey("l");
    await Bun.sleep(10);
    expect(fired).toEqual(["h", "l"]);
    expect(bindings.chords.activeMode()?.id).toBe("amux.window");

    // ChordMatcher escape exit (OpenTUI's escape-clears-pending may swallow the
    // physical key before the chord feed — the matcher is the authority).
    expect(bindings.chords.push("escape")).toEqual({ _tag: "miss" });
    expect(bindings.chords.pending()).toEqual([]);
    expect(bindings.chords.activeMode()).toBeNull();
  } finally {
    t.renderer.destroy();
  }
});
