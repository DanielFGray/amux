/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { BufferChoose, type BufferChooseView } from "./BufferChoose.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Mount the picker and return the drawn frame. */
async function frame(view: BufferChooseView, width = 80, height = 20) {
  const t = await createTestRenderer({ width, height });
  cleanup.push(() => t.renderer.destroy());
  await render(() => <BufferChoose view={view} width={width} height={height} />, t.renderer);
  await t.renderOnce();
  return t.captureCharFrame();
}

const view = (over: Partial<BufferChooseView> = {}): BufferChooseView => ({
  buffers: [
    { name: "1", bytes: 5, preview: "gamma" },
    { name: "0", bytes: 11, preview: "alpha" },
  ],
  selected: 0,
  onPaste: () => {},
  onDelete: () => {},
  onClose: () => {},
  ...over,
});

test("the picker lists the server-side stack with name, size and preview", async () => {
  const f = await frame(view());
  expect(f).toContain("choose buffer");
  expect(f).toContain("1");
  expect(f).toContain("5 b");
  expect(f).toContain("gamma");
  expect(f).toContain("0");
  expect(f).toContain("alpha");
  expect(f).toContain("enter paste · d delete · esc close");
});

test("an empty stack says so instead of drawing a blank list", async () => {
  const f = await frame(view({ buffers: [] }));
  expect(f).toContain("no buffers — copy something first");
  expect(f).not.toContain("gamma");
});

test("an empty buffer's preview reads as empty rather than blank", async () => {
  const f = await frame(view({ buffers: [{ name: "0", bytes: 0, preview: "" }], selected: 0 }));
  expect(f).toContain("(empty)");
});
