import { expect, test } from "bun:test";
import { Option } from "effect";
import { OpaqueJsonText, decodeOpaqueJsonText } from "./protocol.ts";
const jp = (value: typeof OpaqueJsonText.Encoded) => Option.getOrThrow(decodeOpaqueJsonText(value));
import { Effect, Scope } from "effect";
import { makeHarnessHooks } from "./hooks.ts";
import { appendEntry, checkout, emptySessionTree, forkAt, pathToLeaf } from "./session-tree.ts";

const withScope = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.scoped(effect);

// @effect-diagnostics-next-line asyncFunction:off -- bun:test callback; body uses Effect.runPromise.
test("tool_call handlers: first block wins", async () => {
  const result = await Effect.runPromise(
    withScope(
      Effect.gen(function* () {
        const hooks = makeHarnessHooks();
        const seen: string[] = [];
        yield* hooks.on("tool_call", (event) =>
          Effect.sync(() => {
            seen.push(`a:${event.tool}`);
            return { block: true as const, reason: "nope" };
          }),
        );
        yield* hooks.on("tool_call", (event) =>
          Effect.sync(() => {
            seen.push(`b:${event.tool}`);
          }),
        );
        const outcome = yield* hooks.emitToolCall({
          _tag: "tool_call",
          session: "s",
          turn: "t",
          tool: "bash",
          action: "bash",
          resources: [],
          input: jp({ command: "rm -rf /" }),
        });
        return { outcome, seen };
      }),
    ),
  );
  expect(result.outcome).toEqual({ block: true, reason: "nope" });
  expect(result.seen).toEqual(["a:bash"]);
});

// @effect-diagnostics-next-line asyncFunction:off -- bun:test callback; body uses Effect.runPromise.
test("before_agent_start emits to subscribers", async () => {
  const model = await Effect.runPromise(
    withScope(
      Effect.gen(function* () {
        const hooks = makeHarnessHooks();
        let heard = "";
        yield* hooks.on("before_agent_start", (event) =>
          Effect.sync(() => {
            heard = event.model;
          }),
        );
        yield* hooks.emit({ _tag: "before_agent_start", session: "s", model: "openai/gpt-4o" });
        return heard;
      }),
    ),
  );
  expect(model).toBe("openai/gpt-4o");
});

// @effect-diagnostics-next-line asyncFunction:off -- bun:test callback; body uses Effect.runPromise.
test("closing the scope unsubscribes the handler", async () => {
  const hooks = makeHarnessHooks();
  let calls = 0;
  await Effect.runPromise(
    withScope(
      Effect.gen(function* () {
        yield* hooks.on("before_agent_start", () =>
          Effect.sync(() => {
            calls += 1;
          }),
        );
        yield* hooks.emit({ _tag: "before_agent_start", session: "s", model: "m" });
      }),
    ),
  );
  expect(calls).toBe(1);
  await Effect.runPromise(hooks.emit({ _tag: "before_agent_start", session: "s", model: "m" }));
  expect(calls).toBe(1);
});

test("session tree path, checkout, and fork", () => {
  let tree = emptySessionTree();
  tree = appendEntry(tree, { id: "a", kind: "user", createdAt: 1 });
  tree = appendEntry(tree, { id: "b", parentId: "a", kind: "assistant", createdAt: 2 });
  tree = appendEntry(tree, { id: "c", parentId: "b", kind: "user", createdAt: 3 });
  expect(pathToLeaf(tree).map((e) => e.id)).toEqual(["a", "b", "c"]);

  const back = checkout(tree, "a");
  expect(back?.leaf).toBe("a");
  expect(pathToLeaf(back!).map((e) => e.id)).toEqual(["a"]);

  const forked = forkAt(tree, "b", {
    id: "d",
    parentId: "b",
    kind: "user",
    createdAt: 4,
  });
  expect(forked?.leaf).toBe("d");
  expect(pathToLeaf(forked!).map((e) => e.id)).toEqual(["a", "b", "d"]);
});
