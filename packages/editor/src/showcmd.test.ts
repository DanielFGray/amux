import { expect, test } from "bun:test";
import { initialEditor, reduceEditor } from "./vim-core.ts";
import { showcmdStrokes } from "./showcmd.ts";
import type { KeyEvent } from "@opentui/core";

const key = (name: string, extra: Partial<KeyEvent> = {}): KeyEvent =>
  ({
    name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    sequence: name,
    ...extra,
  }) as KeyEvent;

const press = (state: ReturnType<typeof initialEditor>, name: string) =>
  reduceEditor(state, { _tag: "key", key: key(name) });

test("showcmdStrokes reports operator-pending", () => {
  const armed = press(initialEditor(), "d");
  expect(showcmdStrokes(armed)).toEqual(["d"]);
});

test("showcmdStrokes reports count + operator + find", () => {
  let state = press(initialEditor(), "3");
  state = press(state, "d");
  expect(showcmdStrokes(state)).toEqual(["3", "d"]);
  state = press(state, "f");
  expect(showcmdStrokes(state)).toEqual(["3", "d", "f"]);
});

test("showcmdStrokes reports pending map prefix", () => {
  const pending = press(initialEditor(), "g");
  expect(showcmdStrokes(pending)).toEqual(["g"]);
  expect(pending.pendingMap).toEqual(["g"]);
});

test("showcmdStrokes clears when idle", () => {
  expect(showcmdStrokes(initialEditor())).toEqual([]);
});
