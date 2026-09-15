/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { Effect, Option, Queue, Stream } from "effect";
import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { Chat } from "./Chat.tsx";
import { AttachFrame } from "@danielfgray/amux/protocol";
import { ProcessState } from "@danielfgray/amux";
import { waitFor } from "@danielfgray/amux/testing";
import {
  emit,
  delta,
  OpaqueJsonText,
  decodeOpaqueJsonText,
  type HarnessDelta,
  type HarnessEvent,
} from "./protocol.ts";
const jp = (value: typeof OpaqueJsonText.Encoded) => Option.getOrThrow(decodeOpaqueJsonText(value));
import { agentStateTopic } from "./state-topic.ts";

/** Wrap a harness event/fragment the way core actually delivers it — this
 *  test used to push the harness tags directly onto the wire, which the
 *  protocol no longer carries at its top level. */
const DELTA_TAGS = new Set<string>([
  "text.delta",
  "tool.params-start",
  "tool.params-delta",
  "tool.params-end",
]);
type TopicPayload = {
  readonly _tag: "topic";
  readonly topic: string;
  readonly payload: typeof OpaqueJsonText.Encoded;
};
function wrap(
  value: (HarnessEvent | HarnessDelta | TopicPayload) & {
    readonly session: string;
    readonly sequence?: number;
  },
): AttachFrame {
  const { session, sequence, ...event } = value;
  if (event._tag === "topic")
    return {
      session,
      sequence: sequence ?? 0,
      _tag: "topic",
      topic: event.topic,
      payload: jp(event.payload),
    };
  return DELTA_TAGS.has(event._tag)
    ? Effect.runSync(delta(session, event as HarnessDelta))
    : ({
        ...Effect.runSync(emit(session, event as HarnessEvent)),
        sequence: sequence ?? 0,
      } as AttachFrame);
}

/**
 * The chat pane's content: a transcript with a composer under it.
 *
 * What matters here is the composer, since the transcript half is covered by
 * Transcript.test.tsx. A composer that takes keys while its pane is in the
 * background would steal them from the pane the user is actually in, and one
 * that keeps its text after sending would send it twice.
 */

const session = { id: "native", kind: "component", name: "chat" };

async function chat(
  active = true,
  frames: () => Stream.Stream<AttachFrame, never> = () => Stream.empty,
  onSlashCommand?: (command: string) => boolean,
  kittyKeyboard = false,
  height = 8,
  slashCommands: { name: string; description: string }[] = [
    { name: "model", description: "choose the agent model" },
  ],
) {
  const t = await createTestRenderer({ width: 40, height, kittyKeyboard });
  const [focused, setFocused] = createSignal(active);
  const [width, setWidth] = createSignal(40);
  const sent: { text: string; options?: { delivery?: string; replace?: string } }[] = [];
  const answered: { request: string; decision: string; feedback?: string }[] = [];
  const interrupted: string[] = [];
  await render(
    () => (
      <Chat
        sessionId={session.id}
        paneId="pane-native"
        paneType="test"
        descriptor="{}"
        model="openai/gpt-4o-mini"
        width={width}
        height={() => height}
        active={focused}
        captureKeys={() => {}}
        copyText={() => {}}
        frames={frames}
        sync={() => {}}
        onSubmit={(message, options) =>
          sent.push(options ? { text: message, options } : { text: message })
        }
        onPermission={(request, decision, feedback) =>
          answered.push(feedback ? { request, decision, feedback } : { request, decision })
        }
        onInterrupt={() => interrupted.push(session.id)}
        onSlashCommand={onSlashCommand}
        slashCommands={slashCommands}
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

/** Mid-turn composer: queue on Enter, steer on empty Enter, Up edits the queue. */
async function runningChat() {
  let push: (frame: AttachFrame) => void = () => {};
  const world = await chat(true, () =>
    Stream.callback<AttachFrame>((queue) => {
      push = (frame) => Queue.offerUnsafe(queue, frame);
      return Effect.void;
    }),
  );
  push({
    session: "native",
    sequence: 1,
    ...Effect.runSync(agentStateTopic(ProcessState.Running)),
  });
  await waitUi(world.t, () => world.t.captureCharFrame().includes("queue"), "running placeholder");
  return { ...world, push: (frame: AttachFrame) => push(frame) };
}

test("Enter while the agent is running queues the message", async () => {
  const { t, sent } = await runningChat();
  await t.mockInput.typeText("wait for tools");
  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "queued submit");
  expect(sent).toEqual([{ text: "wait for tools", options: { delivery: "queue" } }]);
  t.renderer.destroy();
});

test("empty Enter while queued steers the latest queued message", async () => {
  const { t, sent, push } = await runningChat();
  push(
    wrap({
      _tag: "turn.queued",
      session: "native",
      sequence: 2,
      turn: "turn-q1",
      prompt: "go left instead",
      delivery: "queue",
    }),
  );
  await waitFrame(t, (frame) => frame.includes("go left instead"), "queued visible");
  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "steer submit");
  expect(sent).toEqual([
    { text: "go left instead", options: { delivery: "steer", replace: "turn-q1" } },
  ]);
  t.renderer.destroy();
});

test("Up recalls a queued message into the composer for editing", async () => {
  const { t, sent, push } = await runningChat();
  push(
    wrap({
      _tag: "turn.queued",
      session: "native",
      sequence: 2,
      turn: "turn-q1",
      prompt: "original queue",
      delivery: "queue",
    }),
  );
  await waitFrame(t, (frame) => frame.includes("original queue"), "queued visible");
  t.mockInput.pressArrow("up");
  await waitFrame(t, (frame) => frame.includes("original queue"), "composer has queued text");
  await t.mockInput.typeText(" edited");
  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "edited queue submit");
  expect(sent).toEqual([
    { text: "original queue edited", options: { delivery: "queue", replace: "turn-q1" } },
  ]);
  t.renderer.destroy();
});

