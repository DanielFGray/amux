import { expect, test } from "bun:test";
import { Duration, Effect, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { createChordMatcher, type ChordStroke } from "./chord-matcher.ts";
import { testEffect } from "./test-effect.ts";

const { effect } = testEffect(Layer.empty);

test("a long chord fires from one registration", () => {
  const fired: string[] = [];
  const chords = createChordMatcher({ timeoutlen: Duration.millis(40) });
  chords.register({
    id: "long",
    strokes: ["space", "a", "s", "d", "f"],
    run: () => fired.push("long"),
  });
  chords.register({
    id: "a",
    strokes: ["a"],
    run: () => fired.push("a"),
  });

  expect(chords.push("space")._tag).toBe("pending");
  for (const ch of ["a", "s", "d"] as const) {
    expect(chords.push(ch)._tag).toBe("pending");
  }
  expect(chords.push("f")).toEqual({ _tag: "matched", id: "long" });
  expect(fired).toEqual(["long"]);
  expect(chords.pending()).toEqual([]);

  expect(chords.push("a")).toEqual({ _tag: "matched", id: "a" });
  expect(fired).toEqual(["long", "a"]);
});

effect("timeoutlen prefers the longer chord, else the exact shorter binding", () =>
  Effect.gen(function* () {
    const context = yield* Effect.context();
    const fired: string[] = [];
    const chords = createChordMatcher({
      timeoutlen: Duration.millis(40),
      runFork: Effect.runForkWith(context),
    });
    for (const [id, strokes] of [
      ["g", ["g"]],
      ["gg", ["g", "g"]],
      ["grr", ["g", "r", "r"]],
    ] as const) {
      chords.register({
        id,
        strokes,
        run: () => fired.push(id),
      });
    }

    expect(chords.push("g")._tag).toBe("pending");
    expect(chords.push("g")).toEqual({ _tag: "matched", id: "gg" });
    expect(fired).toEqual(["gg"]);

    fired.length = 0;
    expect(chords.push("g")._tag).toBe("pending");
    expect(chords.push("r")._tag).toBe("pending");
    expect(chords.push("r")).toEqual({ _tag: "matched", id: "grr" });
    expect(fired).toEqual(["grr"]);

    fired.length = 0;
    expect(chords.push("g")._tag).toBe("pending");
    yield* TestClock.adjust(Duration.millis(40));
    expect(fired).toEqual(["g"]);
    expect(chords.pending()).toEqual([]);
  }),
);

test("a higher-priority exact does not wait on lower-priority longer maps", () => {
  const fired: string[] = [];
  const chords = createChordMatcher({ timeoutlen: Duration.millis(40) });
  chords.register({
    id: "enter",
    strokes: ["<prefix>"],
    priority: 202,
    run: () => fired.push("enter"),
  });
  chords.register({
    id: "focus",
    strokes: ["<prefix>", "h"],
    priority: 0,
    run: () => fired.push("focus"),
  });

  expect(chords.push("<prefix>")).toEqual({ _tag: "matched", id: "enter" });
  expect(fired).toEqual(["enter"]);
  expect(chords.pending()).toEqual([]);
});

effect("ambiguous timeout without exact binding re-emits strokes", () =>
  Effect.gen(function* () {
    const context = yield* Effect.context();
    const abandoned: ChordStroke[][] = [];
    const fired: string[] = [];
    const chords = createChordMatcher({
      timeoutlen: Duration.millis(40),
      runFork: Effect.runForkWith(context),
      onAmbiguousTimeout: (strokes) => abandoned.push([...strokes]),
    });
    chords.register({
      id: "grr",
      strokes: ["g", "r", "r"],
      run: () => fired.push("grr"),
    });

    expect(chords.push("g")._tag).toBe("pending");
    yield* TestClock.adjust(Duration.millis(40));
    expect(abandoned).toEqual([["g"]]);
    expect(fired).toEqual([]);
    expect(chords.pending()).toEqual([]);
  }),
);

test("inactive bindings are skipped", () => {
  let live = false;
  const fired: string[] = [];
  const chords = createChordMatcher({ timeoutlen: Duration.millis(40) });
  chords.register({
    id: "leader-f",
    strokes: ["space", "f"],
    active: () => live,
    run: () => fired.push("leader-f"),
  });
  chords.register({
    id: "space",
    strokes: ["space"],
    run: () => fired.push("space"),
  });

  expect(chords.push("space")).toEqual({ _tag: "matched", id: "space" });
  live = true;
  expect(chords.push("space")._tag).toBe("pending");
  expect(chords.push("f")).toEqual({ _tag: "matched", id: "leader-f" });
  expect(fired).toEqual(["space", "leader-f"]);
});

test("miss after a partial map retries the new stroke alone", () => {
  const fired: string[] = [];
  const chords = createChordMatcher({ timeoutlen: Duration.millis(40) });
  chords.register({
    id: "gg",
    strokes: ["g", "g"],
    run: () => fired.push("gg"),
  });
  chords.register({
    id: "x",
    strokes: ["x"],
    run: () => fired.push("x"),
  });

  expect(chords.push("g")._tag).toBe("pending");
  expect(chords.push("x")).toEqual({ _tag: "matched", id: "x" });
  expect(fired).toEqual(["x"]);
  expect(chords.pending()).toEqual([]);
});

test("subscribe notifies pending changes", () => {
  const seen: ChordStroke[][] = [];
  const chords = createChordMatcher({ timeoutlen: Duration.millis(40) });
  chords.register({
    id: "ab",
    strokes: ["a", "b"],
    run: () => {},
  });
  const stop = chords.subscribe((pending) => seen.push([...pending]));
  chords.push("a");
  expect(chords.pending()).toEqual(["a"]);
  chords.clear();
  chords.push("a");
  chords.push("b");
  stop();
  expect(seen).toEqual([["a"], [], ["a"], []]);
});

test("unregister removes a chord", () => {
  const chords = createChordMatcher({ timeoutlen: Duration.millis(40) });
  const dispose = chords.register({
    id: "ab",
    strokes: ["a", "b"],
    run: () => {},
  });
  expect(chords.push("a")._tag).toBe("pending");
  chords.clear();
  dispose();
  expect(chords.push("a")).toEqual({ _tag: "miss" });
});

test("minimode stays armed after a match until escape", () => {
  const chords = createChordMatcher({ timeoutlen: Duration.millis(5000) });
  const fired: string[] = [];
  chords.registerMode({ id: "window", strokes: ["prefix", "w"] });
  chords.register({
    id: "left",
    strokes: ["prefix", "w", "h"],
    run: () => void fired.push("h"),
  });
  chords.register({
    id: "right",
    strokes: ["prefix", "w", "l"],
    run: () => void fired.push("l"),
  });

  expect(chords.push("prefix")._tag).toBe("pending");
  expect(chords.push("w")._tag).toBe("pending");
  expect(chords.activeMode()?.id).toBe("window");

  expect(chords.push("h")).toEqual({ _tag: "matched", id: "left" });
  expect(chords.pending()).toEqual(["prefix", "w"]);
  expect(chords.push("l")).toEqual({ _tag: "matched", id: "right" });
  expect(fired).toEqual(["h", "l"]);

  expect(chords.push("x")._tag).toBe("pending");
  expect(chords.pending()).toEqual(["prefix", "w"]);

  expect(chords.push("escape")._tag).toBe("miss");
  expect(chords.pending()).toEqual([]);
  expect(chords.activeMode()).toBeNull();
});
