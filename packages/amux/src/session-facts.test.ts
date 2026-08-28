import { expect, test } from "bun:test";
import { Effect, Exit, Option, Scope, Stream } from "effect";
import { ProcessState } from "./process-state.ts";
import { makeSessionFacts, SESSION_FACTS_REFRESH_MS } from "./session-facts.ts";

const source = {
  id: "session-1",
  exited: false,
  detached: false,
  exitCode: null as number | null,
  reportedState: ProcessState.Idle as ProcessState | null,
  foregroundProcess: { pid: 42, argv: ["codex", "--quiet"] } as {
    readonly pid: number;
    readonly argv: readonly string[];
  } | null,
  outputRevision: 0,
  scans: 0,
  screenRegion: (_region: string) => {
    source.scans++;
    return `screen-${source.outputRevision}`;
  },
};

test("observations expose immutable values and revision-only invalidations", async () => {
  const service = makeSessionFacts(() => [source]);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observation = yield* service.observe(["whole_recent"]);
        const initial = observation.current()[source.id]!;
        expect(initial.foreground).toEqual({ pid: 42, argv: ["codex", "--quiet"] });
        expect(initial.regions.whole_recent).toBe("screen-0");

        source.outputRevision = 1;
        const invalidation = Option.getOrThrow(
          yield* Stream.runHead(observation.invalidations).pipe(Effect.timeout("2 seconds")),
        );
        expect(invalidation).toEqual({ session: source.id, revision: initial.revision + 1 });
        expect(observation.current()[source.id]!.regions.whole_recent).toBe("screen-1");
      }),
    ),
  );
});

test("closing the consumer scope stops terminal scans", async () => {
  source.outputRevision = 0;
  source.scans = 0;
  const service = makeSessionFacts(() => [source]);
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Scope.provide(service.observe(["whole_recent"]), scope));
  await Bun.sleep(SESSION_FACTS_REFRESH_MS + 30);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  const stoppedAt = source.scans;
  await Bun.sleep(SESSION_FACTS_REFRESH_MS + 30);
  expect(source.scans).toBe(stoppedAt);
});
