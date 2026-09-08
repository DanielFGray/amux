/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { expect, afterEach } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { Effect, Layer } from "effect";
import { project } from "./harness.ts";
import type { TerminalPane } from "./pane.ts";
import { makeLayout } from "./layout.ts";
import { runtime } from "./options.ts";
import { testEffect } from "./test-effect.ts";

const { live } = testEffect(Layer.empty);

const paneLayout = makeLayout({
  root: { type: "pane", id: "pane-1", content: { kind: "pty", session: "s1" }, weight: 1 },
  focus: "pane-1",
});

const origGap = runtime["appearance.gap"];
afterEach(() => {
  runtime["appearance.gap"] = origGap;
});

live("scroll up scrolls the pane's scrollback for a plain shell", () =>
  Effect.gen(function* () {
    const scene = yield* project(paneLayout, { width: 30, height: 8 });
    const pane = scene.window.panes[0]!;
    pane.session!.term.write(new TextEncoder().encode("line1\nline2\nline3\nline4\nline5\n"));

    let scrollCount = 0;
    const originalScrollBy = pane.session!.scrollBy.bind(pane.session);
    pane.session!.scrollBy = (rows: number) => {
      scrollCount += rows;
      originalScrollBy(rows);
    };

    yield* scene.renderOnce();
    yield* Effect.promise(() =>
      scene.t.mockMouse.scroll(
        Math.floor(pane.x + pane.width / 2),
        Math.floor(pane.y + pane.height / 2),
        "up",
      ),
    );
    yield* scene.renderOnce();

    expect(scrollCount).toBe(-3);
    pane.session!.scrollBy = originalScrollBy;
  }),
);

live("coalesces repeated output invalidations until the next frame", () =>
  Effect.gen(function* () {
    const scene = yield* project(paneLayout, { width: 30, height: 8 });
    const pane = scene.window.panes[0] as TerminalPane;
    yield* scene.renderOnce();
    const before = pane.rebuildCount;

    pane.write("input");
    pane.invalidate();
    pane.invalidate();
    pane.invalidate();
    yield* scene.renderOnce();

    expect(pane.rebuildCount - before).toBe(1);
  }),
);

/** The App's own node nesting around the pane area: sidebar | center(tabs, paneArea).
 *  Reproduced to prove a scroll event routed through it still lands in the pane. */
function nestedHost(t: TestRendererSetup): BoxRenderable {
  const outerRow = new BoxRenderable(t.renderer, { flexDirection: "row", flexGrow: 1 });
  const leftSidebar = new BoxRenderable(t.renderer, {
    width: 20,
    height: "100%",
    backgroundColor: "#1e1e2e",
  });
  const center = new BoxRenderable(t.renderer, { flexDirection: "column", flexGrow: 1 });
  const tabs = new BoxRenderable(t.renderer, { height: 1, backgroundColor: "#313244" });
  const paneArea = new BoxRenderable(t.renderer, { flexDirection: "row", flexGrow: 1 });
  const paneHost = new BoxRenderable(t.renderer, { flexDirection: "row", flexGrow: 1 });
  outerRow.add(leftSidebar);
  outerRow.add(center);
  center.add(tabs);
  center.add(paneArea);
  paneArea.add(paneHost);
  t.renderer.root.add(outerRow);
  return paneHost;
}

live("scroll wheel events reach the pane through nested boxes (App layout)", () =>
  Effect.gen(function* () {
    const scene = yield* project(paneLayout, { width: 60, height: 15, host: nestedHost });
    const pane = scene.window.panes[0]!;
    pane.session!.term.write(new TextEncoder().encode("line1\nline2\nline3\nline4\nline5\n"));

    let scrollReached = false;
    const orig = (pane as any).onMouseEvent.bind(pane);
    (pane as any).onMouseEvent = function (this: any, event: any) {
      if (event.type === "scroll") scrollReached = true;
      orig(event);
    };
    yield* scene.renderOnce();
    yield* Effect.promise(() =>
      scene.t.mockMouse.scroll(
        Math.floor(pane.x + pane.width / 2),
        Math.floor(pane.y + pane.height / 2),
        "up",
      ),
    );
    yield* scene.renderOnce();

    expect(scrollReached).toBe(true);
  }),
);

