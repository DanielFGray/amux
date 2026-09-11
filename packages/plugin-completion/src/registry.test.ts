/** @effect-diagnostics *:skip-file -- async test bodies await the Promise-facing completion API. */
import { describe, expect, test } from "bun:test";
import { Effect, Scope } from "effect";
import { CurrentPlugin } from "@danielfgray/amux";
import { completeFrom, makeCompletionSources, type CompletionSourcesService } from "./registry.ts";
import type { CompletionSource } from "./types.ts";

const owner = { id: "test", generation: 0 };

const run = <A>(program: Effect.Effect<A, never, CurrentPlugin | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(program).pipe(Effect.provideService(CurrentPlugin, owner)));

const source = (trigger: "/" | "@", id: string): CompletionSource => ({
  id: `${trigger}${id}`,
  trigger,
  complete: (_query) => [{ id, label: `${trigger}${id}`, replacement: `${trigger}${id}` }],
});

describe("completion registry", () => {
  test("sources resolve by trigger", async () => {
    const found = await run(
      Effect.gen(function* () {
        const service = makeCompletionSources();
        yield* service.register(source("/", "model"));
        yield* service.register(source("@", "file"));
        return {
          slash: service.forTrigger("/").map((entry) => entry.source),
          at: service.forTrigger("@").map((entry) => entry.source),
        };
      }),
    );
    expect(found.slash).toHaveLength(1);
    expect(found.at).toHaveLength(1);
  });

  test("a retiring scope withdraws its sources", async () => {
    const service = makeCompletionSources();
    const counts = await run(
      Effect.gen(function* () {
        yield* service.register(source("@", "file"));
        const before = service.forTrigger("@").length;
        yield* Effect.gen(function* () {
          yield* service.register(source("@", "temp"));
        }).pipe(Effect.scoped);
        return { before, after: service.forTrigger("@").length };
      }),
    );
    expect(counts).toEqual({ before: 1, after: 1 });
  });

  test("completeFrom merges sources and isolates failures", async () => {
    const service: Pick<CompletionSourcesService, "forTrigger"> = {
      forTrigger: (trigger) =>
        trigger === "/"
          ? [
              { owner, source: source("/", "a") },
              {
                owner,
                source: {
                  id: "/broken",
                  trigger: "/",
                  complete: () => Promise.reject(new Error("broken")),
                },
              },
              { owner: { id: "other", generation: 0 }, source: source("/", "b") },
            ]
          : [],
    };
    const items = await completeFrom(service, "/", "q");
    expect(items.map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect(await completeFrom(service, "@", "q")).toEqual([]);
  });

  test("completeFrom collapses the reload overlap to the latest source", async () => {
    const first: CompletionSource = {
      id: "@files",
      trigger: "@",
      complete: () => [{ id: "old", label: "@old", replacement: "@old" }],
    };
    const second: CompletionSource = {
      id: "@files",
      trigger: "@",
      complete: () => [{ id: "new", label: "@new", replacement: "@new" }],
    };
    const service: Pick<CompletionSourcesService, "forTrigger"> = {
      forTrigger: () => [
        { owner, source: first },
        { owner, source: second },
      ],
    };
    expect((await completeFrom(service, "@", "")).map((item) => item.id)).toEqual(["new"]);
  });
});
