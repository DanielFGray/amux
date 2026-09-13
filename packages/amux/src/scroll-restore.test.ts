/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree. See harness.ts. */
import { expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { Effect, Layer } from "effect";
import { niriTilingMethods } from "../../plugin-niri/src/niri.ts";
import { project } from "./harness.ts";
import {
  decodeLayout,
  encodeLayout,
  makeLayout,
  windowState,
  type LayoutPane,
  type PaneRef,
} from "./layout.ts";
import { registerLayoutKindRenderer } from "./layout-kinds.ts";
import { testEffect } from "./test-effect.ts";

const { live } = testEffect(Layer.empty);

const ref = (id: string): PaneRef => ({
  id,
  content: { kind: "pty", session: id },
});

const leaf = (id: string): LayoutPane => ({
  type: "pane",
  id,
  content: { kind: "pty", session: id },
  weight: 1,
});

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);

test("a multi-column niri scroll root round-trips through encode and decode", () => {
  const original = makeLayout({
    ...niriTilingMethods.init([ref("a"), ref("b"), ref("c")], { cols: 80, rows: 24 }),
    algorithmId: "niri",
    algorithmVersion: 1,
  });
  expect(original.root?.type).toBe("container");
  const decoded = run(decodeLayout(encodeLayout(original)));
  expect(decoded).toEqual(original);
  expect(decoded.algorithmId).toBe("niri");
});

live("a scroll container without its renderer still places columns side by side", () =>
  Effect.gen(function* () {
    // No registerLayoutKindRenderer — Window falls back to a row flex box.
    // Before the remount-after-plugin-load fix, Yoga's default column stacked
    // these as rows; detach/reattach then looked like a vertical split.
    const layout = niriTilingMethods.init([ref("a"), ref("b")], { cols: 80, rows: 24 });
    const scene = yield* project(layout, { width: 80, height: 24 });
    yield* scene.renderOnce();

    const [left, right] = scene.window.panes;
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left!.y).toBe(right!.y);
    expect(left!.x).toBeLessThan(right!.x);
  }),
);

live("remounting after the scroll renderer registers keeps columns side by side", () =>
  Effect.gen(function* () {
    const layout = niriTilingMethods.init([ref("a"), ref("b")], { cols: 80, rows: 24 });
    const scene = yield* project(layout, { width: 80, height: 24 });
    yield* scene.renderOnce();

    // Minimal stand-in for plugin-niri's scroll renderer: row strip.
    yield* registerLayoutKindRenderer("scroll", {
      render(ctx, _node, children) {
        const box = new BoxRenderable(ctx, { flexDirection: "row", flexGrow: 1 });
        for (const child of children) box.add(child);
        return box;
      },
    });

    yield* scene.window.project(layout, { ...windowState(), focus: layout.focus ?? null });
    yield* scene.renderOnce();

    const [left, right] = scene.window.panes;
    expect(left!.y).toBe(right!.y);
    expect(left!.x).toBeLessThan(right!.x);
  }),
);

live("algorithmId survives a Window.project remount", () =>
  Effect.gen(function* () {
    const layout = makeLayout({
      root: {
        type: "container",
        kind: "scroll",
        weight: 1,
        arrangement: { offset: 0, sizes: [40, 40], active: ["a", "b"] },
        children: [leaf("a"), leaf("b")],
      },
      focus: "a",
      algorithmId: "niri",
      algorithmVersion: 1,
    });
    const scene = yield* project(layout, { width: 80, height: 24 });
    expect(scene.window.exportLayout().algorithmId).toBe("niri");
    expect(scene.window.exportLayout().algorithmVersion).toBe(1);
  }),
);
