/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree. */
/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { ApprovalPrompt, type ApprovalPromptRequest } from "./ApprovalPrompt.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const toolAsk = (overrides: Partial<ApprovalPromptRequest> = {}): ApprovalPromptRequest => ({
  verb: "bash",
  resources: ["rm -rf build"],
  summary: "bash: $ rm -rf build",
  save: [{ action: "bash", resource: "rm *", effect: "allow" }],
  ...overrides,
});

const commandAsk = (): ApprovalPromptRequest => ({
  verb: "split.horizontal",
  resources: [],
  summary: "split.horizontal",
  save: [],
  rule: { action: "split.horizontal", resource: "*", effect: "ask" },
});

async function frame(
  request: ApprovalPromptRequest,
  options: {
    explaining?: boolean;
    framed?: boolean;
    withExplain?: boolean;
  } = {},
) {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  const [width] = createSignal(80);
  await render(
    () => (
      <ApprovalPrompt
        request={request}
        width={width}
        explaining={options.explaining}
        framed={options.framed}
        onDecide={() => {}}
        onExplain={options.withExplain === false ? undefined : () => {}}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();
  return t.captureCharFrame();
}

test("tool ask shows summary, always rule, and once/always/deny/explain", async () => {
  const f = await frame(toolAsk());
  expect(f).toContain("bash: $ rm -rf build");
  expect(f).toContain("always → bash rm *");
  expect(f).toContain("[o]");
  expect(f).toContain("once");
  expect(f).toContain("[a]");
  expect(f).toContain("always");
  expect(f).toContain("[d]");
  expect(f).toContain("deny");
  expect(f).toContain("[e]");
  expect(f).toContain("explain");
});

test("empty save hides the always choice", async () => {
  const f = await frame(toolAsk({ save: [] }));
  expect(f).toContain("[o]");
  expect(f).not.toContain("[a]");
  expect(f).toContain("[d]");
});

test("command ask shows the matching rule and omits explain when not offered", async () => {
  const f = await frame(commandAsk(), { withExplain: false });
  expect(f).toContain("split.horizontal");
  expect(f).toContain("ask → split.horizontal *");
  expect(f).toContain("[o]");
  expect(f).toContain("[d]");
  expect(f).not.toContain("[e]");
  expect(f).not.toContain("[a]");
});

test("explaining replaces choices with awaiting approval", async () => {
  const f = await frame(toolAsk(), { explaining: true });
  expect(f).toContain("awaiting approval");
  expect(f).not.toContain("[o]");
});

test("framed orphan asks keep the surface chrome around the choices", async () => {
  const f = await frame(toolAsk(), { framed: true });
  expect(f).toContain("bash: $ rm -rf build");
  expect(f).toContain("[o]");
});
