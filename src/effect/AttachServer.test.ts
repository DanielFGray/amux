import { Clock, Effect, Exit, Scope } from "effect";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachHub } from "./AttachHub.ts";
import { decodeAttachFrames, encodeAttachFrame, type AttachFrame } from "./AttachProtocol.ts";
import { createAttachWriter, startAttachServer } from "./AttachServer.ts";
import { createSocketWriter } from "../attach-write.ts";

const concatenate = (parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

test("attach writer resumes partial writes without interleaving frames", async () => {
  const writes: Uint8Array[] = [];
  const limits = [2, 1, 7, 3, 1000];
  const writer = createAttachWriter(
    {
      write(data, offset = 0, length = (data as Uint8Array).byteLength - offset) {
        const bytes = data as Uint8Array;
        const count = Math.min(length, limits.shift() ?? 1000);
        writes.push(new Uint8Array(bytes.buffer, bytes.byteOffset + offset, count).slice());
        return count;
      },
    },
    () => {
      throw new Error("unexpected overload");
    },
  );

  expect(writer.send({ _tag: "output", session: "one", data: new Uint8Array([1]) })).toBe(true);
  expect(writer.send({ _tag: "output", session: "two", data: new Uint8Array([2]) })).toBe(true);
  for (let index = 0; index < 10; index++) writer.drain();
  const wire = new TextDecoder().decode(concatenate(writes));
  const received = decodeAttachFrames(wire).frames;
  expect(received).toEqual([
    { _tag: "output", session: "one", data: new Uint8Array([1]) },
    { _tag: "output", session: "two", data: new Uint8Array([2]) },
  ]);
});

test("attach writer waits for drain after zero and closes on -1 or throw", () => {
  const bytes = new TextEncoder().encode("abcdef");
  const calls: number[] = [];
  const limits = [0, 2, -1];
  let closed = 0;
  const writer = createSocketWriter(
    {
      write(_data, _offset, length) {
        calls.push(length);
        const result = limits.shift()!;
        if (result === -1) return -1;
        return result;
      },
    },
    () => {
      closed += 1;
    },
  );

  expect(writer.send(bytes)).toBe(true);
  expect(calls).toEqual([6]);
  writer.drain();
  expect(calls).toEqual([6, 6]);
  writer.drain();
  expect(calls).toEqual([6, 6, 4]);
  expect(writer.closed).toBe(true);
  expect(closed).toBe(1);
  writer.drain();
  expect(calls).toHaveLength(3);

  let thrown = 0;
  const throwing = createSocketWriter(
    {
      write() {
        throw new Error("closed");
      },
    },
    () => {
      thrown += 1;
    },
  );
  expect(throwing.send(bytes)).toBe(false);
  expect(throwing.closed).toBe(true);
  expect(thrown).toBe(1);
});

test("attach writer closes after a partial error frame is fully flushed", () => {
  const writes: Uint8Array[] = [];
  const limits = [3, 0, 100];
  let closed = 0;
  let flushed = 0;
  const writer = createAttachWriter(
    {
      write(data, offset = 0, length = (data as Uint8Array).byteLength - offset) {
        const bytes = data as Uint8Array;
        const count = Math.min(length, limits.shift() ?? 100);
        writes.push(new Uint8Array(bytes.buffer, bytes.byteOffset + offset, count).slice());
        return count;
      },
    },
    () => {
      closed += 1;
    },
  );

  expect(writer.send({ _tag: "error", message: "rejected" })).toBe(true);
  writer.closeAfterFlush(() => {
    flushed += 1;
  });
  expect(flushed).toBe(0);
  writer.drain();
  expect(flushed).toBe(0);
  writer.drain();
  expect(flushed).toBe(1);
  expect(closed).toBe(0);
  expect(decodeAttachFrames(new TextDecoder().decode(concatenate(writes))).frames).toEqual([
    { _tag: "error", message: "rejected" },
  ]);
});

test("attach writer pauses on zero and closes only at byte overflow", () => {
  let overloaded = 0;
  const slow = createAttachWriter(
    { write: () => 0 },
    () => {
      overloaded += 1;
    },
    1024,
  );
  const fastBytes: Uint8Array[] = [];
  const fast = createAttachWriter(
    {
      write(data, offset = 0, length = (data as Uint8Array).byteLength - offset) {
        const bytes = data as Uint8Array;
        fastBytes.push(new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length).slice());
        return length;
      },
    },
    () => {
      throw new Error("fast client overloaded");
    },
  );

  expect(slow.send({ _tag: "output", session: "slow", data: new Uint8Array([1]) })).toBe(true);
  expect(slow.closed).toBe(false);
  slow.drain();
  expect(slow.closed).toBe(false);
  expect(slow.send({ _tag: "output", session: "slow", data: new Uint8Array(1024) })).toBe(false);
  expect(slow.closed).toBe(true);
  expect(overloaded).toBe(1);
  expect(fast.send({ _tag: "output", session: "fast", data: new Uint8Array([2]) })).toBe(true);
  expect(decodeAttachFrames(new TextDecoder().decode(concatenate(fastBytes))).frames).toEqual([
    { _tag: "output", session: "fast", data: new Uint8Array([2]) },
  ]);
});

