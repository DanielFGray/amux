/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { AuthSettings } from "./agent-harness.tsx";
import type { Info as IntegrationInfo } from "./agent-harness/integration.ts";

const providers: readonly IntegrationInfo[] = [
  { id: "openai", label: "OpenAI", methods: [{ type: "key", label: "API key" }], connections: [] },
  { id: "anthropic", label: "Anthropic", methods: [{ type: "key", label: "API key" }], connections: [] },
];

/**
 * The input used to have no `focused` control at all, so it took every
 * keystroke the moment the auth tab mounted — the row list's own j/k/d never
 * had a chance to run, and typing did nothing visible either, since the
 * settings window's own key handler preventDefaulted first. `editing` is the
 * gate that fixes both halves: nothing reaches the input until it is true.
 */
test("the API key input only takes keys while editing", async () => {
  const t = await createTestRenderer({ width: 40, height: 8 });
  const [editing, setEditing] = createSignal(false);
  const submitted: string[] = [];
  await render(
    () => (
      <AuthSettings
        providers={providers}
        selected={0}
        editing={editing()}
        onSubmit={(key) => submitted.push(key)}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();

  await t.mockInput.typeText("stray");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("stray");

  setEditing(true);
  await t.renderOnce();
  await t.mockInput.typeText("sk-test");
  t.mockInput.pressEnter();
  await t.renderOnce();

  expect(submitted).toEqual(["sk-test"]);
  t.renderer.destroy();
});
