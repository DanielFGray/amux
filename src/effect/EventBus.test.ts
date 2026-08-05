import { Chunk, Effect, Stream } from "effect";
import { expect, test } from "vitest";
import { EventBus } from "./EventBus.ts";

test("EventBus broadcasts events and releases subscriptions with scope", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const one = yield* bus.subscribe();
      const two = yield* bus.subscribe();
      yield* bus.publish({ _tag: "client.changed", client: "ui", change: "attached" });
      const events = yield* Effect.all({
        one: Stream.runCollect(Stream.take(one, 1)),
        two: Stream.runCollect(Stream.take(two, 1)),
      });
      return events;
    }).pipe(Effect.provide(EventBus.Default), Effect.scoped),
  );

  expect([...result.one]).toEqual([
    { sequence: 1, event: { _tag: "client.changed", client: "ui", change: "attached" } },
  ]);
  expect([...result.two]).toEqual([
    { sequence: 1, event: { _tag: "client.changed", client: "ui", change: "attached" } },
  ]);
});

test("EventBus uses sliding delivery rather than blocking publishers", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const stream = yield* bus.subscribe();
      for (let i = 0; i < 300; i++)
        yield* bus.publish({ _tag: "pane.exited", session: String(i), code: null });
      const events = yield* Stream.runCollect(Stream.take(stream, 256));
      const values = Chunk.toReadonlyArray(events);
      expect(values.length).toBe(256);
      expect(values[0]).toEqual({
        sequence: 45,
        event: { _tag: "pane.exited", session: "44", code: null },
      });
    }).pipe(Effect.provide(EventBus.Default), Effect.scoped),
  );
});
