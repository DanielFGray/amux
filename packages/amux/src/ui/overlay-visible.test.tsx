/** @effect-diagnostics *:skip-file -- plain-async Solid/opentui render tree. */
/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "./App.tsx";
import { testSlots } from "./test-slots.ts";

const WIDTH = 40;
const HEIGHT = 12;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

test("overlay that starts hidden paints when its visible signal flips (no remount)", async () => {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  cleanup.push(() => t.renderer.destroy());
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
  const { slots, owner } = testSlots(t.renderer);
  const [open, setOpen] = createSignal(false);

  slots.register(
    owner,
    "overlay",
    {
      id: "test.picker",
      title: "picker",
      visible: open,
      component: () => (
        <box
          style={{ position: "absolute", left: 2, top: 1, width: 24, height: 4, border: true }}
          title=" find files "
        >
          <text>No matches.</text>
        </box>
      ),
    },
    15,
  );

  // Mount once — the live app does not remount App when an overlay opens.
  await render(
    () => <App slots={slots} paneHost={paneHost} size={{ width: WIDTH, height: HEIGHT }} />,
    t.renderer,
  );
  await t.renderOnce();
  expect(slots.topOverlay()).toBeNull();
  expect(t.captureCharFrame()).not.toContain("find files");

  setOpen(true);
  await t.renderOnce();
  await t.renderOnce();

  expect(slots.topOverlay()?.id).toBe("test.picker");
  const frame = t.captureCharFrame();
  console.log(frame);
  expect(frame.includes("find files") || frame.includes("No matches")).toBe(true);
});

test("overlay registered after App mount paints when opened", async () => {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  cleanup.push(() => t.renderer.destroy());
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
  const { slots, owner } = testSlots(t.renderer);

  await render(
    () => <App slots={slots} paneHost={paneHost} size={{ width: WIDTH, height: HEIGHT }} />,
    t.renderer,
  );
  await t.renderOnce();

  const [open, setOpen] = createSignal(false);
  slots.register(
    owner,
    "overlay",
    {
      id: "test.late-picker",
      title: "picker",
      visible: open,
      component: () => (
        <box
          style={{ position: "absolute", left: 2, top: 1, width: 24, height: 4, border: true }}
          title=" find files "
        >
          <text>No matches.</text>
        </box>
      ),
    },
    15,
  );
  await t.renderOnce();
  expect(slots.topOverlay()).toBeNull();

  setOpen(true);
  await t.renderOnce();
  await t.renderOnce();
  expect(slots.topOverlay()?.id).toBe("test.late-picker");
  const frame = t.captureCharFrame();
  console.log("--- late ---\n" + frame);
  expect(frame.includes("find files") || frame.includes("No matches")).toBe(true);
});

test("overlay that starts visible paints (control)", async () => {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  cleanup.push(() => t.renderer.destroy());
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
  const { slots, owner } = testSlots(t.renderer);

  slots.register(
    owner,
    "overlay",
    {
      id: "test.picker",
      title: "picker",
      visible: () => true,
      component: () => (
        <box
          style={{ position: "absolute", left: 2, top: 1, width: 24, height: 4, border: true }}
          title=" find files "
        >
          <text>No matches.</text>
        </box>
      ),
    },
    15,
  );

  await render(
    () => <App slots={slots} paneHost={paneHost} size={{ width: WIDTH, height: HEIGHT }} />,
    t.renderer,
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame.includes("find files") || frame.includes("No matches")).toBe(true);
});
