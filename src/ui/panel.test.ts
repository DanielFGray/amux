import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { Effect } from "effect";
import { createPanelContext } from "./panel.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { resolveOptions } from "../options.ts";
import { command, CommandError } from "../commands.ts";

function emptySnapshot(revision = 0): WorkspaceSnapshot {
  return { revision, spaces: [], state: { activeSpace: null } };
}

test("snapshot accessor reads the current signal value", () => {
  const [snapshot, setSnapshot] = createSignal<WorkspaceSnapshot>(emptySnapshot(0));
  const [tick] = createSignal(0);
  const [options] = createSignal(resolveOptions({}));
  const ctx = createPanelContext(
    snapshot,
    tick,
    () => Effect.succeed(emptySnapshot()),
    options,
    () => {},
  );

  expect(ctx.snapshot().revision).toBe(0);
  setSnapshot(emptySnapshot(5));
  expect(ctx.snapshot().revision).toBe(5);
});

test("snapshot and options accessors do not expose mutable host values", () => {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    revision: 1,
    spaces: [],
    state: { activeSpace: null },
  });
  const [tick] = createSignal(0);
  const [options] = createSignal(resolveOptions({}));
  const ctx = createPanelContext(
    snapshot,
    tick,
    () => Effect.succeed(emptySnapshot()),
    options,
    () => {},
  );

  const exposedSnapshot = ctx.snapshot();
  exposedSnapshot.revision = 99;
  const exposedOptions = ctx.options();
  (exposedOptions as Record<string, unknown>)["sidebar.width"] = 99;
  expect(ctx.snapshot().revision).toBe(1);
  expect(ctx.options()["sidebar.width"]).toBe(30);
});

test("tick accessor reads the current signal value", () => {
  const [snapshot] = createSignal<WorkspaceSnapshot>(emptySnapshot());
  const [tick, setTick] = createSignal(0);
  const [options] = createSignal(resolveOptions({}));
  const ctx = createPanelContext(
    snapshot,
    tick,
    () => Effect.succeed(emptySnapshot()),
    options,
    () => {},
  );

  expect(ctx.tick()).toBe(0);
  setTick(42);
  expect(ctx.tick()).toBe(42);
});

test("run delegates to the provided command invoker and returns an Effect", async () => {
  const [snapshot] = createSignal<WorkspaceSnapshot>(emptySnapshot());
  const [tick] = createSignal(0);
  const [options] = createSignal(resolveOptions({}));
  let calledWith: string | undefined;
  const ctx = createPanelContext(
    snapshot,
    tick,
    (cmd, input) => {
      calledWith = cmd._tag;
      return Effect.succeed(emptySnapshot(1));
    },
    options,
    () => {},
  );

  const result = await Effect.runPromise(ctx.run(command("pane.split", { axis: "row" })));
  expect(calledWith).toBe("pane.split");
  expect(result.revision).toBe(1);
});

test("run propagates a CommandError", async () => {
  const [snapshot] = createSignal<WorkspaceSnapshot>(emptySnapshot());
  const [tick] = createSignal(0);
  const [options] = createSignal(resolveOptions({}));
  const ctx = createPanelContext(
    snapshot,
    tick,
    () => Effect.fail(new CommandError({ message: "no such window" })),
    options,
    () => {},
  );

  const exit = await Effect.runPromise(Effect.exit(ctx.run(command("window.close"))));
  expect(exit._tag).toBe("Failure");
});

test("options accessor reads the current resolved values", () => {
  const [snapshot] = createSignal<WorkspaceSnapshot>(emptySnapshot());
  const [tick] = createSignal(0);
  const [options] = createSignal(resolveOptions({}));
  const ctx = createPanelContext(
    snapshot,
    tick,
    () => Effect.succeed(emptySnapshot()),
    options,
    () => {},
  );

  expect(ctx.options()["sidebar.open"]).toBe(true);
  expect(ctx.options()["sidebar.width"]).toBe(30);
});

test("setOption delegates to the provided setter", () => {
  const [snapshot] = createSignal<WorkspaceSnapshot>(emptySnapshot());
  const [tick] = createSignal(0);
  let stored = resolveOptions({});
  const [options, setOptions] = createSignal(stored);
  const calls: { name: string; value: unknown }[] = [];
  const ctx = createPanelContext(
    snapshot,
    tick,
    () => Effect.succeed(emptySnapshot()),
    options,
    (name, value) => {
      calls.push({ name, value });
      stored = { ...stored, [name]: value };
      setOptions(stored);
    },
  );

  ctx.setOption("sidebar.open", false);
  expect(calls).toEqual([{ name: "sidebar.open", value: false }]);
  expect(ctx.options()["sidebar.open"]).toBe(false);
});

test("run passes the optional input string to the invoker", async () => {
  const [snapshot] = createSignal<WorkspaceSnapshot>(emptySnapshot());
  const [tick] = createSignal(0);
  const [options] = createSignal(resolveOptions({}));
  let receivedInput: string | undefined;
  const ctx = createPanelContext(
    snapshot,
    tick,
    (_, input) => {
      receivedInput = input;
      return Effect.succeed(emptySnapshot(1));
    },
    options,
    () => {},
  );

  await Effect.runPromise(ctx.run(command("pane.send-keys", { keys: "ls" }), "\x1b[B"));
  expect(receivedInput).toBe("\x1b[B");
});

test("the context carries snapshot, tick, run, options, and setOption as its full interface", () => {
  const [snapshot] = createSignal<WorkspaceSnapshot>(emptySnapshot());
  const [tick] = createSignal(0);
  const [options] = createSignal(resolveOptions({}));
  const ctx = createPanelContext(
    snapshot,
    tick,
    () => Effect.succeed(emptySnapshot()),
    options,
    () => {},
  );

  const keys = Object.keys(ctx) as (keyof typeof ctx)[];
  keys.sort();
  expect(keys).toEqual(["options", "run", "setOption", "snapshot", "tick"]);
});
