/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { Prompt } from "./Prompt.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/**
 * Tab moves focus between fields.
 *
 * The textarea renderable ships no tab binding, so without a handler in the
 * Prompt an unbound tab is dropped before it reaches the app — the footer's
 * "⇥ field" hint lies. Type into the first field, tab, and type into the
 * second; the second keystroke must land in the second field.
 */
test("tab moves focus to the next field", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Test prompt",
          fields: [
            { label: "Name", value: "" },
            { label: "Directory", value: "" },
          ],
          resolve: (values) => {
            resolved = values;
          },
        }}
        width={80}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();

  t.mockInput.pressKey("a");
  await t.renderOnce();
  t.mockInput.pressTab();
  await t.renderOnce();
  t.mockInput.pressKey("b");
  await t.renderOnce();

  // Enter on the second (last) field resolves the whole form.
  t.mockInput.pressEnter();
  await t.renderOnce();

  expect(resolved).toEqual(["a", "b"]);
});

/** The footer advertises "⇥ field"; the field order wraps on tab from the last. */
test("tab on the last field wraps to the first", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Test prompt",
          fields: [{ label: "Only", value: "" }],
          resolve: (values) => {
            resolved = values;
          },
        }}
        width={80}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();

  // With one field, tab from it wraps back to itself — no crash, still focused.
  t.mockInput.pressTab();
  await t.renderOnce();
  t.mockInput.pressKey("z");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await t.renderOnce();

  expect(resolved).toEqual(["z"]);
});