/** A chat pane sitting on one unanswered permission request. */
async function blocked() {
  let push: (frame: AttachFrame) => void = () => {};
  const world = await chat(true, () =>
    Stream.callback<AttachFrame>((queue) => {
      push = (frame) => Queue.offerUnsafe(queue, frame);
      return Effect.void;
    }),
  );
  push(
    wrap({
      _tag: "permission.request",
      session: "native",
      sequence: 1,
      turn: "t1",
      request: "req-1",
      tool: "bash",
      action: "bash",
      resources: ["git status"],
      save: [{ action: "bash", resource: "git status *", effect: "allow" }],
      input: jp({ command: "git status" }),
    }),
  );
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

for (const [key, decision] of [
  ["o", "once"],
  ["a", "always"],
  ["d", "reject"],
] as const) {
  test(`${key} answers the question instead of typing into the composer`, async () => {
    const { t, sent, answered, push } = await blocked();
    await t.mockInput.typeText(key);
    await t.renderOnce();
    expect(answered).toEqual([{ request: "req-1", decision }]);
    expect(sent).toEqual([]);

    // The bar stands until the agent says what it did: the answer the pane sent
    // is a request, and with several panes on one session it may not be the one
    // that won.
    expect(t.captureCharFrame()).toContain("[o]");
    push(
      wrap({
        _tag: "permission.response",
        session: "native",
        sequence: 2,
        request: "req-1",
        decision,
      }),
    );
    await waitFrame(t, (frame) => !frame.includes("[o]"), "the bar to clear");
    t.renderer.destroy();
  });
}

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

test("the /thinking slash command opens the thinking picker without sending", async () => {
  const { t, sent } = await chat(
    true,
    () => Stream.never,
    (command) => command === "/thinking",
  );
  await t.mockInput.typeText("/thinking");
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

test("slash autocomplete lists /thinking", async () => {
  const { t, sent } = await chat(
    true,
    () => Stream.never,
    () => true,
    false,
    8,
    [{ name: "thinking", description: "choose thinking effort" }],
  );
  await t.mockInput.typeText("/th");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("/thinking");
  expect(sent).toEqual([]);
  t.renderer.destroy();
});

test("the composer sends what was typed and clears itself", async () => {
  const { t, sent } = await chat();

  await t.mockInput.typeText("find the bug");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("find the bug");

  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "the message to be sent");

  expect(sent).toEqual([{ text: "find the bug" }]);
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

test("shift+enter inserts a newline instead of submitting", async () => {
  // Kitty keyboard: with the legacy transport Shift+Return arrives
  // indistinct from Return (production runs with Kitty keyboard disabled),
  // so the shifted chord is only exercisable with the protocol on.
  const { t, sent } = await chat(true, () => Stream.empty, undefined, true);

  await t.mockInput.typeText("line one");
  t.mockInput.pressEnter({ shift: true });
  await t.renderOnce();
  await t.mockInput.typeText("line two");
  await t.renderOnce();

  // No submit yet: the draft holds both lines.
  expect(sent).toEqual([]);
  const frame = t.captureCharFrame();
  expect(frame).toContain("line one");
  expect(frame).toContain("line two");

  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "the multiline message to be sent");
  expect(sent).toEqual([{ text: "line one\nline two" }]);
  t.renderer.destroy();
});

test("alt+enter inserts a newline on the legacy transport", async () => {
  // No Kitty keyboard, like production: Alt+Return survives as ESC CR while
  // Shift+Return would not.
  const { t, sent } = await chat();

  await t.mockInput.typeText("line one");
  t.mockInput.pressEnter({ meta: true });
  await t.renderOnce();
  await t.mockInput.typeText("line two");
  await t.renderOnce();

  expect(sent).toEqual([]);
  expect(t.captureCharFrame()).toContain("line two");

  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "the multiline message to be sent");
  expect(sent).toEqual([{ text: "line one\nline two" }]);
  t.renderer.destroy();
});

test("a long line wraps and grows the composer instead of scrolling sideways", async () => {
  const { t } = await chat();
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  await t.mockInput.typeText(words.join(" "));

  // Wrapped across at least two frame rows at width 40; a sideways-scrolling
  // single row would hold the text on exactly one row. Polled, not single
  // render: the height signal updates on an effect after the content lands.
  await waitFrame(
    t,
    (frame) =>
      frame.split("\n").filter((row) => /alpha|beta|gamma|delta|epsilon|zeta|eta|theta/.test(row))
        .length > 1,
    "the composer to wrap",
  );
  const frame = t.captureCharFrame();
  expect(frame).toContain("alpha");
  expect(frame).toContain("theta");
  t.renderer.destroy();
});

test("the composer caps at half the pane height", async () => {
  // Kitty keyboard so every shifted Enter is a real newline, never a submit.
  const { t, sent } = await chat(true, () => Stream.empty, undefined, true);
  for (let line = 0; line < 12; line++) {
    await t.mockInput.typeText(`line ${line}`);
    t.mockInput.pressEnter({ shift: true });
    await t.renderOnce();
  }
  expect(sent).toEqual([]);
  const frame = t.captureCharFrame();
  // The transcript chrome survives a 12-line draft in a height-8 pane: the
  // composer caps at 4 rows instead of pushing everything else out. The
  // placeholder hides while the draft is non-empty, so the draft's tail and
  // the status bar are what must stay on screen.
  expect(frame).toContain("openai/gpt-4o-mini");
  expect(frame).toContain("line 11");

  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "the capped draft to be sent");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text.split("\n")).toHaveLength(12);
  t.renderer.destroy();
});

