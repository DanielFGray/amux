/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { Capture, type CaptureView } from "./Capture.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Mount the popup and return the drawn frame. */
async function frame(view: CaptureView, width = 80, height = 20) {
  const t = await createTestRenderer({ width, height });
  cleanup.push(() => t.renderer.destroy());
  await render(() => <Capture view={view} width={width} height={height} />, t.renderer);
  await t.renderOnce();
  return t.captureCharFrame();
}

const view = (over: Partial<CaptureView> = {}): CaptureView => ({
  title: "captured pane: shell",
  content: "a\nb",
  path: "/tmp/capture-shell-1.txt",
  span: "visible",
  saved: false,
  onToggleSpan: () => {},
  onSave: () => {},
  onClose: () => {},
  ...over,
});

test("the popup names the target, the span and the save path", async () => {
  const f = await frame(view());
  expect(f).toContain("captured pane: shell");
  expect(f).toContain("2 rows · visible · will save to /tmp/capture-shell-1.txt");
  expect(f).toContain("s saves · f toggles span · esc discards");
});

test("the scrollback span is named as such", async () => {
  const f = await frame(view({ span: "scrollback", content: "a\nb\nc" }));
  expect(f).toContain("scrollback");
  expect(f).toContain("3 rows");
});

test("an empty capture reports zero rows, not a blank line", async () => {
  const f = await frame(view({ content: "" }));
  expect(f).toContain("0 rows");
});

test("saving swaps the footer for the written confirmation", async () => {
  const f = await frame(view({ saved: true }));
  expect(f).toContain("saved 2 rows to /tmp/capture-shell-1.txt");
  expect(f).toContain("esc closes");
  expect(f).not.toContain("will save");
});

test("a failed save stays actionable in the popup", async () => {
  const f = await frame(
    view({ error: "could not save capture to /readonly/out.txt: permission denied" }),
  );
  expect(f).toContain("could not save capture");
  expect(f).toContain("permission denied");
  expect(f).toContain("s saves");
  expect(f).not.toContain("saved 2 rows");
});
