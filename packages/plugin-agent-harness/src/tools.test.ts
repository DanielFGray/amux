import { expect, test } from "bun:test";
import { Tool } from "@effect/ai";
import { Effect } from "effect";
import { agentToolkit } from "./tools.ts";
import type { Assertion, PermissionGate } from "./permission.ts";

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

test("agent toolkit exposes coding tools rather than amux commands", async () => {
  const toolkit = await Effect.runPromise(agentToolkit(process.cwd(), allowAll().gate));
  expect(Object.keys(toolkit.tools)).toEqual(["read", "write", "glob", "grep", "bash"]);
  for (const tool of Object.values(toolkit.tools)) {
    expect(Tool.getJsonSchema(tool as never)).toMatchObject({ type: "object" });
  }
});

test("read uses workspace-relative paths and line numbers", async () => {
  const toolkit = await Effect.runPromise(agentToolkit(process.cwd(), allowAll().gate));
  const output = await Effect.runPromise(
    toolkit.handle("read", {
      path: "package.json",
      offset: 1,
      limit: 1,
    }),
  );
  expect(output.result).toBe("1: {");
});

test("every tool declares its action and what it would touch", async () => {
  const { gate, seen } = allowAll();
  const toolkit = await Effect.runPromise(agentToolkit(process.cwd(), gate));
  await Effect.runPromise(toolkit.handle("read", { path: "package.json", offset: 1, limit: 1 }));
  await Effect.runPromise(toolkit.handle("bash", { command: "true && echo hi" }));
  expect(seen.map((assertion) => [assertion.action, assertion.resources])).toEqual([
    ["read", ["./package.json"]],
    ["bash", ["true", "echo hi"]],
  ]);
});

test("a refusal reaches the model as the tool's failure, and nothing runs", async () => {
  const { gate } = recording(() => Effect.fail("Denied by the user: not this time"));
  const toolkit = await Effect.runPromise(agentToolkit(process.cwd(), gate));
  const target = `${process.cwd()}/.amux-gate-test-file`;
  // failureMode "return" is what makes a refusal readable by the model: the
  // turn continues carrying the reason instead of dying.
  const result = await Effect.runPromise(toolkit.handle("write", { path: target, content: "x" }));
  expect(result).toMatchObject({
    isFailure: true,
    result: "Denied by the user: not this time",
  });
  expect(await Bun.file(target).exists()).toBe(false);
});
