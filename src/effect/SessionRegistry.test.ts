import { Effect, Fiber, Stream } from "effect";
import { expect, it, test } from "@effect/vitest";
import { SessionRegistry } from "./SessionRegistry.ts";

const session = Effect.gen(function* () {
  const registry = yield* SessionRegistry;
  const pty = yield* registry.spawn({
    id: "effect-pty",
    cmd: ["bash", "-c", "printf 'ready\\n'; read line; printf 'got:%s\\n' \"$line\""],
    cols: 80,
    rows: 24,
  });

  yield* pty.write("hello\n");
  const output = yield* Stream.runCollect(pty.output);
  const exit = yield* pty.exit;
  return { output: [...output], exit };
}).pipe(Effect.provide(SessionRegistry.Default));

it.scopedLive("SessionRegistry exposes PTY output and writes within a scope", () =>
  Effect.gen(function* () {
    const result = yield* session;
    const text = new TextDecoder().decode(
      Buffer.concat(result.output.map((chunk) => Buffer.from(chunk))),
    );
    expect(text).toContain("ready");
    expect(text).toContain("got:hello");
    expect(result.exit).toBe(0);
  }),
);

it.scopedLive("SessionRegistry releases sessions when the scope closes", () =>
  Effect.gen(function* () {
    const registry = yield* SessionRegistry;
    yield* registry.spawn({ id: "scoped-pty", cmd: ["sleep", "10"], cols: 80, rows: 24 });
    expect(yield* registry.sessions).toEqual(new Set(["scoped-pty"]));
  }).pipe(Effect.provide(SessionRegistry.Default)),
);

it.scopedLive("SessionRegistry rejects oversized terminals before allocating a PTY", () =>
  Effect.gen(function* () {
    const registry = yield* SessionRegistry;
    const result = yield* Effect.either(
      registry.spawn({
        id: "oversized-pty",
        cmd: ["sh"],
        cols: 1_000_000,
        rows: 1_000_000,
      }),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.operation).toBe("spawn");
  }).pipe(Effect.provide(SessionRegistry.Default)),
);

test("a non-reading child cannot wedge writes, kill, or another session", async () => {
  const result = await Promise.race([
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* SessionRegistry;
        const blocked = yield* registry.spawn({
          id: "blocked-pty",
          cmd: ["sh", "-c", "sleep 30"],
          cols: 80,
          rows: 24,
        });
        const pendingWrite = yield* Effect.fork(
          Effect.exit(blocked.write("x".repeat(16 * 1024 * 1024))),
        );

        // Give the nonblocking writer a chance to fill the child's input queue.
        yield* Effect.sleep(20);
        const other = yield* registry.spawn({
          id: "responsive-pty",
          cmd: ["sh", "-c", "printf 'responsive\\n'"],
          cols: 80,
          rows: 24,
        });
        const output = yield* Stream.runCollect(other.output);

        // Shutdown owns this cancellation and must not report it as a failed
        // daemon operation or wait behind the blocked write.
        yield* blocked.kill;
        const pendingResult = yield* Fiber.join(pendingWrite);
        expect(pendingResult._tag).toBe("Success");
        return new TextDecoder().decode(
          Buffer.concat([...output].map((chunk) => Buffer.from(chunk))),
        );
      }).pipe(Effect.provide(SessionRegistry.Default), Effect.scoped),
    ),
    Bun.sleep(3000).then(() => {
      throw new Error("registry responsiveness deadline exceeded");
    }),
  ]);

  expect(result).toContain("responsive");
});

test("interrupting a registry write cancels the PTY operation", async () => {
  const result = await Promise.race([
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* SessionRegistry;
        const pty = yield* registry.spawn({
          id: "interruptible-pty",
          cmd: ["sh", "-c", "sleep 30"],
          cols: 80,
          rows: 24,
        });
        const write = yield* Effect.fork(pty.write("x".repeat(16 * 1024 * 1024)));
        yield* Effect.sleep(25);
        yield* Fiber.interrupt(write);
        const exit = yield* Fiber.await(write);
        yield* pty.kill;
        return exit._tag;
      }).pipe(Effect.provide(SessionRegistry.Default), Effect.scoped),
    ),
    Bun.sleep(3000).then(() => {
      throw new Error("interruptibility deadline exceeded");
    }),
  ]);

  expect(result).toBe("Failure");
});

it.scopedLive("duplicate reservations fail and failed spawns release the id", () =>
  Effect.gen(function* () {
    const registry = yield* SessionRegistry;
    const first = yield* Effect.fork(
      Effect.exit(
        registry.spawn({
          id: "duplicate-pty",
          cmd: ["sh", "-c", "sleep 30"],
          cols: 80,
          rows: 24,
        }),
      ),
    );
    const second = yield* Effect.exit(
      registry.spawn({
        id: "duplicate-pty",
        cmd: ["sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      }),
    );
    const firstResult = yield* Fiber.join(first);
    expect([firstResult._tag, second._tag].sort()).toEqual(["Failure", "Success"]);
    expect(String(firstResult._tag === "Failure" ? firstResult : second)).toContain(
      "already live or starting",
    );

    const failed = yield* Effect.exit(
      registry.spawn({
        id: "failed-pty",
        cmd: ["true"],
        cwd: "/definitely-not-a-real-directory",
        cols: 80,
        rows: 24,
      }),
    );
    expect(failed._tag).toBe("Failure");
    const retry = yield* registry.spawn({
      id: "failed-pty",
      cmd: ["sh", "-c", "exit 0"],
      cols: 80,
      rows: 24,
    });
    yield* retry.exit;
    const duplicate =
      firstResult._tag === "Success"
        ? firstResult.value
        : second._tag === "Success"
          ? second.value
          : undefined;
    if (duplicate) yield* duplicate.kill.pipe(Effect.ignore);
    expect(yield* registry.sessions).toEqual(new Set(["duplicate-pty"]));
  }).pipe(Effect.provide(SessionRegistry.Default)),
);

it.scopedLive("an agent-kind session registers, lists, and is killed through the same path as a pty", () =>
  Effect.gen(function* () {
    const registry = yield* SessionRegistry;
    const agent = yield* registry.spawn({
      kind: "agent",
      id: "stub-agent",
      cmd: [],
      cols: 80,
      rows: 24,
    });
    expect(agent.kind).toBe("agent");
    expect(yield* registry.sessions).toEqual(new Set(["stub-agent"]));

    yield* agent.kill;
    expect(yield* agent.exit).toBeNull();
    expect(yield* registry.sessions).toEqual(new Set());
  }).pipe(Effect.provide(SessionRegistry.Default)),
);
