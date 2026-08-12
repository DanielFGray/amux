import { expect, test } from "bun:test";
import { Tool } from "@effect/ai";
import { Effect } from "effect";
import { agentToolkit } from "./tools.ts";

test("agent toolkit exposes coding tools rather than amux commands", async () => {
  const toolkit = await Effect.runPromise(agentToolkit(process.cwd()));
  expect(Object.keys(toolkit.tools)).toEqual(["read", "write", "glob", "grep", "bash"]);
  for (const tool of Object.values(toolkit.tools)) {
    expect(Tool.getJsonSchema(tool as never)).toMatchObject({ type: "object" });
  }
});

test("read uses workspace-relative paths and line numbers", async () => {
  const toolkit = await Effect.runPromise(agentToolkit(process.cwd()));
  const output = await Effect.runPromise(
    toolkit.handle("read", {
      path: "package.json",
      offset: 1,
      limit: 1,
    }),
  );
  expect(output.result).toBe("1: {");
});
