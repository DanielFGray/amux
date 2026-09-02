/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { expect, test } from "bun:test";
import {
  ComponentRuntime,
  service,
  type ComponentContext,
  type Inverse,
} from "./component-runtime.ts";

const nextTurn = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("async effect iteration recovers yielded inverses in LIFO order", async () => {
  const runtime = new ComponentRuntime();
  const log: string[] = [];
  runtime.add({
    id: "effects",
    async *run() {
      log.push("apply first");
      yield () => void log.push("undo first");
      await nextTurn();
      log.push("apply second");
      yield () => void log.push("undo second");
    },
  });
  await runtime.settle();

  runtime.remove("effects");
  await runtime.settle();

  expect(log).toEqual(["apply first", "apply second", "undo second", "undo first"]);
});

test("declared dependencies gate activation and react when their provider arrives", async () => {
  const runtime = new ComponentRuntime();
  const database = service<{ readonly name: string }>("test/Database");
  const log: string[] = [];
  runtime.add({
    id: "consumer",
    requires: [database],
    async *run(context) {
      log.push(`using ${context.get(database).name}`);
      yield () => undefined;
    },
  });
  await runtime.settle();
  expect(runtime.status()).toEqual([
    { id: "consumer", state: "inactive", waitingFor: ["test/Database"] },
  ]);

  runtime.add({
    id: "provider",
    provides: [database],
    async *run(context) {
      context.provide(database, { name: "primary" });
      yield () => void log.push("provider closed");
    },
  });
  await runtime.settle();

  expect(log).toEqual(["using primary"]);
  expect(runtime.status().map(({ id, state }) => [id, state])).toEqual([
    ["consumer", "active"],
    ["provider", "active"],
  ]);

  runtime.remove("consumer");
  await runtime.settle();
  expect(runtime.status()).toEqual([{ id: "provider", state: "active", waitingFor: [] }]);
});

test("provider withdrawal tears down dependents first and reloads them on a new target", async () => {
  const runtime = new ComponentRuntime();
  const pool = service<{ readonly version: number; open: boolean }>("test/Pool");
  const log: string[] = [];
  const provider = (id: string, version: number) => ({
    id,
    provides: [pool],
    async *run(context: ComponentContext): AsyncGenerator<Inverse, void, void> {
      const value = { version, open: true };
      context.provide(pool, value);
      log.push(`${id} started`);
      yield () => {
        value.open = false;
        log.push(`${id} stopped`);
      };
    },
  });
  runtime.add(provider("one", 1));
  runtime.add({
    id: "consumer",
    requires: [pool],
    async *run(context) {
      const acquired = context.get(pool);
      log.push(`consumer on ${acquired.version}`);
      yield () => void log.push(`consumer stopped; pool open=${acquired.open}`);
    },
  });
  await runtime.settle();

  runtime.remove("one");
  await runtime.settle();
  runtime.add(provider("two", 2));
  await runtime.settle();

  expect(log).toEqual([
    "one started",
    "consumer on 1",
    "consumer stopped; pool open=true",
    "one stopped",
    "two started",
    "consumer on 2",
  ]);
});

test("an in-flight load lands before its stale target is unwound", async () => {
  const runtime = new ComponentRuntime();
  const dependency = service<void>("test/Dependency");
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.add({
    id: "provider",
    provides: [dependency],
    async *run(context) {
      context.provide(dependency, undefined);
      yield () => void log.push("provider undone");
    },
  });
  await runtime.settle();
  runtime.add({
    id: "consumer",
    requires: [dependency],
    async *run() {
      log.push("first landed");
      yield () => void log.push("first undone");
      await gate;
      log.push("second landed");
      yield () => void log.push("second undone");
    },
  });
  await nextTurn();

  runtime.remove("provider");
  release();
  await runtime.settle();

  expect(log).toEqual([
    "first landed",
    "second landed",
    "second undone",
    "first undone",
    "provider undone",
  ]);
});
