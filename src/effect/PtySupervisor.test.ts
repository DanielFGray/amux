import { Chunk, Effect, Fiber, Stream } from "effect";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { AttachHub } from "./AttachHub.ts";
import { type AttachFrame } from "./AttachProtocol.ts";
import { PtySupervisor } from "./PtySupervisor.ts";

/**
 * Frames up to and including the session's exit.
 *
 * Taking a fixed count would encode an assumption the PTY does not owe us: how
 * many reads a given burst of output arrives in. A terminal echoes typed input
 * as its own chunk, and a write can be split at any boundary, so the only
 * reliable stopping point is the exit frame.
 */
const untilExit = (frames: Stream.Stream<AttachFrame>) =>
  Stream.runCollect(Stream.takeUntil(frames, (frame) => frame._tag === "exit")).pipe(
    Effect.map(Chunk.toReadonlyArray),
  );

const output = (frames: readonly AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => new TextDecoder().decode(frame.data))
    .join("");

test("PtySupervisor publishes owned PTY output and exit frames", async () => {
  const frames = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub;
      const subscription = yield* hub.subscribe("client");
      const supervisor = yield* PtySupervisor;
      yield* supervisor.spawn({
        id: "supervised-agent",
        cmd: ["bash", "-c", "printf 'hello\\n'; exit 7"],
        cols: 80,
        rows: 24,
      });
      return yield* untilExit(subscription.frames);
    }).pipe(Effect.provide(PtySupervisor.Live), Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(output(frames)).toContain("hello");
  // Exit is last, always: a client that trusts frame order must never be told
  // a session is gone while output for it is still in flight.
  expect(frames.at(-1)).toEqual({ _tag: "exit", session: "supervised-agent", code: 7 });
  expect(frames.slice(0, -1).every((frame) => frame._tag === "output")).toBe(true);
});

test("PtySupervisor routes input through the managed PTY", async () => {
  const frames = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub;
      const subscription = yield* hub.subscribe("client");
      const supervisor = yield* PtySupervisor;
      yield* supervisor.spawn({
        id: "input-agent",
        cmd: ["bash", "-c", "read line; printf 'got:%s\\n' \"$line\""],
        cols: 80,
        rows: 24,
      });
      yield* supervisor.handle({
        _tag: "input",
        session: "input-agent",
        data: new Uint8Array([104, 105, 10]),
      });
      return yield* untilExit(subscription.frames);
    }).pipe(Effect.provide(PtySupervisor.Live), Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(output(frames)).toContain("got:hi");
  expect(frames.at(-1)).toEqual({ _tag: "exit", session: "input-agent", code: 0 });
});

test("concurrent duplicate spawns create one child and one managed session", async () => {
  const marker = `/tmp/herdr-duplicate-${randomUUID()}`;
  const frames = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub;
      const subscription = yield* hub.subscribe("client");
      const supervisor = yield* PtySupervisor;
      const spec = {
        id: "duplicate-agent",
        cmd: ["bash", "-c", `printf x >> ${marker}; sleep 0.2`],
        cols: 80,
        rows: 24,
      } as const;
      const first = yield* Effect.fork(Effect.exit(supervisor.spawn(spec)));
      const second = yield* Effect.exit(supervisor.spawn(spec));
      const firstResult = yield* Fiber.join(first);
      expect([firstResult._tag, second._tag].sort()).toEqual(["Failure", "Success"]);
      expect(String(firstResult._tag === "Failure" ? firstResult : second)).toContain("already live or starting");
      expect(yield* supervisor.live).toEqual(["duplicate-agent"]);
      return yield* untilExit(subscription.frames);
    }).pipe(Effect.provide(PtySupervisor.Live), Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(await readFile(marker, "utf8")).toBe("x");
  await rm(marker, { force: true });
  expect(frames.at(-1)?._tag).toBe("exit");
});

test("exit cleanup releases the session and replay terminal for reuse", async () => {
  const live = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub;
      const subscription = yield* hub.subscribe("client");
      const supervisor = yield* PtySupervisor;
      yield* supervisor.spawn({ id: "reusable-agent", cmd: ["true"], cols: 80, rows: 24 });
      yield* untilExit(subscription.frames);
      expect(yield* supervisor.live).toEqual([]);
      yield* supervisor.spawn({ id: "reusable-agent", cmd: ["true"], cols: 80, rows: 24 });
      return yield* supervisor.live;
    }).pipe(Effect.provide(PtySupervisor.Live), Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(live).toEqual(["reusable-agent"]);
});
