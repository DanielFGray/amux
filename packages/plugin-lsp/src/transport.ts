import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { Deferred, Effect, PubSub, Ref, Schema as S, Semaphore, Stream } from "effect";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const JsonRpcId = S.Union([S.String, S.Finite]);
type JsonValue = S.Json;

const JsonRpcMessage = S.Struct({
  jsonrpc: S.Literal("2.0"),
  id: S.optional(JsonRpcId),
  method: S.optional(S.String),
  params: S.optional(S.Json),
  result: S.optional(S.Json),
  error: S.optional(
    S.Struct({
      code: S.Finite,
      message: S.String,
      data: S.optional(S.Json),
    }),
  ),
});
type JsonRpcMessage = typeof JsonRpcMessage.Type;

export class LspTransportError extends S.TaggedError<LspTransportError>()("LspTransportError", {
  message: S.String,
}) {}

export interface LspNotification {
  readonly method: string;
  readonly params?: JsonValue;
}

export interface LspTransport {
  readonly pid: number;
  readonly notifications: Stream.Stream<LspNotification>;
  readonly request: (
    method: string,
    params: JsonValue,
  ) => Effect.Effect<JsonValue, LspTransportError>;
  readonly notify: (method: string, params: JsonValue) => Effect.Effect<void, LspTransportError>;
}

export interface LspTransportOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * Starts one LSP process and owns its native stdio connection for the current
 * scope. LSP uses Content-Length framing, not amux's newline-delimited frames.
 */
export const makeLspTransport = Effect.fnUntraced(function* (options: LspTransportOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner
    .spawn(
      ChildProcess.make(options.command, options.args, {
        cwd: options.cwd,
        stdin: { stream: "pipe", endOnDone: false },
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "1 second",
      }),
    )
    .pipe(Effect.mapError((error) => new LspTransportError({ message: String(error) })));
  const pending = yield* Ref.make(
    new Map<string | number, Deferred.Deferred<JsonValue, LspTransportError>>(),
  );
  const nextId = yield* Ref.make(0);
  const notifications = yield* PubSub.sliding<LspNotification>(64);
  const terminalError = yield* Ref.make<LspTransportError | undefined>(undefined);
  const writer = yield* Semaphore.make(1);

  const failPending = (error: LspTransportError) =>
    Ref.set(terminalError, error).pipe(
      Effect.andThen(Ref.getAndSet(pending, new Map())),
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), (reply) => Deferred.fail(reply, error), { discard: true }),
      ),
    );

  const route = Effect.fnUntraced(function* (message: JsonRpcMessage) {
    const id = message.id;
    if (id !== undefined) {
      const reply = yield* Ref.modify(pending, (current) => {
        const next = new Map(current);
        const value = next.get(id);
        next.delete(id);
        return [value, next] as const;
      });
      if (!reply) return;
      if (message.error !== undefined) {
        yield* Deferred.fail(reply, new LspTransportError({ message: message.error.message }));
        return;
      }
      if (message.result === undefined)
        return yield* Deferred.fail(
          reply,
          new LspTransportError({ message: "LSP response lacks a result" }),
        );
      yield* Deferred.succeed(reply, message.result);
      return;
    }
    if (message.method !== undefined) {
      yield* PubSub.publish(notifications, {
        method: message.method,
        params: message.params,
      });
    }
  });

  const write = Effect.fnUntraced(function* (message: JsonValue) {
    const body = encoder.encode(
      yield* S.encodeEffect(S.fromJsonString(S.Json))(message).pipe(
        Effect.mapError((error) => new LspTransportError({ message: String(error) })),
      ),
    );
    if (body.byteLength > MAX_FRAME_BYTES)
      return yield* new LspTransportError({ message: "LSP message exceeds frame limit" });
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
    const frame = new Uint8Array(header.byteLength + body.byteLength);
    frame.set(header);
    frame.set(body, header.byteLength);
    yield* Stream.make(frame).pipe(
      Stream.run(process.stdin),
      Effect.mapError(
        (error) => new LspTransportError({ message: `LSP stdin failed: ${String(error)}` }),
      ),
      writer.withPermits(1),
    );
  });

  yield* Effect.addFinalizer(() =>
    failPending(new LspTransportError({ message: "LSP transport closed" })).pipe(
      Effect.andThen(PubSub.shutdown(notifications)),
    ),
  );
  yield* Effect.forkScoped(
    process.exitCode.pipe(
      Effect.flatMap((code) =>
        failPending(new LspTransportError({ message: `LSP process exited with code ${code}` })),
      ),
      Effect.ignore,
    ),
  );
  yield* Effect.forkScoped(Stream.runDrain(process.stderr).pipe(Effect.ignore));
  yield* Effect.forkScoped(
    process.stdout.pipe(
      Stream.mapAccumEffect(
        () => new Uint8Array(0) as Uint8Array<ArrayBufferLike>,
        (buffer, chunk) => {
          const parsed = decodeFrames(append(buffer, chunk));
          return parsed._tag === "error"
            ? Effect.fail(new LspTransportError({ message: parsed.message }))
            : Effect.succeed([parsed.rest, parsed.frames] as const);
        },
      ),
      Stream.mapEffect((frame) =>
        S.decodeEffect(S.fromJsonString(JsonRpcMessage))(frame).pipe(
          Effect.mapError((error) => new LspTransportError({ message: String(error) })),
        ),
      ),
      Stream.runForEach(route),
      Effect.catch((error) =>
        failPending(
          S.is(LspTransportError)(error)
            ? error
            : new LspTransportError({ message: `LSP stdout failed: ${String(error)}` }),
        ),
      ),
    ),
  );

  const notify = Effect.fnUntraced(function* (method: string, params: JsonValue) {
    yield* write({ jsonrpc: "2.0", method, params });
  });
  const request = Effect.fnUntraced(function* (method: string, params: JsonValue) {
    const stopped = yield* Ref.get(terminalError);
    if (stopped) return yield* stopped;
    const id = yield* Ref.updateAndGet(nextId, (value) => value + 1);
    const reply = yield* Deferred.make<JsonValue, LspTransportError>();
    yield* Ref.update(pending, (current) => new Map(current).set(id, reply));
    return yield* write({ jsonrpc: "2.0", id, method, params }).pipe(
      Effect.andThen(Deferred.await(reply)),
      Effect.ensuring(
        Ref.update(pending, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
      ),
    );
  });

  return {
    pid: process.pid,
    notifications: Stream.fromPubSub(notifications),
    request,
    notify,
  };
});

