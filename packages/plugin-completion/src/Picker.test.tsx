/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree. See packages/amux/src/harness.ts. */
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { InlinePicker, ModalPicker, modalPickerWidth, pickerWindow } from "./Picker.tsx";
import type { CompletionItem } from "./types.ts";

const items: readonly CompletionItem[] = [
  { id: "edit", label: ":edit", detail: "open a file", replacement: ":edit " },
  { id: "write", label: ":write", detail: "save the file", replacement: ":write" },
];

describe("picker presentations", () => {
  test("pickerWindow keeps the selection on-screen and caps height", () => {
    expect(pickerWindow(20, 0)).toEqual({ start: 0, end: 6 });
    expect(pickerWindow(20, 5)).toEqual({ start: 0, end: 6 });
    expect(pickerWindow(20, 6)).toEqual({ start: 1, end: 7 });
    expect(pickerWindow(20, 19)).toEqual({ start: 14, end: 20 });
    expect(pickerWindow(3, 1)).toEqual({ start: 0, end: 3 });
  });

  test("the inline popup lists every option with its detail", async () => {
    const t = await createTestRenderer({ width: 60, height: 12 });
    try {
      await render(
        () => (
          <InlinePicker
            items={items}
            selected={0}
            onSelect={() => {}}
            onSelectedChange={() => {}}
          />
        ),
        t.renderer,
      );
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain(":edit");
      expect(frame).toContain("open a file");
      expect(frame).toContain(":write");
    } finally {
      t.renderer.destroy();
    }
  });

  test("a long inline list stays inside its border (does not paint past max height)", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      label: `:cmd${i}`,
      detail: `detail ${i}`,
      replacement: `:cmd${i}`,
    }));
    const t = await createTestRenderer({ width: 60, height: 14 });
    try {
      await render(
        () => (
          <box style={{ flexDirection: "column", height: 14 }}>
            <InlinePicker
              items={many}
              selected={0}
              onSelect={() => {}}
              onSelectedChange={() => {}}
            />
            <text style={{ height: 1 }}>PROMPT_ANCHOR</text>
          </box>
        ),
        t.renderer,
      );
      await t.renderOnce();
      const frame = t.captureCharFrame();
      const lines = frame.split("\n");
      // Cap is 8 rows including border — items past the viewport must not
      // overwrite the prompt row that sits below the picker.
      expect(frame).toContain("PROMPT_ANCHOR");
      const promptAt = lines.findIndex((l) => l.includes("PROMPT_ANCHOR"));
      expect(promptAt).toBeGreaterThanOrEqual(0);
      expect(promptAt).toBeLessThanOrEqual(9);
      expect(frame).not.toContain(":cmd19");
    } finally {
      t.renderer.destroy();
    }
  });

  test("the modal shows its title, filter, rows, and hint", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      await render(
        () => (
          <ModalPicker
            view={{ allEntries: items, entries: items, query: "", selected: 1 }}
            width={90}
            title=" pick a command "
            filterPlaceholder="filter commands"
            onInput={() => {}}
            onPick={() => {}}
            onSubmit={() => {}}
          />
        ),
        t.renderer,
      );
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain("pick a command");
      expect(frame).toContain("filter commands");
      expect(frame).toContain(":edit");
      expect(frame).toContain("↑↓ select · enter choose · esc close");
      expect(frame).not.toContain("preview body");
    } finally {
      t.renderer.destroy();
    }
  });

  test("modal preview pane updates with the selected row", async () => {
    const t = await createTestRenderer({ width: 110, height: 24 });
    try {
      await render(
        () => (
          <ModalPicker
            view={{ allEntries: items, entries: items, query: "", selected: 0 }}
            width={110}
            title=" pick "
            filterPlaceholder="filter"
            onInput={() => {}}
            onPick={() => {}}
            onSubmit={() => {}}
            preview={{
              position: "right",
              title: " preview ",
              onPreview: (item) => `preview body for ${item.id}`,
            }}
          />
        ),
        t.renderer,
      );
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain("preview body for edit");
      expect(frame).toContain(":edit");
    } finally {
      t.renderer.destroy();
    }
  });

  test("modalPickerWidth grows when preview is on", () => {
    expect(modalPickerWidth(120, false)).toBe(78);
    expect(modalPickerWidth(120, true)).toBe(100);
    expect(modalPickerWidth(50, true)).toBe(48);
  });
});
