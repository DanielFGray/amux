import { test, expect } from "bun:test";
import { Tool } from "@effect/ai";
import { COMMAND_DEFS } from "../commands.ts";
import {
  buildNativeMapping,
  nativeToolName,
  nativeToolkit,
} from "./native-worker.ts";

const agentDefs = COMMAND_DEFS.filter((def) => def.exposure === "agent");

test("nativeToolName replaces dots with underscores", () => {
  expect(nativeToolName("pane.split")).toBe("pane_split");
  expect(nativeToolName("buffer.set")).toBe("buffer_set");
  expect(nativeToolName("window.select_layout")).toBe("window_select_layout");
  expect(nativeToolName("pane.send_keys")).toBe("pane_send_keys");
});

test("buildNativeMapping produces a bijection for all agent-exposed commands", () => {
  const { safeToCommand, commandToSafe } = buildNativeMapping(agentDefs);

  for (const def of agentDefs) {
    const safe = commandToSafe.get(def.tag);
    expect(safe).toBeDefined();
    expect(safe!.includes(".")).toBe(false);

    const original = safeToCommand.get(safe!);
    expect(original).toBe(def.tag);
  }
});

test("buildNativeMapping has no safe-name collisions across all agent commands", () => {
  const { commandToSafe } = buildNativeMapping(agentDefs);
  const bySafe = new Map<string, string[]>();
  for (const def of agentDefs) {
    const safe = commandToSafe.get(def.tag)!;
    const existing = bySafe.get(safe);
    if (!existing) {
      bySafe.set(safe, [def.tag]);
    } else {
      existing.push(def.tag);
    }
  }
  const collisions = [...bySafe.entries()].filter(
    ([, tags]) => tags.length > 1,
  );
  expect(collisions).toEqual([]);
});

test("every agent-exposed command has a safe name", () => {
  const { commandToSafe } = buildNativeMapping(agentDefs);
  expect(commandToSafe.size).toBe(agentDefs.length);
  for (const def of agentDefs) {
    expect(commandToSafe.has(def.tag)).toBe(true);
  }
});

test("safe names satisfy provider constraints (no dots, alphanumeric + underscore)", () => {
  const { commandToSafe } = buildNativeMapping(agentDefs);
  const safeNameRe = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
  for (const [, safe] of commandToSafe) {
    expect(safe).toMatch(safeNameRe);
  }
});

test("resolveCommand returns the original tag for a safe name and passes through unknown names", () => {
  const { safeToCommand } = buildNativeMapping(agentDefs);
  expect(safeToCommand.get("pane_split")).toBe("pane.split");
  expect(safeToCommand.get("buffer_set")).toBe("buffer.set");
  expect(safeToCommand.get("nonexistent_tool")).toBeUndefined();
});

test("nativeToolkit produces tools with safe names", () => {
  const toolkit = nativeToolkit();
  const toolNames = Object.values(toolkit.tools).map((t) => t.name);
  expect(toolNames.length).toBe(agentDefs.length);
  for (const name of toolNames) {
    expect(name.includes(".")).toBe(false);
  }
});

/**
 * Every tool must describe an object, argument-less ones included.
 *
 * `Schema.Struct({})` is TypeScript's `{}` — any non-null value — and its JSON
 * Schema says so, with an `anyOf` of object and array under the relative `$id`
 * `/schemas/%7B%7D`. OpenAI and Anthropic ignore that; an OpenAI-compatible
 * gateway resolved the `$id` as a URL and rejected the whole request, so every
 * turn failed at the first tool with no arguments. The 16 such commands are the
 * majority of the risk, which is why this walks all of them.
 */
test("no tool declares a schema that is not an object", () => {
  const toolkit = nativeToolkit();
  for (const tool of Object.values(toolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as Record<string, unknown>;
    expect({ name: tool.name, ...schema }).toMatchObject({
      name: tool.name,
      type: "object",
    });
    expect(schema.$id).toBeUndefined();
  }
});

test("nativeToolkit tools match agent-exposed commands 1:1", () => {
  const toolkit = nativeToolkit();
  const { safeToCommand } = buildNativeMapping(agentDefs);
  const originalTags = Object.values(toolkit.tools).map((t) =>
    safeToCommand.get(t.name),
  );
  const set = new Set(originalTags);
  expect(set.size).toBe(agentDefs.length);
  for (const def of agentDefs) {
    expect(set.has(def.tag)).toBe(true);
  }
});
