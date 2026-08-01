import { Effect, Stream } from "effect"
import { expect, test } from "bun:test"
import { AttachHub } from "./AttachHub.ts"

test("AttachHub fans frames out and removes subscriptions with scope", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub
      const one = yield* hub.subscribe("one")
      const two = yield* hub.subscribe("two")
      yield* hub.publish({ _tag: "hello", client: "daemon" })
      const [oneFrames, twoFrames] = yield* Effect.all([
        Stream.runCollect(one.frames.pipe(Stream.take(1))),
        Stream.runCollect(two.frames.pipe(Stream.take(1))),
      ])
      return { one: [...oneFrames], two: [...twoFrames] }
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  )

  expect(result.one).toEqual([{ _tag: "hello", client: "daemon" }])
  expect(result.two).toEqual([{ _tag: "hello", client: "daemon" }])
})

test("AttachHub rejects duplicate client ids", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub
      yield* hub.subscribe("same")
      return yield* hub.subscribe("same").pipe(Effect.either)
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  )

  expect(result._tag).toBe("Left")
})

test("targeted replay requires the live connection token", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub
      const subscription = yield* hub.subscribe("same", "new")
      yield* hub.publishTo("same", "old", { _tag: "hello", client: "stale" })
      yield* hub.publishTo("same", "new", { _tag: "hello", client: "current" })
      return yield* Stream.runCollect(subscription.frames.pipe(Stream.take(1)))
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  )

  expect([...result]).toEqual([{ _tag: "hello", client: "current" }])
})
