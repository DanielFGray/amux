import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { Effect } from "effect";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { resolveOptions } from "../options.ts";
import { command, CommandError } from "../commands.ts";
import { testPanelContext } from "./test-panel.ts";

function snapshotAt(revision: number): WorkspaceSnapshot {
  return { revision, spaces: [], state: { activeSpace: null, nextSpace: 1 } };
}

test("snapshot accessor reads the current signal value", () => {
  const [snapshot, setSnapshot] = createSignal<WorkspaceSnapshot>(snapshotAt(0));
  const ctx = testPanelContext({ snapshot });

  expect(ctx.snapshot().revision).toBe(0);
  setSnapshot(snapshotAt(5));
  expect(ctx.snapshot().revision).toBe(5);
});

test("snapshot and options accessors do not expose mutable host values", () => {
  const ctx = testPanelContext({ snapshot: () => snapshotAt(1) });

  ctx.snapshot().revision = 99;
  Object.defineProperty(ctx.options(), "sidebar.width", { value: 99, writable: true });
  expect(ctx.snapshot().revision).toBe(1);
  expect(ctx.options()["sidebar.width"]).toBe(30);
});

test("tick accessor reads the current signal value", () => {
  const [tick, setTick] = createSignal(0);
  const ctx = testPanelContext({ tick });

  expect(ctx.tick()).toBe(0);
  setTick(42);
  expect(ctx.tick()).toBe(42);
});

test("run delegates to the provided command invoker and returns an Effect", async () => {
  let calledWith: string | undefined;
  const ctx = testPanelContext({
    run: (cmd) => {
      calledWith = cmd._tag;
      return Effect.succeed(snapshotAt(1));
    },
  });

  const result = await Effect.runPromise(ctx.run(command("pane.split", { axis: "row" })));
  expect(calledWith).toBe("pane.split");
  expect(result.revision).toBe(1);
});

test("run propagates a CommandError", async () => {
  const ctx = testPanelContext({
    run: () => Effect.fail(new CommandError({ message: "no such window" })),
  });

  const exit = await Effect.runPromise(Effect.exit(ctx.run(command("window.close"))));
  expect(exit._tag).toBe("Failure");
});

test("options accessor reads the current resolved values", () => {
  const ctx = testPanelContext();

  expect(ctx.options()["sidebar.open"]).toBe(true);
  expect(ctx.options()["sidebar.width"]).toBe(30);
});

test("setOption delegates to the provided setter", () => {
  const [options, setOptions] = createSignal(resolveOptions({}));
  const calls: { name: string; value: unknown }[] = [];
  const ctx = testPanelContext({
    options,
    setOption: (name, value) => {
      calls.push({ name, value });
      setOptions((current) => ({ ...current, [name]: value }));
    },
  });

  ctx.setOption("sidebar.open", false);
  expect(calls).toEqual([{ name: "sidebar.open", value: false }]);
  expect(ctx.options()["sidebar.open"]).toBe(false);
});

test("run passes the optional input string to the invoker", async () => {
  let receivedInput: string | undefined;
  const ctx = testPanelContext({
    run: (_, input) => {
      receivedInput = input;
      return Effect.succeed(snapshotAt(1));
    },
  });

  await Effect.runPromise(ctx.run(command("pane.send-keys", { keys: "ls" }), "\x1b[B"));
  expect(receivedInput).toBe("\x1b[B");
});

test("the context carries all expected fields", () => {
  const keys = Object.keys(testPanelContext()).sort();
  expect(keys).toEqual([
    "display",
    "options",
    "reportError",
    "run",
    "saveOptions",
    "selectedAgentId",
    "setOption",
    "setSelectedAgentId",
    "snapshot",
    "tick",
  ]);
});
