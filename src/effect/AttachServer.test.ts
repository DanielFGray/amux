import { Effect } from "effect"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AttachHub } from "./AttachHub.ts"
import { decodeAttachFrames, encodeAttachFrame, type AttachFrame } from "./AttachProtocol.ts"
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
      const input: Array<{ client: string; frame: AttachFrame }> = []
      const server = yield* startAttachServer({
        path,
        idleTimeoutSeconds: 60,
        onFrame: (client, frame) =>
          Effect.sync(() => input.push({ client, frame })),
      })
      const messages: string[] = []
      const first = yield* Effect.promise(() => connect(path, (message) => messages.push(message)))
      yield* Effect.promise(() => Bun.sleep(25))
      yield* hub.publish({ _tag: "output", session: "agent-1", data: new Uint8Array([1, 2, 3]) })
      yield* Effect.promise(() => Bun.sleep(25))

      first.write(encodeAttachFrame({
        _tag: "input",
        session: "agent-1",
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

  const messages = decodeAttachFrames(result.messages.join("")).frames
  const secondMessages = decodeAttachFrames(result.secondMessages.join("")).frames
  expect(messages).toContainEqual({
    _tag: "output",
    session: "agent-1",
    data: new Uint8Array([1, 2, 3]),
  })
  expect(messages).toContainEqual({ _tag: "pong", nonce: "heartbeat-1" })
  expect(result.input).toContainEqual({
    client: "test-client",
    frame: {
      _tag: "input",
      session: "agent-1",
      data: new Uint8Array([13]),
    },
  })
  expect(secondMessages).toContainEqual({
    _tag: "error",
    message: "client 'test-client' is already attached",
  })
  result.server.stop(true)
  await rm(root, { recursive: true, force: true })
})
