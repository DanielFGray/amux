import { expect, test } from "bun:test";
import { createCountAccumulator } from "./key-invocation.ts";

const key = (name: string, mods: Partial<{ ctrl: boolean; meta: boolean; option: boolean }> = {}) =>
  ({ name, ctrl: false, meta: false, option: false, ...mods }) as never;

const boundHere = (bound: readonly string[]) => (name: string) => bound.includes(name);

test("digits accumulate into a count, defaulting to 1 when nothing was typed", () => {
  const acc = createCountAccumulator();
  expect(acc.count()).toBe(1);
  expect(acc.digits()).toBe("");

  expect(acc.offer(key("1"), boundHere([]))).toBe(true);
  expect(acc.offer(key("2"), boundHere([]))).toBe(true);
  expect(acc.digits()).toBe("12");
  expect(acc.count()).toBe(12);
});

test("a leading zero is a motion, not a count start, when the context has bound it", () => {
  const acc = createCountAccumulator();
  // "0" is bound here (e.g. "go to start of line"), and no count is under
  // way yet — the accumulator declines it, exactly like isCountDigit in
  // vim-core.ts.
  expect(acc.offer(key("0"), boundHere(["0"]))).toBe(false);
  expect(acc.digits()).toBe("");
});

test("a leading zero starts a count when the context has not bound it", () => {
  const acc = createCountAccumulator();
  expect(acc.offer(key("0"), boundHere([]))).toBe(true);
  expect(acc.digits()).toBe("0");
});

test("a leading digit that is bound here is the binding, not a count start", () => {
  const acc = createCountAccumulator();
  // Mux `^a 1` window-select: "1" is bound under the prefix, so it must not
  // start a count. Same rule as leading zero-as-motion.
  expect(acc.offer(key("1"), boundHere(["1"]))).toBe(false);
  expect(acc.digits()).toBe("");
});

test("once a count is under way, zero extends it even where the digit is bound", () => {
  const acc = createCountAccumulator();
  expect(acc.offer(key("1"), boundHere(["0"]))).toBe(true);
  expect(acc.offer(key("0"), boundHere(["0"]))).toBe(true);
  expect(acc.digits()).toBe("10");
  expect(acc.count()).toBe(10);
});

test("a modified key, a multi-char key name, or a non-digit is never claimed", () => {
  const acc = createCountAccumulator();
  expect(acc.offer(key("1", { ctrl: true }), boundHere([]))).toBe(false);
  expect(acc.offer(key("escape"), boundHere([]))).toBe(false);
  expect(acc.offer(key("a"), boundHere([]))).toBe(false);
  expect(acc.digits()).toBe("");
});

test("reset clears the count without touching the claim rule", () => {
  const acc = createCountAccumulator();
  acc.offer(key("4"), boundHere([]));
  expect(acc.count()).toBe(4);
  acc.reset();
  expect(acc.digits()).toBe("");
  expect(acc.count()).toBe(1);
});