test("the transcript rewraps when the pane it lives in is resized", async () => {
  const line = "the quick brown fox jumps over the lazy dog and keeps going";
  // Height 10: the composer now floors at 2 rows, and the old height-8
  // geometry left the transcript exactly one row short of showing the break.
  const { t, setWidth } = await chat(
    true,
    () => Stream.make(wrap({ _tag: "text.delta", session: "native", turn: "t1", text: line })),
    undefined,
    false,
    10,
  );
  await waitFrame(t, (frame) => frame.includes("the quick brown fox"), "the delta to render");

  // A split narrows the pane. The width reaches the transcript through Chat, so
  // a break that only worked at the mounted size would show up here: at the
  // narrower width the OpenTUI <markdown> wrap no longer keeps "fox" on the
  // same line as "the quick brown".
  setWidth(20);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).not.toContain("the quick brown fox jumps");
  expect(frame).toContain("the quick brown fox");
  expect(frame).toContain("jumps over the lazy");
  expect(frame).toContain("dog and keeps going");
  t.renderer.destroy();
});

test("working status is shown as a spinner below the editor", async () => {
  const { t } = await chat(true, () =>
    Stream.make(
      wrap({
        _tag: "topic",
        session: "native",
        sequence: 1,
        topic: "session.state",
        payload: "running",
      }),
    ),
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

  expect(sent).toEqual([{ text: "mine" }]);
  t.renderer.destroy();
});

test("clicking the transcript does not steal composer focus", async () => {
  const { t, sent } = await chat(true, undefined, undefined, false, 16);
  await t.renderOnce();
  // Top of the transcript area (above the composer).
  await t.mockMouse.click(5, 2);
  await t.renderOnce();
  await t.mockInput.typeText("still here");
  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "composer to keep focus after transcript click");
  expect(sent).toEqual([{ text: "still here" }]);
  t.renderer.destroy();
});

