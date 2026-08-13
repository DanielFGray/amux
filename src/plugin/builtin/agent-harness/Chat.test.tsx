/** @jsxImportSource @opentui/solid */
import { Effect, Stream } from "effect";
import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { Chat } from "./Chat.tsx";
import type { AttachFrame } from "../../../effect/AttachProtocol.ts";
import { waitFor } from "../../../test-wait.ts";

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
  onSlashCommand?: (command: string) => boolean,
) {
  const t = await createTestRenderer({ width: 40, height: 8 });
  const [focused, setFocused] = createSignal(active);
  const [width, setWidth] = createSignal(40);
  const sent: string[] = [];
  const answered: { request: string; decision: string; feedback?: string }[] = [];
  const interrupted: string[] = [];
  await render(
    () => (
      <Chat
        sessionId={session.id}
        paneType="test"
        model="openai/gpt-4o-mini"
        width={width}
        height={() => 8}
        active={focused}
        frames={frames}
        sync={() => {}}
        onSubmit={(message) => sent.push(message)}
        onPermission={(request, decision, feedback) =>
          answered.push({ request, decision, ...(feedback ? { feedback } : {}) })
        }
        onInterrupt={() => interrupted.push(session.id)}
        onSlashCommand={onSlashCommand}
        slashCommands={[{ name: "model", description: "choose the agent model" }]}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();
  return { t, sent, answered, interrupted, setFocused, setWidth };
}

test("Ctrl-C interrupts the active agent turn", async () => {
  const { t, interrupted } = await chat();
  t.mockInput.pressKey("c", { ctrl: true });
  expect(interrupted).toEqual(["native"]);
  t.renderer.destroy();
});

type Renderer = Awaited<ReturnType<typeof chat>>["t"];

/** Re-render until the condition holds. A sleep then a single render would miss
 *  frames that arrive between the two, and guesses at how long the UI takes. */
const waitUi = (t: Renderer, condition: () => boolean, what: string) =>
  waitFor(
    async () => {
      await t.renderOnce();
      return condition();
    },
    what,
    2_000,
  );

const waitFrame = (t: Renderer, condition: (frame: string) => boolean, label = "condition") =>
  waitUi(t, () => condition(t.captureCharFrame()), label);

/** A chat pane sitting on one unanswered permission request. */
async function blocked() {
  let push: (frame: AttachFrame) => void = () => {};
  const world = await chat(true, () =>
    Stream.asyncPush<AttachFrame>((emit) => {
      push = (frame) => emit.single(frame);
      return Effect.void;
    }),
  );
  push({
    _tag: "permission.request",
    session: "native",
    sequence: 1,
    turn: "t1",
    request: "req-1",
    tool: "bash",
    action: "bash",
    resources: ["git status"],
    save: [{ action: "bash", resource: "git status *", effect: "allow" }],
    input: { command: "git status" },
  });
  await waitFrame(world.t, (frame) => frame.includes("[o]"), "the approval bar");
  return { ...world, push: (frame: AttachFrame) => push(frame) };
}

test("a pending request shows the rule that always would write", async () => {
  const { t } = await blocked();
  const frame = t.captureCharFrame();
  expect(frame).toContain("git status");
  expect(frame).toContain("bash git status *");
  t.renderer.destroy();
});

test("a key answers the question instead of typing into the composer", async () => {
  const { t, sent, answered, push } = await blocked();
  await t.mockInput.typeText("a");
  await t.renderOnce();
  expect(answered).toEqual([{ request: "req-1", decision: "always" }]);
  expect(sent).toEqual([]);

  // The bar stands until the agent says what it did: the answer the pane sent
  // is a request, and with several panes on one session it may not be the one
  // that won.
  expect(t.captureCharFrame()).toContain("[o]");
  push({
    _tag: "permission.response",
    session: "native",
    sequence: 2,
    request: "req-1",
    decision: "always",
  });
  await waitFrame(t, (frame) => !frame.includes("[o]"), "the bar to clear");
  t.renderer.destroy();
});

test("deny with a reason returns the composer, and enter sends the refusal", async () => {
  const { t, sent, answered } = await blocked();
  await t.mockInput.typeText("e");
  await t.renderOnce();
  await t.mockInput.typeText("not that repo");
  t.mockInput.pressEnter();
  await waitUi(t, () => answered.length > 0, "the refusal to be answered");
  expect(answered).toEqual([{ request: "req-1", decision: "reject", feedback: "not that repo" }]);
  expect(sent).toEqual([]);
  t.renderer.destroy();
});

test("the /model slash command opens the model picker without sending", async () => {
  const { t, sent } = await chat(
    true,
    () => Stream.never,
    () => true,
  );
  await t.mockInput.typeText("/model");
  t.mockInput.pressEnter();
  await Bun.sleep(10);
  await t.renderOnce();
  expect(sent).toEqual([]);
  t.renderer.destroy();
});

test("slash autocomplete filters and selects a command without sending", async () => {
  const { t, sent } = await chat(
    true,
    () => Stream.never,
    () => true,
  );
  await t.mockInput.typeText("/mo");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("/model");
  t.mockInput.pressEnter();
  await Bun.sleep(10);
  await t.renderOnce();
  expect(sent).toEqual([]);
  expect(t.captureCharFrame()).not.toContain("/model");
  t.renderer.destroy();
});

test("the composer sends what was typed and clears itself", async () => {
  const { t, sent } = await chat();

  await t.mockInput.typeText("find the bug");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("find the bug");

  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "the message to be sent");

  expect(sent).toEqual(["find the bug"]);
  // Cleared, or the next enter sends the same message a second time.
  expect(t.captureCharFrame()).not.toContain("find the bug");
  t.renderer.destroy();
});

test("whitespace alone is not a message", async () => {
  const { t, sent } = await chat();

  await t.mockInput.typeText("   ");
  t.mockInput.pressEnter();
  await Bun.sleep(10);
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
  await waitFrame(t, (frame) => frame.includes("the quick brown fox"), "the delta to render");

  // A split narrows the pane. The width reaches the transcript through Chat, so
  // a break that only worked at the mounted size would show up here.
  setWidth(20);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("the quick brown fox jumps");
  expect(t.captureCharFrame()).toContain("over the lazy");
  t.renderer.destroy();
});

test("working status is shown as a spinner below the editor", async () => {
  const { t } = await chat(
    true,
    () =>
      Stream.make({
        _tag: "agent.status",
        session: "native",
        sequence: 1,
        state: "working",
      }) as any,
  );
  await waitFrame(t, (frame) => frame.includes("working"), "the status to render");

  const output = t.captureCharFrame();
  expect(output).toContain("working");
  expect(output).not.toContain("status> working");
  expect(output).toContain("openai/gpt-4o-mini");
  t.renderer.destroy();
});

test("the composer only takes keys while its own pane is focused", async () => {
  const { t, sent, setFocused } = await chat(false);

  await t.mockInput.typeText("stray");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("stray");

  setFocused(true);
  await t.renderOnce();
  await t.mockInput.typeText("mine");
  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "the focused composer to send");

  expect(sent).toEqual(["mine"]);
  t.renderer.destroy();
});

