/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { Prompt } from "./Prompt.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

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
  await t.flush();

  t.mockInput.pressKey("a");
  await t.flush();
  t.mockInput.pressTab();
  await t.flush();
  t.mockInput.pressKey("b");
  await t.flush();

  t.mockInput.pressEnter();
  await t.flush();

  expect(resolved).toEqual(["a", "b"]);
});

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
  await t.flush();

  t.mockInput.pressTab();
  await t.flush();
  t.mockInput.pressKey("z");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();

  expect(resolved).toEqual(["z"]);
});

const SENTINEL = "sk-ant-abc123";

test("masked field never renders the secret in visible text", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Auth",
          fields: [{ label: "API key", value: "", masked: true }],
          resolve: (values) => {
            resolved = values;
          },
        }}
        width={80}
      />
    ),
    t.renderer,
  );
  await t.flush();

  t.mockInput.pressKey("s");
  await t.flush();
  t.mockInput.pressKey("k");
  await t.flush();
  t.mockInput.pressKey("-");
  await t.flush();
  t.mockInput.pressKey("a");
  await t.flush();

  // Blur and resubmit to test unfocused state.
  t.mockInput.pressTab();
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();

  const charFrame = t.captureCharFrame();
  // The full sentinel and the typed prefix must be absent.
  expect(charFrame).not.toContain(SENTINEL);
  expect(charFrame).not.toContain("sk-a");
  // But stars must be present.
  expect(charFrame).toContain("*");

  const spans = t.captureSpans();
  let foundStar = false;
  for (const line of spans.lines) {
    for (const span of line.spans) {
      // No span should contain the secret fragment.
      expect(span.text).not.toContain("sk-a");
      if (span.text.includes("*")) {
        foundStar = true;
      }
    }
  }
  expect(foundStar).toBe(true);
  expect(resolved).toEqual(["sk-a"]);
});

test("masked field shows nothing when empty", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Auth",
          fields: [{ label: "API key", value: "", masked: true }],
          resolve: (values) => {
            resolved = values;
          },
        }}
        width={80}
      />
    ),
    t.renderer,
  );
  await t.flush();

  {
    const spans = t.captureSpans();
    let hasStar = false;
    for (const line of spans.lines) {
      for (const span of line.spans) {
        if (span.text.includes("*")) {
          hasStar = true;
          break;
        }
      }
    }
    expect(hasStar).toBe(false);
  }

  t.mockInput.pressKey("x");
  await t.flush();

  {
    const spansAfter = t.captureSpans();
    let foundStar = false;
    for (const line of spansAfter.lines) {
      for (const span of line.spans) {
        if (span.text.includes("*")) {
          foundStar = true;
          break;
        }
      }
    }
    expect(foundStar).toBe(true);
  }

  t.mockInput.pressEnter();
  await t.flush();
  expect(resolved).toEqual(["x"]);
});

test("masked field preserves uppercase and space in typed secret", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Auth",
          fields: [{ label: "API key", value: "", masked: true }],
          resolve: (values) => {
            resolved = values;
          },
        }}
        width={80}
      />
    ),
    t.renderer,
  );
  await t.flush();

  t.mockInput.pressKey("s");
  await t.flush();
  t.mockInput.pressKey("k");
  await t.flush();
  t.mockInput.pressKey(" ");
  await t.flush();
  t.mockInput.pressKey("A");
  await t.flush();
  t.mockInput.pressKey("p");
  await t.flush();

  t.mockInput.pressEnter();
  await t.flush();

  expect(resolved).toEqual(["sk Ap"]);
});

test("masked field preserves punctuation in typed secret", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Auth",
          fields: [{ label: "API key", value: "", masked: true }],
          resolve: (values) => {
            resolved = values;
          },
        }}
        width={80}
      />
    ),
    t.renderer,
  );
  await t.flush();

  t.mockInput.pressKey("s");
  await t.flush();
  t.mockInput.pressKey("k");
  await t.flush();
  t.mockInput.pressKey("-");
  await t.flush();
  t.mockInput.pressKey("_");
  await t.flush();
  t.mockInput.pressKey(".");
  await t.flush();

  t.mockInput.pressEnter();
  await t.flush();

  expect(resolved).toEqual(["sk-_."]);
});

test("masked field backspace removes last character", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Auth",
          fields: [{ label: "API key", value: "", masked: true }],
          resolve: (values) => {
            resolved = values;
          },
        }}
        width={80}
      />
    ),
    t.renderer,
  );
  await t.flush();

  t.mockInput.pressKey("a");
  await t.flush();
  t.mockInput.pressKey("b");
  await t.flush();
  t.mockInput.pressBackspace();
  await t.flush();
  t.mockInput.pressKey("c");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();

  expect(resolved).toEqual(["ac"]);
});

test("masked field paste updates secret and shows stars", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Auth",
          fields: [{ label: "API key", value: "", masked: true }],
          resolve: (values) => {
            resolved = values;
          },
        }}
        width={80}
      />
    ),
    t.renderer,
  );
  await t.flush();

  await t.mockInput.pasteBracketedText("my-secret");
  await t.flush();

  {
    const charFrame = t.captureCharFrame();
    expect(charFrame).not.toContain("my-secret");
    expect(charFrame).not.toContain("secret");
    expect(charFrame).toContain("*");
  }

  t.mockInput.pressEnter();
  await t.flush();
  expect(resolved).toEqual(["my-secret"]);
});

test("masked field paste strips newlines", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Auth",
          fields: [{ label: "API key", value: "", masked: true }],
          resolve: (values) => {
            resolved = values;
          },
        }}
        width={80}
      />
    ),
    t.renderer,
  );
  await t.flush();

  await t.mockInput.pasteBracketedText("line1\nline2\r\nline3");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();

  expect(resolved).toEqual(["line1line2line3"]);
});

test("mixed masked and non-masked fields resolve correctly", async () => {
  const t = await createTestRenderer({ width: 80, height: 20 });
  cleanup.push(() => t.renderer.destroy());
  let resolved: string[] | null = null as string[] | null;
  await render(
    () => (
      <Prompt
        request={{
          title: "Mixed",
          fields: [
            { label: "Name", value: "" },
            { label: "Secret", value: "", masked: true },
            { label: "Dir", value: "" },
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
  await t.flush();

  t.mockInput.pressKey("d");
  await t.flush();
  t.mockInput.pressKey("a");
  await t.flush();
  t.mockInput.pressKey("n");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();

  t.mockInput.pressKey("p");
  await t.flush();
  t.mockInput.pressKey("w");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();

  t.mockInput.pressKey("s");
  await t.flush();
  t.mockInput.pressKey("r");
  await t.flush();
  t.mockInput.pressKey("c");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();

  expect(resolved).toEqual(["dan", "pw", "src"]);

  const charFrame = t.captureCharFrame();
  expect(charFrame).not.toContain("pw");
});
