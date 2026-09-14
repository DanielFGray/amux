import { expect } from "bun:test";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema as S } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { testEffect } from "./test-effect.ts";
import { PLUGIN_SESSION_RUN_TIMEOUT_MS } from "./plugin-behaviour.ts";
import { makePublicationGate, PluginPublishTimedOut } from "./plugin-publication-gate.ts";

const { effect: testClockEffect } = testEffect(Layer.empty);

testClockEffect("publish waits for an admitted invocation to end", () =>
  Effect.gen(function* () {
    const gate = yield* makePublicationGate();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      gate.admit(
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      ),
    );
    yield* Deferred.await(entered);

    let published = false;
    const publishFiber = yield* Effect.forkChild(
      gate.withPublish(
        Effect.void,
        () =>
          Effect.sync(() => {
            published = true;
          }),
        Effect.void,
      ),
    );

    yield* TestClock.adjust(Duration.millis(10));
    expect(published).toBe(false);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    yield* Fiber.join(publishFiber);
    expect(published).toBe(true);
  }),
);

testClockEffect("an invocation that arrives while publishing waits, then runs", () =>
  Effect.gen(function* () {
    const gate = yield* makePublicationGate();
    const holdPublish = yield* Deferred.make<void>();
    const order: string[] = [];

    const publishFiber = yield* Effect.forkChild(
      gate.withPublish(
        Effect.void,
        () =>
          Effect.gen(function* () {
            order.push("publish-enter");
            yield* Deferred.await(holdPublish);
            order.push("publish-exit");
          }),
        Effect.void,
      ),
    );
    yield* Effect.yieldNow;

    const admitFiber = yield* Effect.forkChild(
      gate.admit(
        Effect.sync(() => {
          order.push("admit");
        }),
      ),
    );
    yield* Effect.yieldNow;
    expect(order).toEqual(["publish-enter"]);

    yield* Deferred.succeed(holdPublish, undefined);
    yield* Fiber.join(publishFiber);
    yield* Fiber.join(admitFiber);
    expect(order).toEqual(["publish-enter", "publish-exit", "admit"]);
  }),
);

testClockEffect(
  "when the bound passes, publish fails with PluginPublishTimedOut and Discard runs",
  () =>
    Effect.gen(function* () {
      const gate = yield* makePublicationGate();
      const discarded = yield* Deferred.make<void>();
      const holdAdmission = yield* Deferred.make<void>();

      yield* Effect.forkChild(gate.admit(Deferred.await(holdAdmission)));
      yield* Effect.yieldNow;

      const fiber = yield* Effect.forkChild(
        gate.withPublish(
          Effect.void,
          () => Effect.succeed("published"),
          Deferred.succeed(discarded, undefined),
        ),
      );
      yield* TestClock.adjust(Duration.millis(PLUGIN_SESSION_RUN_TIMEOUT_MS));
      const result = yield* Fiber.join(fiber).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const tagged = Cause.findErrorOption(result.cause);
        expect(Option.isSome(tagged) && S.is(PluginPublishTimedOut)(tagged.value)).toBe(true);
      }
      yield* Deferred.await(discarded);

      let ran = false;
      const waiting = yield* Effect.forkChild(
        gate.admit(
          Effect.sync(() => {
            ran = true;
          }),
        ),
      );
      yield* Deferred.succeed(holdAdmission, undefined);
      yield* Fiber.join(waiting);
      expect(ran).toBe(true);
    }),
);

testClockEffect("interrupted reload reopens the gate", () =>
  Effect.gen(function* () {
    const gate = yield* makePublicationGate();
    const discarded = yield* Deferred.make<void>();
    const holdAdmission = yield* Deferred.make<void>();
    yield* Effect.forkChild(gate.admit(Deferred.await(holdAdmission)));
    yield* Effect.yieldNow;

    const fiber = yield* Effect.forkChild(
      gate.withPublish(Effect.void, () => Effect.never, Deferred.succeed(discarded, undefined)),
    );
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(discarded);

    yield* Deferred.succeed(holdAdmission, undefined);
    yield* gate.admit(Effect.void);
  }),
);

testClockEffect(
  "two concurrent publishers run prepare/publish one after the other; admissions blocked only during each publish",
  () =>
    Effect.gen(function* () {
      const gate = yield* makePublicationGate();
      const order: string[] = [];
      const holdFirstPrepare = yield* Deferred.make<void>();
      const holdFirstPublish = yield* Deferred.make<void>();
      const secondPrepareEntered = yield* Deferred.make<void>();

      const first = yield* Effect.forkChild(
        gate.withPublish(
          Effect.gen(function* () {
            order.push("first-prepare");
            yield* Deferred.await(holdFirstPrepare);
          }),
          () =>
            Effect.gen(function* () {
              order.push("first-publish");
              yield* Deferred.await(holdFirstPublish);
              order.push("first-done");
            }),
          Effect.void,
        ),
      );
      yield* Effect.yieldNow;
      expect(order).toEqual(["first-prepare"]);

      // Admissions still flow during the first prepare.
      yield* gate.admit(
        Effect.sync(() => {
          order.push("admit-during-prepare");
        }),
      );

      const second = yield* Effect.forkChild(
        gate.withPublish(
          Effect.gen(function* () {
            order.push("second-prepare");
            yield* Deferred.succeed(secondPrepareEntered, undefined);
          }),
          () =>
            Effect.sync(() => {
              order.push("second-publish");
            }),
          Effect.void,
        ),
      );
      yield* Effect.yieldNow;
      // Second publisher waits on the slot — not yet preparing.
      expect(order).toEqual(["first-prepare", "admit-during-prepare"]);

      yield* Deferred.succeed(holdFirstPrepare, undefined);
      yield* Effect.yieldNow;
      expect(order).toContain("first-publish");
      expect(order).not.toContain("second-prepare");

      // Admissions wait while the first is publishing.
      const lateAdmit = yield* Effect.forkChild(
        gate.admit(
          Effect.sync(() => {
            order.push("admit-after");
          }),
        ),
      );
      yield* Effect.yieldNow;
      expect(order).not.toContain("admit-after");

      yield* Deferred.succeed(holdFirstPublish, undefined);
      yield* Fiber.join(first);
      yield* Deferred.await(secondPrepareEntered);
      yield* Fiber.join(second);
      yield* Fiber.join(lateAdmit);

      expect(order).toEqual([
        "first-prepare",
        "admit-during-prepare",
        "first-publish",
        "first-done",
        "second-prepare",
        "second-publish",
        "admit-after",
      ]);
    }),
);

testClockEffect("publish receives the value prepare returned", () =>
  Effect.gen(function* () {
    const gate = yield* makePublicationGate();
    const result = yield* gate.withPublish(
      Effect.succeed({ failures: ["a"] as const }),
      (prepared) => Effect.succeed({ ok: true as const, failures: prepared.failures }),
      Effect.void,
    );
    expect(result).toEqual({ ok: true, failures: ["a"] });
  }),
);
