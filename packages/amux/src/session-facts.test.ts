import { expect } from "bun:test";
import { Effect, Exit, Option, Scope, Stream } from "effect";
import { ProcessState } from "./process-state.ts";
import { makeSessionFacts, SESSION_FACTS_REFRESH_MS } from "./session-facts.ts";
import { testEffect } from "./test-effect.ts";

const source = {
  id: "session-1",
  exited: false,
  detached: false,
  exitCode: null as number | null,
  reportedState: ProcessState.Idle as ProcessState | null,
  cmd: ["bash"],
  declaredAgent: null,
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
  registerStateSource: () => () => {},
};

testEffect("observations expose immutable values and revision-only invalidations", () =>
  Effect.gen(function* () {
    const service = makeSessionFacts(() => [source]);
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
);

testEffect("closing the consumer scope stops terminal scans", () =>
  Effect.gen(function* () {
    source.outputRevision = 0;
    source.scans = 0;
    const service = makeSessionFacts(() => [source]);
    const scope = yield* Scope.make();
    yield* Scope.provide(service.observe(["whole_recent"]), scope);
    yield* Effect.promise(() => Bun.sleep(SESSION_FACTS_REFRESH_MS + 30));
    yield* Scope.close(scope, Exit.void);
    const stoppedAt = source.scans;
    yield* Effect.promise(() => Bun.sleep(SESSION_FACTS_REFRESH_MS + 30));
    expect(source.scans).toBe(stoppedAt);
  }),
);

testEffect("state-source registration follows a same-id session replacement", () =>
  Effect.gen(function* () {
    let current = source;
    let firstRemoved = 0;
    let secondAdded = 0;
    const first = {
      ...source,
      registerStateSource: () => () => {
        firstRemoved++;
      },
    };
    const second = {
      ...source,
      registerStateSource: () => {
        secondAdded++;
        return () => {};
      },
    };
    current = first;
    const service = makeSessionFacts(() => [current]);
    yield* service.observe([]);
    yield* service.registerStateSource(source.id, { authority: 0, state: () => "unknown" });
    current = second;
    yield* Effect.sleep(`${SESSION_FACTS_REFRESH_MS + 30} millis`);
    expect(firstRemoved).toBe(1);
    expect(secondAdded).toBe(1);
  }),
);
