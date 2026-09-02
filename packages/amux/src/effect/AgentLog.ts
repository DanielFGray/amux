import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Context, Effect, Layer, PubSub, Schema as S, Scope, Stream } from "effect";
import { AgentEvent, type AgentEventPayload } from "./AttachProtocol.ts";
import { isSessionId } from "../session.ts";
import { errorMessage } from "../error-message.ts";

const Entry = S.Struct({
  sequence: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  event: AgentEvent,
});
const Entries = S.Array(Entry);
type Entry = S.Schema.Type<typeof Entry>;

export class AgentLogError extends S.TaggedError<AgentLogError>()("AgentLogError", {
  message: S.String,
}) {}

export interface AgentLogService {
  readonly append: (frame: AgentEventPayload) => Effect.Effect<AgentEvent, AgentLogError>;
  readonly read: (
    session: string,
    after?: number,
  ) => Effect.Effect<readonly AgentEvent[], AgentLogError>;
  readonly bounds: (
    session: string,
  ) => Effect.Effect<{ readonly oldest: number; readonly latest: number }, AgentLogError>;
  /** Subscribe before reading replay so events cannot be lost at the seam. */
  readonly watch: (
    session: string,
    after?: number,
  ) => Effect.Effect<Stream.Stream<AgentEvent, AgentLogError>, AgentLogError, Scope.Scope>;
}

export class AgentLog extends Context.Service<AgentLog, AgentLogService>()("AgentLog") {}

const memoryLog = (): AgentLogService => {
  const values = new Map<string, AgentEvent[]>();
  const feeds = new Map<string, PubSub.PubSub<AgentEvent>>();
  const feed = Effect.fnUntraced(function* (session: string) {
    const existing = feeds.get(session);
    if (existing) return existing;
    const created = yield* PubSub.unbounded<AgentEvent>();
    feeds.set(session, created);
    return created;
  });
  return {
    append: (frame) =>
      Effect.gen(function* () {
        const current = values.get(frame.session) ?? [];
        const event = { ...frame, sequence: current.length } as AgentEvent;
        current.push(event);
        values.set(frame.session, current);
        yield* feed(frame.session).pipe(Effect.flatMap((bus) => PubSub.publish(bus, event)));
        return event;
      }),
    read: (session, after = -1) =>
      Effect.sync(() => (values.get(session) ?? []).filter((event) => event.sequence > after)),
    bounds: (session) =>
      Effect.sync(() => {
        const current = values.get(session) ?? [];
        return { oldest: current[0]?.sequence ?? 0, latest: current.at(-1)?.sequence ?? -1 };
      }),
    watch: (session, after = -1) =>
      Effect.gen(function* () {
        const bus = yield* feed(session);
        const queue = yield* PubSub.subscribe(bus);
        const replay = (values.get(session) ?? []).filter((event) => event.sequence > after);
        const boundary = replay.at(-1)?.sequence ?? after;
        return Stream.concat(
          Stream.fromIterable(replay),
          Stream.fromSubscription(queue).pipe(Stream.filter((event) => event.sequence > boundary)),
        );
      }),
  };
};

export const AgentLogDefault = Layer.sync(AgentLog, memoryLog);

/** Durable history for one daemon session's native agent panes. */
export function makeAgentLog(
  root: string,
): Effect.Effect<AgentLogService, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path.pipe(Effect.provide(Path.layer));
    const entries = new Map<string, Entry[]>();
    const feeds = new Map<string, PubSub.PubSub<AgentEvent>>();
    const feed = Effect.fnUntraced(function* (session: string) {
      const existing = feeds.get(session);
      if (existing) return existing;
      const created = yield* PubSub.unbounded<AgentEvent>();
      feeds.set(session, created);
      return created;
    });

    const pathFor = (session: string) => path.join(root, "agent-events", `${session}.json`);

    const load = (session: string) =>
      Effect.gen(function* () {
        if (!isSessionId(session)) {
          const encoded = yield* S.encodeEffect(S.fromJsonString(S.String))(session);
          return yield* new AgentLogError({
            message: `invalid session id ${encoded}`,
          });
        }
        const existing = entries.get(session);
        if (existing) return existing;
        const text = yield* fs
          .readFileString(pathFor(session))
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed("[]") : Effect.fail(error),
            ),
          );
        const decoded = yield* S.decodeEffect(S.fromJsonString(Entries))(text).pipe(
          Effect.mapError((error) => new AgentLogError({ message: errorMessage(error) })),
        );
        const mutable = [...decoded];
        entries.set(session, mutable);
        return mutable;
      }).pipe(
        Effect.mapError((error) =>
          S.is(AgentLogError)(error) ? error : new AgentLogError({ message: errorMessage(error) }),
        ),
      );

    const write = (session: string, value: readonly Entry[]) =>
      Effect.gen(function* () {
        if (!isSessionId(session)) {
          const encoded = yield* S.encodeEffect(S.fromJsonString(S.String))(session);
          return yield* new AgentLogError({
            message: `invalid session id ${encoded}`,
          });
        }
        const directory = path.join(root, "agent-events");
        const file = pathFor(session);
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        const encoded = yield* S.encodeEffect(S.fromJsonString(Entries))(value);
        yield* fs.writeFileString(temp, encoded + "\n", { mode: 0o600 });
        yield* fs.rename(temp, file);
      }).pipe(
        Effect.mapError((error) =>
          S.is(AgentLogError)(error) ? error : new AgentLogError({ message: errorMessage(error) }),
        ),
      );

    const append = (frame: AgentEventPayload) =>
      Effect.gen(function* () {
        const current = yield* load(frame.session);
        const sequence = (current.at(-1)?.sequence ?? -1) + 1;
        const entry: Entry = { sequence, event: { ...frame, sequence } };
        current.push(entry);
        yield* write(frame.session, current);
        yield* feed(frame.session).pipe(Effect.flatMap((bus) => PubSub.publish(bus, entry.event)));
        return entry.event;
      }).pipe(
        Effect.mapError((error) =>
          S.is(AgentLogError)(error) ? error : new AgentLogError({ message: errorMessage(error) }),
        ),
      );

    const read = (session: string, after = -1) =>
      load(session).pipe(
        Effect.map((current) =>
          current.filter((entry) => entry.sequence > after).map((entry) => entry.event),
        ),
      );

    const bounds = (session: string) =>
      load(session).pipe(
        Effect.map((current) => ({
          oldest: current[0]?.sequence ?? 0,
          latest: current.at(-1)?.sequence ?? -1,
        })),
      );

    const watch = Effect.fnUntraced(function* (session: string, after = -1) {
      // This subscription intentionally precedes load/read. The queue holds
      // events appended while the durable replay is being decoded.
      const bus = yield* feed(session);
      const queue = yield* PubSub.subscribe(bus);
      const replay = yield* read(session, after);
      const boundary = replay.at(-1)?.sequence ?? after;
      return Stream.concat(
        Stream.fromIterable(replay),
        Stream.fromSubscription(queue).pipe(Stream.filter((event) => event.sequence > boundary)),
      );
    });

    return { append, read, bounds, watch } satisfies AgentLogService;
  });
}