test("composer reclaim does not steal focus released by another component pane", async () => {
  const t = await createTestRenderer({ width: 80, height: 12 });
  const sent: string[] = [];
  let foreign: { focus(): void; blur(): void } | undefined;
  await render(
    () => (
      <box style={{ width: "100%", height: "100%", flexDirection: "row" }}>
        <box id="chat-pane" style={{ width: 40, height: "100%" }}>
          <box id="chat-pane-content" style={{ width: "100%", height: "100%" }}>
            <Chat
              sessionId="native"
              paneId="chat-pane"
              paneType="test"
              descriptor="{}"
              model="openai/gpt-4o-mini"
              width={() => 40}
              height={() => 12}
              active={() => true}
              captureKeys={() => {}}
              copyText={() => {}}
              frames={() => Stream.empty}
              sync={() => {}}
              onSubmit={(message) => sent.push(message)}
              onPermission={() => {}}
              onInterrupt={() => {}}
            />
          </box>
        </box>
        <box id="other-pane" style={{ width: 40, height: "100%" }}>
          <box id="other-pane-content" style={{ width: "100%", height: "100%" }}>
            <textarea ref={(value) => (foreign = value)} style={{ width: "100%", height: 2 }} />
          </box>
        </box>
      </box>
    ),
    t.renderer,
  );
  await t.renderOnce();
  // Another leaf took OpenTUI focus then released it — the race while
  // pane.select is in flight and this chat still reads as active.
  foreign?.focus();
  await t.renderOnce();
  foreign?.blur();
  await t.renderOnce();
  await Promise.resolve();
  await t.renderOnce();
  await t.mockInput.typeText("not yours");
  t.mockInput.pressEnter();
  await t.renderOnce();
  expect(sent).toEqual([]);
  t.renderer.destroy();
});

