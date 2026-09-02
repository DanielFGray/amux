import { Effect, Fiber, Stream } from "effect";
import { expect } from "bun:test";
import { AttachHub } from "./AttachHub.ts";
import { testEffect } from "../test-effect.ts";

const it = testEffect(AttachHub.layer);

it.effect("AttachHub fans frames out and removes subscriptions with scope", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const one = yield* hub.subscribe("one");
    const two = yield* hub.subscribe("two");
    yield* hub.publish({ _tag: "hello", client: "daemon" });
    const [oneFrames, twoFrames] = yield* Effect.all([
      Stream.runCollect(one.frames.pipe(Stream.take(1))),
      Stream.runCollect(two.frames.pipe(Stream.take(1))),
    ]);
    expect([...oneFrames]).toEqual([{ _tag: "hello", client: "daemon" }]);
    expect([...twoFrames]).toEqual([{ _tag: "hello", client: "daemon" }]);
  }),
);

it.effect("AttachHub rejects duplicate client ids", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    yield* hub.subscribe("same");
    const result = yield* hub.subscribe("same").pipe(Effect.result);
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("targeted replay requires the live connection token", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("same", "new");
    yield* hub.publishTo("same", "old", { _tag: "hello", client: "stale" });
    yield* hub.publishTo("same", "new", { _tag: "hello", client: "current" });
    const frames = yield* Stream.runCollect(subscription.frames.pipe(Stream.take(1)));
    expect([...frames]).toEqual([{ _tag: "hello", client: "current" }]);
  }),
);

it.effect("concurrent sync barriers keep every replay ahead of live output", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("same", "connection");
    yield* hub.beginReplay("same", "connection");
    const second = yield* Effect.forkChild(hub.beginReplay("same", "connection"));
    yield* Effect.yieldNow;
    yield* hub.publish({
      _tag: "output",
      session: "s",
      data: new Uint8Array([0]),
    });
    yield* hub.publishTo("same", "connection", {
      _tag: "output",
      session: "s",
      data: new Uint8Array([1]),
    });
    yield* hub.endReplay("same", "connection");
    yield* Fiber.await(second);
    yield* hub.publishTo("same", "connection", {
      _tag: "output",
      session: "s",
      data: new Uint8Array([2]),
    });
    yield* hub.endReplay("same", "connection");
    const frames = yield* Stream.runCollect(subscription.frames.pipe(Stream.take(3)));
    expect([...frames]).toEqual([
      { _tag: "output", session: "s", data: new Uint8Array([1]) },
      { _tag: "output", session: "s", data: new Uint8Array([2]) },
      { _tag: "output", session: "s", data: new Uint8Array([0]) },
    ]);
  }),
);

it.effect("a replay that cannot fit the bounded queue evicts the client", () =>
  Effect.gen(function* () {
    let overflow = 0;
    const hub = yield* AttachHub;
    yield* hub.subscribe("slow", "connection", () => {
      overflow += 1;
    });
    for (let index = 0; index < 256; index++) {
      yield* hub.publish({
        _tag: "output",
        session: "s",
        data: new Uint8Array([index]),
      });
    }
    yield* hub.publishTo("slow", "connection", {
      _tag: "output",
      session: "s",
      data: new Uint8Array([255]),
    });
    const result = yield* hub.publishTo("slow", "connection", {
      _tag: "output",
      session: "s",
      data: new Uint8Array([254]),
    });
    expect(result).toBeUndefined();
    expect(overflow).toBe(1);
  }),
);
