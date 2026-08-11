/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { Stream } from "effect";
import { createSignal } from "solid-js";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { Chat } from "./Chat.tsx";

/**
 * The chat pane's content: a transcript with a composer under it.
 *
 * What matters here is the composer, since the transcript half is covered by
 * Transcript.test.tsx. A composer that takes keys while its pane is in the
 * background would steal them from the pane the user is actually in, and one
 * that keeps its text after sending would send it twice.
 */

const session = { id: "native", kind: "component", name: "chat" } as any;

async function chat(
  active = true,
  frames: () => Stream.Stream<any, unknown> = () => Stream.never,
) {
  const t = await createTestRenderer({ width: 40, height: 8 });
  const [focused, setFocused] = createSignal(active);
  const [width, setWidth] = createSignal(40);
  const sent: string[] = [];
  await render(
    () => (
      <Chat
        session={session}
        width={width}
        height={() => 8}
        active={focused}
        frames={frames}
        sync={() => {}}
        onSubmit={(message) => sent.push(message)}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();
  return { t, sent, setFocused, setWidth };
}

test("the composer sends what was typed and clears itself", async () => {
  const { t, sent } = await chat();

  t.mockInput.typeText("find the bug");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("find the bug");

  t.mockInput.pressEnter();
  await t.renderOnce();

  expect(sent).toEqual(["find the bug"]);
  // Cleared, or the next enter sends the same message a second time.
  expect(t.captureCharFrame()).not.toContain("find the bug");
  t.renderer.destroy();
});

test("whitespace alone is not a message", async () => {
  const { t, sent } = await chat();

  t.mockInput.typeText("   ");
  t.mockInput.pressEnter();
  await t.renderOnce();

  expect(sent).toEqual([]);
  t.renderer.destroy();
});

test("the transcript rewraps when the pane it lives in is resized", async () => {
  const line = "the quick brown fox jumps over the lazy dog and keeps going";
  const { t, setWidth } = await chat(
    true,
    () => Stream.make({ _tag: "text.delta", session: "native", turn: "t1", text: line }) as any,
  );
  await Bun.sleep(10);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("assistant> the quick brown fox jumps");

  // A split narrows the pane. The width reaches the transcript through Chat, so
  // a break that only worked at the mounted size would show up here.
  setWidth(20);
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("assistant> the quick brown fox jumps");
  expect(t.captureCharFrame()).toContain("assistant> the");
  t.renderer.destroy();
});

test("the composer only takes keys while its own pane is focused", async () => {
  const { t, sent, setFocused } = await chat(false);

  t.mockInput.typeText("stray");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("stray");

  setFocused(true);
  await t.renderOnce();
  t.mockInput.typeText("mine");
  t.mockInput.pressEnter();
  await t.renderOnce();

  expect(sent).toEqual(["mine"]);
  t.renderer.destroy();
});
