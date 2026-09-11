/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { AuthSettings, oauthModeOptions } from "./index.tsx";
import type { Info as IntegrationInfo } from "./integration.ts";
import type { Method } from "./integration/types.ts";
import { Effect } from "effect";

const providers: readonly IntegrationInfo[] = [
  { id: "openai", label: "OpenAI", methods: [{ type: "key", label: "API key" }], connections: [] },
  {
    id: "anthropic",
    label: "Anthropic",
    methods: [{ type: "key", label: "API key" }],
    connections: [],
  },
];

/**
 * The input used to have no `focused` control at all, so it took every
 * keystroke the moment the auth tab mounted — the row list's own j/k/d never
 * had a chance to run, and typing did nothing visible either, since the
 * settings window's own key handler preventDefaulted first. `key-edit` (and
 * oauth paste wait) is the gate that fixes both halves: nothing reaches the
 * input until the phase says so.
 */
test("the API key input only takes keys while in key-edit phase", async () => {
  const t = await createTestRenderer({ width: 40, height: 8 });
  const [phase, setPhase] = createSignal<{ _tag: "idle" } | { _tag: "key-edit" }>({
    _tag: "idle",
  });
  const submitted: string[] = [];
  await render(
    () => (
      <AuthSettings
        providers={providers}
        selected={0}
        phase={phase()}
        onSubmit={(key) => submitted.push(key)}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();

  await t.mockInput.typeText("stray");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("stray");

  setPhase({ _tag: "key-edit" });
  await t.renderOnce();
  await t.mockInput.typeText("sk-test");
  t.mockInput.pressEnter();
  await t.renderOnce();

  expect(submitted).toEqual(["sk-test"]);
  t.renderer.destroy();
});

test("oauth paste wait focuses the input and shows status", async () => {
  const t = await createTestRenderer({ width: 48, height: 10 });
  const submitted: string[] = [];
  await render(
    () => (
      <AuthSettings
        providers={providers}
        selected={0}
        phase={{
          _tag: "oauth-run",
          mode: "paste",
          status: "Paste redirect URL or code…",
          waitingPaste: true,
        }}
        onSubmit={(value) => submitted.push(value)}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Paste redirect URL or code");
  await t.mockInput.typeText("the-code");
  t.mockInput.pressEnter();
  await t.renderOnce();
  expect(submitted).toEqual(["the-code"]);
  t.renderer.destroy();
});

test("oauthModeOptions reads the method select prompt", () => {
  const method: Extract<Method, { type: "oauth" }> = {
    type: "oauth",
    id: "chatgpt",
    label: "ChatGPT",
    prompts: [
      {
        type: "select",
        key: "mode",
        message: "OAuth mode",
        options: [
          { label: "Browser", value: "auto" },
          { label: "Paste", value: "paste" },
          { label: "Device code", value: "device" },
        ],
      },
    ],
    login: () => Effect.die("unused"),
  };
  expect(oauthModeOptions(method)).toEqual([
    { label: "Browser", value: "auto" },
    { label: "Paste", value: "paste" },
    { label: "Device code", value: "device" },
  ]);
});

test("oauthModeOptions is empty when the method has no mode select", () => {
  const method: Extract<Method, { type: "oauth" }> = {
    type: "oauth",
    id: "github-copilot",
    label: "GitHub Copilot",
    prompts: [
      {
        type: "select",
        key: "deploymentType",
        message: "GitHub deployment",
        options: [{ label: "GitHub.com", value: "github.com" }],
      },
    ],
    login: () => Effect.die("unused"),
  };
  expect(oauthModeOptions(method)).toEqual([]);
});
