import { Effect } from "effect"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AttachHub } from "./AttachHub.ts"
import { encodeAttachFrame } from "./AttachProtocol.ts"
import { startAttachServer } from "./AttachServer.ts"

const connect = (path: string, onData: (text: string) => void) =>
  Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      open(socket) {
        socket.write(encodeAttachFrame({ _tag: "hello", client: "test-client" }))
      },
      data(_socket, data) {
        onData(data.toString("utf8"))
      },
    },
  })

test("native attach server routes output and releases clients on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-attach-"))
  const path = join(root, "attach.sock")
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub
      const input: string[] = []
      const server = yield* startAttachServer({
        path,
        onFrame: (client, frame) =>
          Effect.sync(() => input.push(`${client}:${frame._tag}`)),
      })
      const messages: string[] = []
      const first = yield* Effect.promise(() => connect(path, (message) => messages.push(message)))
      yield* Effect.promise(() => Bun.sleep(25))
      yield* hub.publish({ _tag: "output", agent: "agent-1", data: new Uint8Array([1, 2, 3]) })
      yield* Effect.promise(() => Bun.sleep(25))

      first.write(encodeAttachFrame({
        _tag: "input",
        agent: "agent-1",
        data: new Uint8Array([13]),
      }))
      first.write(encodeAttachFrame({ _tag: "ping", nonce: "heartbeat-1" }))
      yield* Effect.promise(() => Bun.sleep(25))

      const secondMessages: string[] = []
      const second = yield* Effect.promise(() => connect(path, (message) => secondMessages.push(message)))
      yield* Effect.promise(() => Bun.sleep(25))
      first.end()
      yield* Effect.promise(() => Bun.sleep(25))
      const third = yield* Effect.promise(() => connect(path, () => {}))
      yield* Effect.promise(() => Bun.sleep(25))
      second.end()
      third.end()

      return { messages, secondMessages, input, server }
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  )

  expect(result.messages.join("")).toContain('"_tag":"output"')
  expect(result.messages.join("")).toContain('"agent":"agent-1"')
  expect(result.messages.join("")).toContain('"_tag":"pong"')
  expect(result.input).toEqual(["test-client:input"])
  expect(result.secondMessages.join("")).toContain("already attached")
  result.server.stop(true)
  await rm(root, { recursive: true, force: true })
})
