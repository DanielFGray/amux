import { Effect, Stream } from "effect";
import { expect } from "bun:test";
import { EventBus } from "./EventBus.ts";
import { testEffect } from "../test-effect.ts";

testEffect("EventBus broadcasts events and releases subscriptions with scope", () =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const one = yield* bus.subscribe();
    const two = yield* bus.subscribe();
    yield* bus.publish({
      _tag: "session.state",
      session: "agent-1",
      state: "blocked",
    });
    const events = yield* Effect.all({
      one: Stream.runCollect(Stream.take(one, 1)),
      two: Stream.runCollect(Stream.take(two, 1)),
    });

    expect([...events.one]).toEqual([
      {
        sequence: 1,
        event: { _tag: "session.state", session: "agent-1", state: "blocked" },
      },
    ]);
    expect([...events.two]).toEqual([
      {
        sequence: 1,
        event: { _tag: "session.state", session: "agent-1", state: "blocked" },
      },
    ]);
  }).pipe(Effect.provide(EventBus.layer)),
);

testEffect("EventBus uses sliding delivery rather than blocking publishers", () =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const stream = yield* bus.subscribe();
    for (let i = 0; i < 300; i++)
      yield* bus.publish({
        _tag: "session.state",
        session: String(i),
        state: "working",
      });
    const values = yield* Stream.runCollect(Stream.take(stream, 256));
    expect(values.length).toBe(256);
    expect(values[0]).toEqual({
      sequence: 45,
      event: { _tag: "session.state", session: "44", state: "working" },
    });
  }).pipe(Effect.provide(EventBus.layer)),
);