live("scroll events are forwarded to a mouse-reporting child", () =>
  Effect.gen(function* () {
    const scene = yield* project(paneLayout, { width: 30, height: 8 });
    const pane = scene.window.panes[0]!;

    // Enable SGR mouse reporting on the terminal, simulating a full-screen child
    pane.session!.term.write(new TextEncoder().encode("\x1b[?1002h\x1b[?1006h"));
    yield* scene.renderOnce();

    let forwarded = "";
    const originalWrite = pane.session!.write.bind(pane.session);
    pane.session!.write = (data: string | Uint8Array) => {
      forwarded += typeof data === "string" ? data : new TextDecoder().decode(data);
      originalWrite(data);
    };

    yield* Effect.promise(() =>
      scene.t.mockMouse.scroll(
        Math.floor(pane.x + pane.width / 2),
        Math.floor(pane.y + pane.height / 2),
        "up",
      ),
    );
    yield* scene.renderOnce();

    expect(forwarded.length).toBeGreaterThan(0);
    pane.session!.write = originalWrite;
  }),
);

live("renders an OSC title in the top border when gaps are enabled", () =>
  Effect.gen(function* () {
    runtime["appearance.gap"] = true;
    const scene = yield* project(paneLayout, { width: 40, height: 8 });
    const pane = scene.window.panes[0]!;
    pane.session!.term.write(new TextEncoder().encode("\x1b]0;myservice\x07"));
    yield* scene.renderOnce();
    yield* scene.renderOnce();

    const frame = scene.t.captureCharFrame().split("\n");
    const topBorder = frame[pane.y]!;
    expect(topBorder.slice(pane.x, pane.x + pane.width)).toMatch(/┌ myservice ─+┐/);
  }),
);

live("labels the border with the command name when the child sets no OSC title", () =>
  Effect.gen(function* () {
    runtime["appearance.gap"] = true;
    const scene = yield* project(paneLayout, { width: 40, height: 8 });
    const pane = scene.window.panes[0]!;
    yield* scene.renderOnce();
    yield* scene.renderOnce();

    const frame = scene.t.captureCharFrame().split("\n");
    const topBorder = frame[pane.y]!;
    const label = pane.session!.title;
    expect(label).not.toBe("");
    expect(topBorder.slice(pane.x, pane.x + pane.width)).toMatch(new RegExp(`┌ ${label} ─+┐`));
  }),
);

live("no title in the border when gaps are disabled", () =>
  Effect.gen(function* () {
    runtime["appearance.gap"] = false;
    const scene = yield* project(paneLayout, { width: 40, height: 8 });
    const pane = scene.window.panes[0]!;
    pane.session!.term.write(new TextEncoder().encode("\x1b]0;myservice\x07"));
    yield* scene.renderOnce();
    yield* scene.renderOnce();

    const frame = scene.t.captureCharFrame().split("\n");
    const topBorder = frame[pane.y]!;
    expect(topBorder.slice(pane.x, pane.x + pane.width)).not.toMatch(/myservice/);
  }),
);

live("no title when pane is too narrow", () =>
  Effect.gen(function* () {
    runtime["appearance.gap"] = true;
    const scene = yield* project(paneLayout, { width: 13, height: 8 });
    const pane = scene.window.panes[0]!;
    pane.session!.term.write(new TextEncoder().encode("\x1b]0;need14chars\x07"));
    yield* scene.renderOnce();
    yield* scene.renderOnce();

    const frame = scene.t.captureCharFrame().split("\n");
    const topBorder = frame[pane.y]!;
    expect(topBorder.slice(pane.x, pane.x + pane.width)).not.toMatch(/need14chars/);
  }),
);
