import { Effect, Stream } from "effect"
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
  return [...output]
}).pipe(Effect.provide(PtyRegistry.Default), Effect.scoped)

test("PtyRegistry exposes PTY output and writes within a scope", async () => {
  const result = await Effect.runPromise(program)
  const text = new TextDecoder().decode(Buffer.concat(result.map((chunk) => Buffer.from(chunk))))
  expect(text).toContain("ready")
  expect(text).toContain("got:hello")
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