test("one blocked session handler does not stall another session on the same socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-attach-lanes-"));
  const path = join(root, "attach.sock");
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startAttachServer({
        path,
        onFrame: (_client, frame) =>
          frame._tag === "input" && frame.session === "slow" ? Effect.sleep(200) : Effect.void,
      });
      const messages: string[] = [];
      const socket = yield* Effect.promise(() =>
        connect(path, (message) => messages.push(message)),
      );
      socket.write(
        encodeAttachFrame({ _tag: "input", session: "slow", data: new Uint8Array([1]) }),
      );
      socket.write(encodeAttachFrame({ _tag: "ping", nonce: "fast" }));
      yield* waitUntil(() => messages.join("").includes("fast"));
      socket.end();
      return { messages, server };
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(decodeAttachFrames(result.messages.join("")).frames).toContainEqual({
    _tag: "pong",
    nonce: "fast",
  });
  result.server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const connect = (path: string, onData: (text: string) => void, onClose?: () => void) =>
  Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      open(socket) {
        socket.write(encodeAttachFrame({ _tag: "hello", client: "test-client" }));
      },
      data(_socket, data) {
        onData(data.toString("utf8"));
      },
      close() {
        onClose?.();
      },
    },
  });

const waitUntil = (predicate: () => boolean, timeout = 500) =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("condition was not met");
      await Bun.sleep(5);
    }
  });

test("native attach server routes output and releases clients on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-attach-"));
  const path = join(root, "attach.sock");
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub;
      const input: Array<{ client: string; frame: AttachFrame }> = [];
      const server = yield* startAttachServer({
        path,
        idleTimeoutSeconds: 60,
        onFrame: (client, frame) => Effect.sync(() => input.push({ client, frame })),
      });
      const messages: string[] = [];
      const first = yield* Effect.promise(() => connect(path, (message) => messages.push(message)));
      yield* Effect.promise(() => Bun.sleep(25));
      yield* hub.publish({ _tag: "output", session: "agent-1", data: new Uint8Array([1, 2, 3]) });
      yield* Effect.promise(() => Bun.sleep(25));

      first.write(
        encodeAttachFrame({
          _tag: "input",
          session: "agent-1",
          data: new Uint8Array([13]),
        }),
      );
      first.write(encodeAttachFrame({ _tag: "ping", nonce: "heartbeat-1" }));
      yield* Effect.promise(() => Bun.sleep(25));

      const secondMessages: string[] = [];
      const second = yield* Effect.promise(() =>
        connect(path, (message) => secondMessages.push(message)),
      );
      yield* Effect.promise(() => Bun.sleep(25));
      first.end();
      yield* Effect.promise(() => Bun.sleep(25));
      const third = yield* Effect.promise(() => connect(path, () => {}));
      yield* Effect.promise(() => Bun.sleep(25));
      second.end();
      third.end();

      return { messages, secondMessages, input, server };
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  );

  const messages = decodeAttachFrames(result.messages.join("")).frames;
  const secondMessages = decodeAttachFrames(result.secondMessages.join("")).frames;
  expect(messages).toContainEqual({
    _tag: "output",
    session: "agent-1",
    data: new Uint8Array([1, 2, 3]),
  });
  expect(messages).toContainEqual({ _tag: "pong", nonce: "heartbeat-1" });
  expect(result.input).toContainEqual({
    client: "test-client",
    frame: {
      _tag: "input",
      session: "agent-1",
      data: new Uint8Array([13]),
    },
  });
  expect(secondMessages).toContainEqual({
    _tag: "error",
    message: "client 'test-client' is already attached",
  });
  result.server.stop(true);
  await rm(root, { recursive: true, force: true });
});