/**
 * The answer to "the agent said nothing": a submitted message has to become a
 * response in the pane. Frames are pushed into the transcript's stream after
 * submit, the way the daemon delivers them, and the rendered frame has to show
 * the turn. Anything upstream of this — prompt never reaching the worker, frames
 * never leaving it — leaves the pane stuck on the user message, and this test
 * fails loudly instead of looking like a quiet pane.
 */
test("a submitted message is answered by the agent in the transcript", async () => {
  const t = await createTestRenderer({ width: 40, height: 20 });
  let push: (frame: AttachFrame) => void = () => {};
  const sent: string[] = [];
  await render(
    () => (
      <Chat
        sessionId="native"
        paneType="test"
        model="openai/gpt-4o-mini"
        width={() => 40}
        height={() => 20}
        active={() => true}
        frames={() =>
          Stream.asyncPush<AttachFrame>((emit) => {
            push = (frame) => emit.single(frame);
            return Effect.void;
          })
        }
        sync={() => {}}
        onSubmit={(message) => sent.push(message)}
        onPermission={() => {}}
        onInterrupt={() => {}}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();
  await t.mockInput.typeText("fix the bug");
  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "the message to be sent");
  expect(sent).toEqual(["fix the bug"]);

  push({
    _tag: "agent.status",
    session: "native",
    sequence: 1,
    state: "working",
  });
  push({
    _tag: "turn.start",
    session: "native",
    sequence: 2,
    turn: "t1",
    prompt: "fix the bug",
  });
  push({ _tag: "text.delta", session: "native", turn: "t1", text: "I will " });
  await t.renderOnce();
  push({ _tag: "text.delta", session: "native", turn: "t1", text: "inspect." });
  push({
    _tag: "turn.end",
    session: "native",
    sequence: 3,
    turn: "t1",
    outcome: "completed",
    text: "I will inspect.",
  });

  await waitFrame(t, (frame) => frame.includes("I will inspect."), "the agent's answer");
  expect(t.captureCharFrame()).toContain("fix the bug");
  t.renderer.destroy();
});

test("the latest agent response stays visible in a short chat pane", async () => {
  const response = Array.from({ length: 12 }, (_, index) => `answer ${index}`).join("\n");
  const { t } = await chat(
    true,
    () => Stream.make({ _tag: "text.delta", session: "native", turn: "t1", text: response }) as any,
  );

  await waitFrame(t, (frame) => frame.includes("answer 11"), "the latest response line");
  expect(t.captureCharFrame()).toContain("message the agent");
  expect(t.captureCharFrame()).toContain("openai/gpt-4o-mini");
  t.renderer.destroy();
});

test("a tool call streams through the pane as about-to-run, then revealed", async () => {
  const t = await createTestRenderer({ width: 40, height: 20 });
  let push: (frame: AttachFrame) => void = () => {};
  await render(
    () => (
      <Chat
        sessionId="native"
        paneType="test"
        model="openai/gpt-4o-mini"
        width={() => 40}
        height={() => 20}
        active={() => true}
        frames={() =>
          Stream.asyncPush<AttachFrame>((emit) => {
            push = (frame) => emit.single(frame);
            return Effect.void;
          })
        }
        sync={() => {}}
        onSubmit={() => {}}
        onPermission={() => {}}
        onInterrupt={() => {}}
      />
    ),
    t.renderer,
  );
  await t.renderOnce();

  push({
    _tag: "agent.status",
    session: "native",
    sequence: 1,
    state: "working",
  });
  push({ _tag: "turn.start", session: "native", sequence: 2, turn: "t1", prompt: "run it" });
  push({
    _tag: "tool.params-start",
    session: "native",
    turn: "t1",
    call: "c1",
    tool: "bash",
  });
  push({
    _tag: "tool.params-delta",
    session: "native",
    turn: "t1",
    call: "c1",
    delta: '{"command": "git s',
  });
  await t.renderOnce();
  await waitFrame(t, (frame) => frame.includes("~ Writing command..."), "the pending placeholder");

  push({
    _tag: "tool.start",
    session: "native",
    sequence: 3,
    turn: "t1",
    call: "c1",
    tool: "bash",
    input: { command: "git status" },
  });
  await waitFrame(t, (frame) => frame.includes("$ git status"), "the revealed command");
  expect(t.captureCharFrame()).not.toContain("~ Writing command...");
  t.renderer.destroy();
});

test("chat joins an approved permission to its tool instead of rendering a second card", async () => {
  let push: (frame: AttachFrame) => void = () => {};
  const { t } = await chat(true, () =>
    Stream.asyncPush<AttachFrame>((emit) => {
      push = (frame) => emit.single(frame);
      return Effect.void;
    }),
  );
  push({
    _tag: "tool.start",
    session: "native",
    sequence: 1,
    turn: "t1",
    call: "c1",
    tool: "bash",
    input: { command: "ls" },
  });
  push({
    _tag: "permission.request",
    session: "native",
    sequence: 2,
    turn: "t1",
    request: "r1",
    tool: "bash",
    action: "bash",
    resources: ["ls"],
    save: [],
    input: { command: "ls" },
  });
  await waitFrame(t, (rendered) => rendered.includes("$ ls"), "the approval request");
  push({
    _tag: "permission.response",
    session: "native",
    sequence: 3,
    request: "r1",
    decision: "once",
  });
  push({
    _tag: "tool.result",
    session: "native",
    sequence: 4,
    turn: "t1",
    call: "c1",
    output: "AGENTS.md",
    isError: false,
  });
  await waitFrame(t, (rendered) => rendered.includes("AGENTS.md"), "the tool result");
  const rendered = t.captureCharFrame();
  expect(rendered).not.toContain("permission>");
  expect(rendered).not.toContain("status>");
  t.renderer.destroy();
});
