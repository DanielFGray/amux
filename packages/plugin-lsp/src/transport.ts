import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { Deferred, Effect, PubSub, Ref, Schema as S, Semaphore, Stream } from "effect";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const JsonRpcId = S.Union([S.String, S.Finite]);

/** Routing fields of a JSON-RPC message; params/result stay on the frame for method Schemas. */
const JsonRpcHeading = S.Struct({
  jsonrpc: S.Literal("2.0"),
  id: S.optional(JsonRpcId),
  method: S.optional(S.String),
  error: S.optional(
    S.Struct({
      code: S.Finite,
      message: S.String,
    }),
  ),
});

export class LspTransportError extends S.TaggedError<LspTransportError>()("LspTransportError", {
  message: S.String,
}) {}

/**
 * Server→client notification. `frameJson` is the full JSON-RPC message text;
 * subscribers decode `params` with the method's Schema via fromJsonString.
 */
export interface LspNotification {
  readonly method: string;
  readonly frameJson: string;
}

export interface LspTransport {
  readonly pid: number;
  readonly notifications: Stream.Stream<LspNotification>;
  readonly request: <A, I, O, OI>(
    method: string,
    params: A,
    paramsSchema: S.Codec<A, I>,
    resultSchema: S.Codec<O, OI>,
  ) => Effect.Effect<O, LspTransportError>;
  readonly notify: <A, I>(
    method: string,
    params: A,
    paramsSchema: S.Codec<A, I>,
  ) => Effect.Effect<void, LspTransportError>;
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
    new Map<string | number, Deferred.Deferred<string, LspTransportError>>(),
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

  const route = Effect.fnUntraced(function* (frame: string) {
    const message = yield* S.decodeEffect(S.fromJsonString(JsonRpcHeading))(frame).pipe(
      Effect.mapError((error) => new LspTransportError({ message: String(error) })),
    );
    const id = message.id;
    if (id !== undefined) {
      const reply = yield* Ref.modify(pending, (current) => {
        const next = new Map(current);
        const value = next.get(id);
        next.delete(id);
        return [value, next];
      });
      if (!reply) return;
      if (message.error !== undefined) {
        yield* Deferred.fail(reply, new LspTransportError({ message: message.error.message }));
        return;
      }
      yield* Deferred.succeed(reply, frame);
      return;
    }
    if (message.method !== undefined) {
      yield* PubSub.publish(notifications, {
        method: message.method,
        frameJson: frame,
      });
    }
  });

  const writeJson = Effect.fnUntraced(function* (body: string) {
    const bytes = encoder.encode(body);
    if (bytes.byteLength > MAX_FRAME_BYTES)
      return yield* new LspTransportError({ message: "LSP message exceeds frame limit" });
    const header = encoder.encode(`Content-Length: ${bytes.byteLength}\r\n\r\n`);
    const frame = new Uint8Array(header.byteLength + bytes.byteLength);
    frame.set(header);
    frame.set(bytes, header.byteLength);
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
        (): Uint8Array<ArrayBufferLike> => new Uint8Array(0),
        (buffer, chunk) => {
          const parsed = decodeFrames(append(buffer, chunk));
          return parsed._tag === "error"
            ? Effect.fail(new LspTransportError({ message: parsed.message }))
            : Effect.succeed([parsed.rest, parsed.frames]);
        },
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

  const notify = <A, I>(
    method: string,
    params: A,
    paramsSchema: S.Codec<A, I>,
  ): Effect.Effect<void, LspTransportError> =>
    S.encodeEffect(
      S.fromJsonString(
        S.Struct({
          jsonrpc: S.Literal("2.0"),
          method: S.String,
          params: paramsSchema,
        }),
      ),
    )({ jsonrpc: "2.0", method, params }).pipe(
      Effect.mapError((error) => new LspTransportError({ message: String(error) })),
      Effect.flatMap(writeJson),
    );

  const request = <A, I, O, OI>(
    method: string,
    params: A,
    paramsSchema: S.Codec<A, I>,
    resultSchema: S.Codec<O, OI>,
  ): Effect.Effect<O, LspTransportError> =>
    Effect.gen(function* () {
      const stopped = yield* Ref.get(terminalError);
      if (stopped) return yield* stopped;
      const id = yield* Ref.updateAndGet(nextId, (value) => value + 1);
      const reply = yield* Deferred.make<string, LspTransportError>();
      yield* Ref.update(pending, (current) => new Map(current).set(id, reply));
      const frameJson = yield* S.encodeEffect(
        S.fromJsonString(
          S.Struct({
            jsonrpc: S.Literal("2.0"),
            id: JsonRpcId,
            method: S.String,
            params: paramsSchema,
          }),
        ),
      )({ jsonrpc: "2.0", id, method, params }).pipe(
        Effect.mapError((error) => new LspTransportError({ message: String(error) })),
        Effect.flatMap(writeJson),
        Effect.andThen(Deferred.await(reply)),
        Effect.ensuring(
          Ref.update(pending, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        ),
      );
      const decoded = yield* S.decodeEffect(S.fromJsonString(S.Struct({ result: resultSchema })))(
        frameJson,
      ).pipe(Effect.mapError((error) => new LspTransportError({ message: String(error) })));
      return decoded.result;
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