test("inbound traffic resets the idle deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-attach-timeout-"));
  const path = join(root, "attach.sock");
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      let detached = 0;
      const server = yield* startAttachServer({
        path,
        idleTimeoutSeconds: 0.2,
        onDetach: () =>
          Effect.sync(() => {
            detached += 1;
          }),
      });
      const socket = yield* Effect.promise(() => connect(path, () => {}));
      yield* Effect.promise(() => Bun.sleep(120));
      socket.write(encodeAttachFrame({ _tag: "ping", nonce: "still-here" }));
      yield* Effect.promise(() => Bun.sleep(120));
      const detachedBeforeResetDeadline = detached;
      yield* Effect.promise(() => Bun.sleep(120));
      return { detached, detachedBeforeResetDeadline, server, socket };
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(result.detachedBeforeResetDeadline).toBe(0);
  expect(result.detached).toBe(1);
  result.socket.end();
  result.server.stop(true);
  await rm(root, { recursive: true, force: true });
});

test("closing cancels the idle deadline and detaches exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-attach-timeout-close-"));
  const path = join(root, "attach.sock");
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      let detached = 0;
      const server = yield* startAttachServer({
        path,
        idleTimeoutSeconds: 0.1,
        onDetach: () =>
          Effect.sync(() => {
            detached += 1;
          }),
      });
      const socket = yield* Effect.promise(() => connect(path, () => {}));
      yield* Effect.promise(() => Bun.sleep(20));
      socket.end();
      yield* Effect.promise(() => Bun.sleep(40));
      const detachedOnClose = detached;
      yield* Effect.promise(() => Bun.sleep(120));
      return { detached, detachedOnClose, server };
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(result.detachedOnClose).toBe(1);
  expect(result.detached).toBe(1);
  result.server.stop(true);
  await rm(root, { recursive: true, force: true });
});

test("inbound traffic interrupts the replaced idle deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-attach-deadline-interrupt-"));
  const path = join(root, "attach.sock");
  let sleeps = 0;
  let interrupted = 0;
  const clock = {
    ...Clock.make(),
    sleep: () =>
      Effect.async<void>(() => {
        sleeps += 1;
        return Effect.sync(() => {
          interrupted += 1;
        });
      }),
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startAttachServer({ path });
      const socket = yield* Effect.promise(() => connect(path, () => {}));
      yield* waitUntil(() => sleeps >= 1);
      const beforePing = interrupted;
      socket.write(encodeAttachFrame({ _tag: "ping", nonce: "replace" }));
      yield* waitUntil(() => interrupted > beforePing && sleeps >= 2);
      return { interruptedBeforeClose: interrupted, server, socket };
    }).pipe(Effect.withClock(clock), Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(result.interruptedBeforeClose).toBeGreaterThan(0);
  result.socket.end();
  result.server.stop(true);
  await rm(root, { recursive: true, force: true });
});

