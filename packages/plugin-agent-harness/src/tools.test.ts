import { expect, test } from "bun:test";
import { AiError, Tool } from "effect/unstable/ai";
import { Effect, Option, Stream } from "effect";
import { agentToolkit } from "./tools.ts";
import { testEffect } from "@danielfgray/amux/testing"
import type { Assertion, PermissionGate } from "./permission.ts";

/** Runs a tool call to its final result. Handlers stream preliminary progress
 *  updates before the authoritative one, which these tests don't need. */
const runHandle = <A, E>(effect: Effect.Effect<Stream.Stream<A, E>, AiError.AiError>) =>
  effect.pipe(Effect.flatMap(Stream.runLast), Effect.map(Option.getOrThrow));

/** A gate that records what it was asked and answers the same way every time. */
const recording = (answer: (assertion: Assertion) => Effect.Effect<void, string>) => {
  const seen: Assertion[] = [];
  const gate: PermissionGate = {
    assert: (assertion) => {
      seen.push(assertion);
      return answer(assertion);
    },
    resolve: () => Effect.void,
  };
  return { gate, seen };
};

const allowAll = () => recording(() => Effect.void);

testEffect("agent toolkit exposes coding tools rather than amux commands", () =>
  Effect.gen(function* () {
    const toolkit = yield* agentToolkit(process.cwd(), allowAll().gate);
    expect(Object.keys(toolkit.tools)).toEqual(["read", "write", "glob", "grep", "bash"]);
    for (const tool of Object.values(toolkit.tools)) {
      expect(Tool.getJsonSchema(tool as never)).toMatchObject({ type: "object" });
    }
  }),
);

testEffect("read uses workspace-relative paths and line numbers", () =>
  Effect.gen(function* () {
    const toolkit = yield* agentToolkit(process.cwd(), allowAll().gate);
    const output = yield* runHandle(
      toolkit.handle("read", {
        path: "package.json",
        offset: 1,
        limit: 1,
      }),
    );
    expect((output as { result: unknown }).result).toBe("1: {");
  }),
);

testEffect("every tool declares its action and what it would touch", () =>
  Effect.gen(function* () {
    const { gate, seen } = allowAll();
    const toolkit = yield* agentToolkit(process.cwd(), gate);
    yield* runHandle(toolkit.handle("read", { path: "package.json", offset: 1, limit: 1 }));
    yield* runHandle(toolkit.handle("bash", { command: "true && echo hi" }));
    expect(seen.map((assertion) => [assertion.action, assertion.resources])).toEqual([
      ["read", ["./package.json"]],
      ["bash", ["true", "echo hi"]],
    ]);
  }),
);

testEffect("a refusal reaches the model as the tool's failure, and nothing runs", () =>
  Effect.gen(function* () {
    const { gate } = recording(() => Effect.fail("Denied by the user: not this time"));
    const toolkit = yield* agentToolkit(process.cwd(), gate);
    const target = `${process.cwd()}/.amux-gate-test-file`;
    // failureMode "return" is what makes a refusal readable by the model: the
    // turn continues carrying the reason instead of dying.
    const result = yield* runHandle(toolkit.handle("write", { path: target, content: "x" }));
    expect(result).toMatchObject({
      isFailure: true,
      result: "Denied by the user: not this time",
    });
    expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false);
  }),
);
