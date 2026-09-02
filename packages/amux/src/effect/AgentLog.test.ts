import { expect } from "bun:test";
import { Effect, Fiber, Stream } from "effect";
import { AgentLog, AgentLogDefault } from "./AgentLog.ts";
import { testEffect } from "../test-effect.ts";

const it = testEffect(AgentLogDefault);

const event = (state: "idle" | "running" | "blocked" | "done") => ({
  _tag: "topic" as const,
  session: "watch",
  topic: "session.state",
  payload: state,
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