test("client close interrupts a blocked frame callback before detach", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-attach-frame-close-"));
  const path = join(root, "attach.sock");
  let started = 0;
  let finalized = 0;
  let postClose = 0;
  let detached = 0;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startAttachServer({
        path,
        onFrame: () =>
          Effect.sync(() => {
            started += 1;
          }).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized += 1;
              }),
            ),
            Effect.andThen(
              Effect.sync(() => {
                postClose += 1;
              }),
            ),
          ),
        onDetach: () =>
          Effect.sync(() => {
            detached += 1;
          }),
      });
      const socket = yield* Effect.promise(() => connect(path, () => {}));
      yield* Effect.promise(() => Bun.sleep(20));
      socket.write(
        encodeAttachFrame({ _tag: "input", session: "blocked", data: new Uint8Array([1]) }),
      );
      yield* waitUntil(() => started === 1);
      socket.end();
      yield* waitUntil(() => finalized === 1 && detached === 1);
      return { detached, finalized, postClose, server };
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(result.finalized).toBe(1);
  expect(result.detached).toBe(1);
  expect(result.postClose).toBe(0);
  result.server.stop(true);
  await rm(root, { recursive: true, force: true });
});

test("server close delivers remote EOF and joins detach cleanup exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-attach-server-close-"));
  const path = join(root, "attach.sock");
  let started = 0;
  let finalized = 0;
  let postClose = 0;
  let detached = 0;
  let detachFinished = 0;
  let remoteClosed = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const serverScope = yield* Scope.make();
      yield* Scope.extend(
        startAttachServer({
          path,
          onSync: () =>
            Effect.sync(() => {
              started += 1;
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
              Effect.andThen(
                Effect.sync(() => {
                  postClose += 1;
                }),
              ),
            ),
          onDetach: () =>
            Effect.sync(() => {
              detached += 1;
            }).pipe(
              Effect.andThen(Effect.sleep(20)),
              Effect.andThen(
                Effect.sync(() => {
                  detachFinished += 1;
                }),
              ),
            ),
        }),
        serverScope,
      );
      const socket = yield* Effect.promise(() =>
        connect(
          path,
          () => {},
          () => {
            remoteClosed += 1;
          },
        ),
      );
      yield* Effect.promise(() => Bun.sleep(20));
      socket.write(encodeAttachFrame({ _tag: "sync", session: "blocked" }));
      yield* waitUntil(() => started === 1);
      yield* Scope.close(serverScope, Exit.succeed(undefined));
      yield* waitUntil(() => remoteClosed === 1);
      socket.end();
      yield* Effect.promise(() => Bun.sleep(50));
    }).pipe(Effect.provide(AttachHub.Default)),
  );

  expect(finalized).toBe(1);
  expect(detached).toBe(1);
  expect(detachFinished).toBe(1);
  expect(remoteClosed).toBe(1);
  expect(postClose).toBe(0);
  await rm(root, { recursive: true, force: true });
});

test("close interrupts asynchronous acceptance and permits reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-attach-accept-race-"));
  const path = join(root, "attach.sock");
  let attached = 0;
  let attachFinalized = 0;
  let attempts = 0;
  let detached = 0;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startAttachServer({
        path,
        onAttach: () =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.never.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      attachFinalized += 1;
                    }),
                  ),
                )
              : Effect.sync(() => {
                  attached += 1;
                });
          }),
        onDetach: () =>
          Effect.sync(() => {
            detached += 1;
          }),
      });
      const first = yield* Effect.promise(() => connect(path, () => {}));
      yield* waitUntil(() => attempts === 1);
      first.end();
      yield* waitUntil(() => attachFinalized === 1 && detached === 1);
      const second = yield* Effect.promise(() => connect(path, () => {}));
      yield* waitUntil(() => attached === 1);
      second.end();
      yield* waitUntil(() => detached === 2);
      return { attached, attachFinalized, detached, server };
    }).pipe(Effect.provide(AttachHub.Default), Effect.scoped),
  );

  expect(result.attached).toBe(1);
  expect(result.attachFinalized).toBe(1);
  expect(result.detached).toBe(2);
  result.server.stop(true);
  await rm(root, { recursive: true, force: true });
});
