import { expect, test } from "bun:test";
import {
  activateSpaceState,
  claimWindowNumber,
  closeWindowState,
  removeSpaceState,
  selectWindowState,
  spaceSetState,
  spaceState,
} from "./space-model.ts";

test("window selection and last-window are pure ID transitions", () => {
  let state = spaceState();
  state = selectWindowState(state, [1, 2, 3], 1);
  state = selectWindowState(state, [1, 2, 3], 3);
  expect(state).toEqual({ activeWindow: 3, lastWindow: 1, nextWindow: 1 });

  state = selectWindowState(state, [1, 2, 3], state.lastWindow!);
  expect(state).toEqual({ activeWindow: 1, lastWindow: 3, nextWindow: 1 });
  expect(selectWindowState(state, [1, 2, 3], 99)).toBe(state);
});

test("closing the active window prefers last, then its neighbour", () => {
  const withLast = { activeWindow: 3, lastWindow: 1, nextWindow: 4 };
  expect(closeWindowState(withLast, [1, 2], 3, 2)).toEqual({
    activeWindow: 1,
    lastWindow: null,
    nextWindow: 4,
  });

  const withoutLast = { activeWindow: 2, lastWindow: null, nextWindow: 4 };
  expect(closeWindowState(withoutLast, [1, 3], 2, 1).activeWindow).toBe(3);
  expect(closeWindowState(withoutLast, [], 2, 0).activeWindow).toBeNull();
});

test("restored window numbers advance the automatic counter", () => {
  let state = spaceState();
  let number: number;
  [state, number] = claimWindowNumber(state, 7);
  expect(number).toBe(7);
  [state, number] = claimWindowNumber(state);
  expect(number).toBe(8);
  expect(state.nextWindow).toBe(9);
});

test("active-space transitions use IDs and choose a neighbour on removal", () => {
  let state = activateSpaceState(spaceSetState(), ["a", "b", "c"], "b");
  expect(state.activeSpace).toBe("b");
  state = removeSpaceState(state, ["a", "c"], "b", 1);
  expect(state.activeSpace).toBe("c");
  expect(activateSpaceState(state, ["a", "c"], "missing")).toBe(state);
});