test("composer reclaim still takes focus back after a non-pane overlay releases it", async () => {
  const t = await createTestRenderer({ width: 40, height: 12 });
  const sent: string[] = [];
  let overlay: { focus(): void; blur(): void } | undefined;
  await render(
    () => (
      <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
        <box id="chat-pane" style={{ width: "100%", height: 10 }}>
          <box id="chat-pane-content" style={{ width: "100%", height: "100%" }}>
            <Chat
              sessionId="native"
              paneId="chat-pane"
              paneType="test"
              descriptor="{}"
              model="openai/gpt-4o-mini"
              width={() => 40}
              height={() => 10}
              active={() => true}
              captureKeys={() => {}}
              copyText={() => {}}
              frames={() => Stream.empty}
              sync={() => {}}
              onSubmit={(message) => sent.push(message)}
              onPermission={() => {}}
              onInterrupt={() => {}}
            />
          </box>
        </box>
        <textarea ref={(value) => (overlay = value)} style={{ width: "100%", height: 2 }} />
      </box>
    ),
    t.renderer,
  );
  await t.renderOnce();
  overlay?.focus();
  await t.renderOnce();
  overlay?.blur();
  await t.renderOnce();
  await Promise.resolve();
  await t.renderOnce();
  await t.mockInput.typeText("mine again");
  t.mockInput.pressEnter();
  await waitUi(t, () => sent.length > 0, "composer to reclaim after overlay blur");
  expect(sent).toEqual(["mine again"]);
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
        paneId="pane-native"
        paneType="test"
        descriptor="{}"
        model="openai/gpt-4o-mini"
        width={() => 40}
        height={() => 20}
        active={() => true}
        captureKeys={() => {}}
        copyText={() => {}}
        frames={() =>
          Stream.callback<AttachFrame>((queue) => {
            push = (frame) => Queue.offerUnsafe(queue, frame);
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

  push(
    wrap({
      _tag: "topic",
      session: "native",
      sequence: 1,
      topic: "session.state",
      payload: "running",
    }),
  );
  push(
    wrap({
      _tag: "turn.start",
      session: "native",
      sequence: 2,
      turn: "t1",
      prompt: "fix the bug",
    }),
  );
  push(wrap({ _tag: "text.delta", session: "native", turn: "t1", text: "I will " }));
  await t.renderOnce();
  push(wrap({ _tag: "text.delta", session: "native", turn: "t1", text: "inspect." }));
  push(
    wrap({
      _tag: "turn.end",
      session: "native",
      sequence: 3,
      turn: "t1",
      outcome: "completed",
      text: "I will inspect.",
    }),
  );

  await waitFrame(t, (frame) => frame.includes("I will inspect."), "the agent's answer");
  expect(t.captureCharFrame()).toContain("fix the bug");
  t.renderer.destroy();
});

test("the latest agent response stays visible in a short chat pane", async () => {
  const response = Array.from({ length: 12 }, (_, index) => `answer ${index}`).join("\n");
  const { t } = await chat(true, () =>
    Stream.make(wrap({ _tag: "text.delta", session: "native", turn: "t1", text: response })),
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
        paneId="pane-native"
        paneType="test"
        descriptor="{}"
        model="openai/gpt-4o-mini"
        width={() => 40}
        height={() => 20}
        active={() => true}
        captureKeys={() => {}}
        copyText={() => {}}
        frames={() =>
          Stream.callback<AttachFrame>((queue) => {
            push = (frame) => Queue.offerUnsafe(queue, frame);
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

  push(
    wrap({
      _tag: "topic",
      session: "native",
      sequence: 1,
      topic: "session.state",
      payload: "running",
    }),
  );
  push(wrap({ _tag: "turn.start", session: "native", sequence: 2, turn: "t1", prompt: "run it" }));
  push(
    wrap({
      _tag: "tool.params-start",
      session: "native",
      turn: "t1",
      call: "c1",
      tool: "bash",
    }),
  );
  push(
    wrap({
      _tag: "tool.params-delta",
      session: "native",
      turn: "t1",
      call: "c1",
      delta: '{"command": "git s',
    }),
  );
  await t.renderOnce();
  await waitFrame(t, (frame) => frame.includes("~ Writing command..."), "the pending placeholder");

  push(
    wrap({
      _tag: "tool.start",
      session: "native",
      sequence: 3,
      turn: "t1",
      call: "c1",
      tool: "bash",
      input: jp({ command: "git status" }),
    }),
  );
  await waitFrame(t, (frame) => frame.includes("$ git status"), "the revealed command");
  expect(t.captureCharFrame()).not.toContain("~ Writing command...");
  t.renderer.destroy();
});

test("chat joins an approved permission to its tool instead of rendering a second card", async () => {
  let push: (frame: AttachFrame) => void = () => {};
  const { t } = await chat(true, () =>
    Stream.callback<AttachFrame>((queue) => {
      push = (frame) => Queue.offerUnsafe(queue, frame);
      return Effect.void;
    }),
  );
  push(
    wrap({
      _tag: "tool.start",
      session: "native",
      sequence: 1,
      turn: "t1",
      call: "c1",
      tool: "bash",
      input: jp({ command: "ls" }),
    }),
  );
  push(
    wrap({
      _tag: "permission.request",
      session: "native",
      sequence: 2,
      turn: "t1",
      request: "r1",
      tool: "bash",
      action: "bash",
      resources: ["ls"],
      save: [],
      input: jp({ command: "ls" }),
    }),
  );
  await waitFrame(t, (rendered) => rendered.includes("$ ls"), "the approval request");
  push(
    wrap({
      _tag: "permission.response",
      session: "native",
      sequence: 3,
      request: "r1",
      decision: "once",
    }),
  );
  push(
    wrap({
      _tag: "tool.result",
      session: "native",
      sequence: 4,
      turn: "t1",
      call: "c1",
      output: jp("AGENTS.md"),
      isError: false,
    }),
  );
  await waitFrame(t, (rendered) => rendered.includes("AGENTS.md"), "the tool result");
  const rendered = t.captureCharFrame();
  expect(rendered).not.toContain("permission>");
  expect(rendered).not.toContain("status>");
  t.renderer.destroy();
});
