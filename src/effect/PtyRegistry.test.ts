import { Effect, Fiber, Stream } from "effect"
import { expect, test } from "bun:test"
import { PtyRegistry } from "./PtyRegistry.ts"

const program = Effect.gen(function* () {
  const registry = yield* PtyRegistry
  const pty = yield* registry.spawn({
    id: "effect-pty",
    cmd: ["bash", "-c", "printf 'ready\\n'; read line; printf 'got:%s\\n' \"$line\""],
    cols: 80,
    rows: 24,
  })

  yield* pty.write("hello\n")
  const output = yield* Stream.runCollect(pty.output)
  const exit = yield* pty.exit
  return { output: [...output], exit }
}).pipe(Effect.provide(PtyRegistry.Default), Effect.scoped)

test("PtyRegistry exposes PTY output and writes within a scope", async () => {
  const result = await Effect.runPromise(program)
  const text = new TextDecoder().decode(Buffer.concat(result.output.map((chunk) => Buffer.from(chunk))))
  expect(text).toContain("ready")
  expect(text).toContain("got:hello")
  expect(result.exit).toBe(0)
})

test("PtyRegistry releases sessions when the scope closes", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* PtyRegistry
      yield* registry.spawn({ id: "scoped-pty", cmd: ["sleep", "10"], cols: 80, rows: 24 })
      return yield* registry.sessions
    }).pipe(Effect.provide(PtyRegistry.Default), Effect.scoped),
  )

  expect(result).toEqual(new Set(["scoped-pty"]))
})

test("a non-reading child cannot wedge writes, kill, or another session", async () => {
  const result = await Promise.race([
    Effect.runPromise(
      Effect.gen(function* () {
      const registry = yield* PtyRegistry
      const blocked = yield* registry.spawn({
        id: "blocked-pty",
        cmd: ["sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      })
      const pendingWrite = yield* Effect.fork(Effect.exit(blocked.write("x".repeat(16 * 1024 * 1024))))

      // Give the nonblocking writer a chance to fill the child's input queue.
      yield* Effect.sleep(20)
      const other = yield* registry.spawn({
        id: "responsive-pty",
        cmd: ["sh", "-c", "printf 'responsive\\n'"],
        cols: 80,
        rows: 24,
      })
      const output = yield* Stream.runCollect(other.output)

      // This must interrupt the pending write instead of waiting behind it in
      // the blocked session's command mailbox.
      yield* blocked.kill
      const pendingResult = yield* Fiber.join(pendingWrite)
      expect(pendingResult._tag).toBe("Failure")
      return new TextDecoder().decode(Buffer.concat([...output].map((chunk) => Buffer.from(chunk))))
      }).pipe(Effect.provide(PtyRegistry.Default), Effect.scoped),
    ),
    Bun.sleep(3000).then(() => { throw new Error("registry responsiveness deadline exceeded") }),
  ])

  expect(result).toContain("responsive")
})

test("interrupting a registry write cancels the PTY operation", async () => {
  const result = await Promise.race([
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PtyRegistry
        const pty = yield* registry.spawn({
          id: "interruptible-pty",
          cmd: ["sh", "-c", "sleep 30"],
          cols: 80,
          rows: 24,
        })
        const write = yield* Effect.fork(pty.write("x".repeat(16 * 1024 * 1024)))
        yield* Effect.sleep(25)
        yield* Fiber.interrupt(write)
        const exit = yield* Fiber.await(write)
        yield* pty.kill
        return exit._tag
      }).pipe(Effect.provide(PtyRegistry.Default), Effect.scoped),
    ),
    Bun.sleep(3000).then(() => { throw new Error("interruptibility deadline exceeded") }),
  ])

  expect(result).toBe("Failure")
})
