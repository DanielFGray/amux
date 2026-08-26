import { expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";
import { AgentLog, AgentLogDefault } from "./AgentLog.ts";

const event = (state: "idle" | "running" | "blocked" | "done") => ({
  _tag: "topic" as const,
  session: "watch",
  topic: "session.state",
  payload: state,
});

test("watch replays and tails without duplicating the replay seam", async () => {
  const values = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const log = yield* AgentLog;
        yield* log.append(event("running"));
        const watch = yield* log.watch("watch", -1);
        const fiber = yield* Effect.fork(Stream.take(watch, 2).pipe(Stream.runCollect));
        yield* log.append(event("idle"));
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(AgentLogDefault)),
    ),
  );
  expect([...values].map((value) => value.sequence)).toEqual([0, 1]);
});
