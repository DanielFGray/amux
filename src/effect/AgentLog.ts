import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Schema as S } from "effect";
import { join } from "node:path";
import { AgentEvent, type AgentEventPayload, type DurableAgentFrame } from "./AttachProtocol.ts";
import { isSessionId } from "../session.ts";

const Entry = S.Struct({ sequence: S.NonNegativeInt, event: AgentEvent });
const Entries = S.Array(Entry);
type Entry = S.Schema.Type<typeof Entry>;

export class AgentLogError extends S.TaggedError<AgentLogError>()("AgentLogError", {
  message: S.String,
}) {}

export interface AgentLogService {
  readonly append: (frame: AgentEventPayload) => Effect.Effect<DurableAgentFrame, AgentLogError>;
  readonly read: (session: string, after?: number) => Effect.Effect<readonly DurableAgentFrame[], AgentLogError>;
  readonly bounds: (session: string) => Effect.Effect<{ readonly oldest: number; readonly latest: number }, AgentLogError>;
}

export class AgentLog extends Context.Tag("AgentLog")<AgentLog, AgentLogService>() {}

const memoryLog = (): AgentLogService => {
  const values = new Map<string, DurableAgentFrame[]>();
  return {
    append: (frame) =>
      Effect.sync(() => {
        const current = values.get(frame.session) ?? [];
        const event = { ...frame, sequence: current.length } as DurableAgentFrame;
        current.push(event);
        values.set(frame.session, current);
        return event;
      }),
    read: (session, after = -1) => Effect.sync(() => (values.get(session) ?? []).filter((event) => event.sequence > after)),
    bounds: (session) => Effect.sync(() => {
      const current = values.get(session) ?? [];
      return { oldest: current[0]?.sequence ?? 0, latest: current.at(-1)?.sequence ?? 0 };
    }),
  };
};

export const AgentLogDefault = Layer.succeed(AgentLog, memoryLog());

/** Durable history for one daemon session's native agent panes. */
export function makeAgentLog(root: string): Effect.Effect<AgentLogService, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = new Map<string, Entry[]>();

    const pathFor = (session: string) => join(root, "agent-events", `${session}.json`);

    const load = (session: string) =>
      Effect.gen(function* () {
        if (!isSessionId(session)) return yield* new AgentLogError({ message: `invalid session id ${JSON.stringify(session)}` });
        const existing = entries.get(session);
        if (existing) return existing;
        const text = yield* fs.readFileString(pathFor(session)).pipe(
          Effect.catchTag("SystemError", (error) =>
            error.reason === "NotFound" ? Effect.succeed("[]") : Effect.fail(error),
          ),
        );
        const value = yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (error) => new AgentLogError({ message: error instanceof Error ? error.message : String(error) }),
        });
        const decoded = yield* S.decodeUnknown(Entries)(value).pipe(
          Effect.mapError((error) => new AgentLogError({ message: String(error) })),
        );
        const mutable = [...decoded];
        entries.set(session, mutable);
        return mutable;
      }).pipe(Effect.mapError((error) => error instanceof AgentLogError ? error : new AgentLogError({ message: error instanceof Error ? error.message : String(error) })));

    const write = (session: string, value: readonly Entry[]) =>
      Effect.gen(function* () {
        if (!isSessionId(session)) return yield* new AgentLogError({ message: `invalid session id ${JSON.stringify(session)}` });
        const directory = join(root, "agent-events");
        const file = pathFor(session);
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        yield* fs.writeFileString(temp, JSON.stringify(value) + "\n", { mode: 0o600 });
        yield* fs.rename(temp, file);
      }).pipe(
        Effect.mapError((error) =>
          error instanceof AgentLogError
            ? error
            : new AgentLogError({ message: error instanceof Error ? error.message : String(error) }),
        ),
      );

    const append = (frame: AgentEventPayload) =>
      Effect.gen(function* () {
        const current = yield* load(frame.session);
        const sequence = current.at(-1)?.sequence === undefined ? 0 : current.at(-1)!.sequence + 1;
        const entry = { sequence, event: { ...frame, sequence } } as Entry;
        current.push(entry);
        yield* write(frame.session, current);
        return entry.event as DurableAgentFrame;
      }).pipe(Effect.mapError((error) => (error instanceof AgentLogError ? error : new AgentLogError({ message: String(error) }))));

    const read = (session: string, after = -1) =>
      load(session).pipe(Effect.map((current) => current.filter((entry) => entry.sequence > after).map((entry) => entry.event as DurableAgentFrame)));

    const bounds = (session: string) =>
      load(session).pipe(
        Effect.map((current) => ({ oldest: current[0]?.sequence ?? 0, latest: current.at(-1)?.sequence ?? 0 })),
      );

    return { append, read, bounds } satisfies AgentLogService;
  });
}
