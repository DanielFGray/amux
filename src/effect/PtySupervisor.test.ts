import { Effect, Layer, Stream } from "effect"
import { expect, test } from "bun:test"
import { AttachHub } from "./AttachHub.ts"
import { PtySupervisor, PtySupervisorLive } from "./PtySupervisor.ts"

test("PtySupervisor publishes owned PTY output and exit frames", async () => {
  const frames = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub
      const subscription = yield* hub.subscribe("client")
      const supervisor = yield* PtySupervisor
      yield* supervisor.spawn({
        id: "supervised-agent",
        cmd: ["bash", "-c", "printf 'hello\\n'; exit 7"],
        cols: 80,
        rows: 24,
      })
      return yield* Stream.runCollect(subscription.frames.pipe(Stream.take(2)))
    }).pipe(
      Effect.provide(PtySupervisorLive),
      Effect.provide(AttachHub.Default),
      Effect.scoped,
    ),
  )

  const values = [...frames]
  expect(values[0]?._tag).toBe("output")
  expect(values[1]).toEqual({ _tag: "exit", agent: "supervised-agent", code: 7 })
})

test("PtySupervisor routes input through the managed PTY", async () => {
  const frames = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub
      const subscription = yield* hub.subscribe("client")
      const supervisor = yield* PtySupervisor
      yield* supervisor.spawn({
        id: "input-agent",
        cmd: ["bash", "-c", "read line; printf 'got:%s\\n' \"$line\""],
        cols: 80,
        rows: 24,
      })
      yield* supervisor.handle({ _tag: "input", agent: "input-agent", data: new Uint8Array([104, 105, 10]) })
      return yield* Stream.runCollect(subscription.frames.pipe(Stream.take(2)))
    }).pipe(
      Effect.provide(PtySupervisorLive),
      Effect.provide(AttachHub.Default),
      Effect.scoped,
    ),
  )

  const values = [...frames]
  expect(values[0]?._tag).toBe("output")
  expect(values[0]?._tag === "output" && new TextDecoder().decode(values[0].data)).toContain("got:hi")
  expect(values[1]).toEqual({ _tag: "exit", agent: "input-agent", code: 0 })
})