type DecodedFrames =
  | { readonly _tag: "frames"; readonly rest: Uint8Array; readonly frames: readonly string[] }
  | { readonly _tag: "error"; readonly message: string };

const decodeFrames = (input: Uint8Array<ArrayBufferLike>): DecodedFrames => {
  const frames: string[] = [];
  let offset = 0;
  while (offset < input.byteLength) {
    const headerEnd = headerEndAt(input, offset);
    if (headerEnd === -1) {
      if (input.byteLength - offset > MAX_FRAME_BYTES)
        return { _tag: "error", message: "LSP header exceeds frame limit" };
      break;
    }
    const length = contentLength(input.subarray(offset, headerEnd));
    if (length === undefined)
      return { _tag: "error", message: "LSP frame lacks a valid Content-Length" };
    const bodyStart = headerEnd + 4;
    if (input.byteLength - bodyStart < length) break;
    frames.push(decoder.decode(input.subarray(bodyStart, bodyStart + length)));
    offset = bodyStart + length;
  }
  return { _tag: "frames", rest: input.slice(offset), frames };
};

const append = (
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> => {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
};

const headerEndAt = (bytes: Uint8Array<ArrayBufferLike>, offset: number): number => {
  for (let index = offset; index <= bytes.byteLength - 4; index++) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    )
      return index;
  }
  return -1;
};

const contentLength = (header: Uint8Array<ArrayBufferLike>): number | undefined => {
  for (const line of decoder.decode(header).split("\r\n")) {
    const [name, value] = line.split(":", 2);
    if (name?.toLowerCase() !== "content-length") continue;
    const length = Number(value?.trim());
    return Number.isSafeInteger(length) && length >= 0 && length <= MAX_FRAME_BYTES
      ? length
      : undefined;
  }
  return undefined;
};
