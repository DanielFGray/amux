/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { KeybindPicker, sortKeybindEntries, type KeybindPickerView } from "./KeybindPicker.tsx";
import type { PaletteEntry } from "../bindings.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

test("sorts unbound actions first without changing their relative order", () => {
  const entries: PaletteEntry[] = [
    { name: "bound.first", group: "test", keys: "^a a", desc: "bound" },
    { name: "free.first", group: "test", keys: "unbound", desc: "free" },
    { name: "free.second", group: "test", keys: "unbound", desc: "free" },
    { name: "bound.second", group: "test", keys: "^a b", desc: "bound" },
  ];

  expect(sortKeybindEntries(entries).map((entry) => entry.name)).toEqual([
    "free.first",
    "free.second",
    "bound.first",
    "bound.second",
  ]);
});

test("selection keeps the action picker row visible", async () => {
  const t = await createTestRenderer({ width: 90, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  const entries = Array.from({ length: 30 }, (_, index) => ({
    name: `command-${index}`,
    group: "test",
    keys: index === 0 ? "^a x" : "unbound",
    desc: `description-${index}`,
  }));
  const [view, setView] = createSignal<KeybindPickerView>({
    entries,
    query: "",
    selected: 0,
    add: true,
    capturing: false,
    error: "",
    available: [],
  });

  await render(
    () => <KeybindPicker view={view()} width={90} onInput={() => {}} onSubmit={() => {}} />,
    t.renderer,
  );
  await t.renderOnce();
  setView((current) => ({ ...current, selected: 20 }));
  await t.renderOnce();

  const frame = t.captureCharFrame();
  expect(frame).toContain("command-20");
  expect(frame).not.toContain("command-0");
});
