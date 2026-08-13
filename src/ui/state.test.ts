import { expect, test } from "bun:test";
import { Effect, Exit, FiberMap, Scope, Stream } from "effect";
import type { SpaceSet } from "../space.ts";
import { runModelProjections, scheduledPoll, scheduleHintVisibility } from "../app.tsx";
import { createAppState, POLL_MS } from "./state.ts";
import { waitFor } from "../test-wait.ts";

function scopedRunner() {
  const scope = Effect.runSync(Scope.make());
  const run = Effect.runSync(
    Scope.extend(
      Effect.gen(function* () {
        const fibers = yield* FiberMap.make<string>();
        return yield* FiberMap.runtime(fibers)<never>();
      }),
      scope,
    ),
  );
  return { run, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

test("the UI poll keeps one fixed cadence and does not slow down when idle", async () => {
  // A real timer, not TestClock: `scheduledPoll` owns a platform timer on
  // purpose (see its doc comment), so a virtual clock would not see it — and a
  // virtual clock is exactly what hid the cadence regression this test guards.
  const fibers = scopedRunner();
  let polls = 0;
  fibers.run(
    "ui-poll",
    scheduledPoll(POLL_MS, () => {
      polls++;
    }),
  );

  await Bun.sleep(POLL_MS * 5 + POLL_MS / 2);
  await fibers.close();
  // Bounded on both sides: too few means an idle cadence crept back in, too
  // many means the poll is firing off-schedule.
  expect(polls).toBeGreaterThanOrEqual(4);
  expect(polls).toBeLessThanOrEqual(7);
});

test("closing the app fiber scope stops the UI poll", async () => {
  const fibers = scopedRunner();
  let polls = 0;
  fibers.run(
    "ui-poll",
    scheduledPoll(10, () => {
      polls++;
    }),
  );

  await waitFor(() => polls > 0, "the first poll");
  await fibers.close();
  const stopped = polls;
  await Bun.sleep(50);
  expect(polls).toBe(stopped);
});

test("output does not advance the polled tick, so a busy pane cannot storm the tree", () => {
  // Structural changes bump the revision; the tick belongs to the poll alone.
  // Advancing it here would repaint every view that displays polled state once
  // per output chunk rather than once per cadence.
  const spaces = {
    spaces: [],
    allAgents: [],
    active: null,
    activeWindow: null,
  } as unknown as SpaceSet;
  const app = createAppState(spaces);
  const before = app.tick();
  for (let i = 0; i < 100; i++) spaces.onChange?.();
  expect(app.tick()).toBe(before);
});

test("git refresh is keyed, so a slow scan is replaced rather than queued", async () => {
  const fibers = scopedRunner();
  let starts = 0;
  let interrupted = 0;
  const refresh = Effect.gen(function* () {
    starts++;
    yield* Effect.sleep("50 millis");
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        interrupted++;
      }),
    ),
  );

  const refreshNow = () => fibers.run("git-refresh", refresh);
  refreshNow();
  fibers.run("git-poll", scheduledPoll(10, refreshNow));
  await waitFor(() => starts >= 3, "three git scans");
  // Every scan but the newest was interrupted: a git call slower than the
  // cadence must not leave a growing pile of superseded scans behind it.
  expect(interrupted).toBeGreaterThanOrEqual(starts - 1);

  await fibers.close();
  const stopped = starts;
  await Bun.sleep(40);
  expect(starts).toBe(stopped);
});

test("a replacement hint delay cancels the previous callback", async () => {
  const fibers = scopedRunner();
  const shown: string[] = [];

  scheduleHintVisibility(
    fibers.run,
    40,
    () => true,
    () => shown.push("first"),
  );
  await Bun.sleep(5);
  scheduleHintVisibility(
    fibers.run,
    10,
    () => true,
    () => shown.push("second"),
  );
  await Bun.sleep(50);

  expect(shown).toEqual(["second"]);
  await fibers.close();
});

test("closing the app fiber scope prevents a pending hint callback", async () => {
  const fibers = scopedRunner();
  let callbacks = 0;
  scheduleHintVisibility(
    fibers.run,
    20,
    () => true,
    () => callbacks++,
  );

  await Bun.sleep(5);
  expect(callbacks).toBe(0);
  await fibers.close();
  await Bun.sleep(30);

  expect(callbacks).toBe(0);
});

test("model projection starts in stream order and stops with the scope", async () => {
  const fibers = scopedRunner();
  const projected: number[] = [];
  const models = Stream.concat(
    Stream.make(1),
    Stream.repeatEffect(Effect.sleep("15 millis").pipe(Effect.as(2))),
  );
  fibers.run(
    "workspace-models",
    runModelProjections(models, async (model) => {
      projected.push(model);
    }),
  );

  await waitFor(() => projected.length >= 1, "the first projection");
  expect(projected[0]).toBe(1);
  await fibers.close();
  const stopped = [...projected];
  await Bun.sleep(30);
  expect(projected).toEqual(stopped);
});
