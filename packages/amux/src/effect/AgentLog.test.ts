import { expect } from "bun:test";
import { Effect, Fiber, Schema as S, Stream } from "effect";
import { AgentLog, AgentLogDefault } from "./AgentLog.ts";
import { OwnerJsonText } from "../layout.ts";
import { testEffect } from "../test-effect.ts";

const it = testEffect(AgentLogDefault);
const ownerText = (value: typeof OwnerJsonText.Encoded) => S.decodeSync(OwnerJsonText)(value);

const event = (state: "idle" | "running" | "blocked" | "done") => ({
  _tag: "topic" as const,
  session: "watch",
  topic: "session.state",
  payload: ownerText(state),
});

it.effect("watch replays and tails without duplicating the replay seam", () =>
  Effect.gen(function* () {
    const log = yield* AgentLog;
    yield* log.append(event("running"));
    const watch = yield* log.watch("watch", -1);
    const fiber = yield* Effect.forkChild(Stream.take(watch, 2).pipe(Stream.runCollect));
    yield* log.append(event("idle"));
    const values = yield* Fiber.join(fiber);
    expect([...values].map((value) => value.sequence)).toEqual([0, 1]);
  }),
);

it.effect("append assigns a committed sequence starting at zero", () =>
  Effect.gen(function* () {
    const log = yield* AgentLog;
    const first = yield* log.append({
      _tag: "topic",
      session: "seq",
      topic: "session.state",
      payload: ownerText("running"),
    });
    const second = yield* log.append({
      _tag: "agent.message",
      session: "seq",
      event: ownerText({ reason: "startup failed" }),
    });
    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
    const events = yield* log.read("seq");
    expect(events.map((e) => e.sequence)).toEqual([0, 1]);
  }),
);
