/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree. */
/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { ErrorSnack, snackWidth, truncateSnackMessage } from "./ErrorSnack.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function frame(message: string, width = 80, height = 20) {
  const t = await createTestRenderer({ width, height });
  cleanup.push(() => t.renderer.destroy());
  await render(
    () => (
      <ErrorSnack
        message={message}
        left={0}
        width={width}
        onClose={() => {}}
        onShowMore={() => {}}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();
  return t.captureCharFrame();
}

test("the snack is narrower than the terminal and names both actions", async () => {
  const f = await frame("could not save settings: permission denied");
  expect(f).toContain("could not save settings");
  expect(f).toContain("close");
  expect(f).toContain("show more");
  // Full-width banners used to paint a red bar across every column; the snack
  // must leave room on the left of a wide terminal.
  const lines = f.split("\n").filter((line) => line.includes("show more"));
  expect(lines.length).toBe(1);
  expect(lines[0]!.trimStart().length).toBeLessThan(80);
});

test("a long message is truncated to the snack width", () => {
  const width = snackWidth(80);
  const long = "x".repeat(200);
  const shown = truncateSnackMessage(long, width);
  expect(shown.endsWith("…")).toBe(true);
  expect(shown.length).toBeLessThanOrEqual(width - 4);
});
