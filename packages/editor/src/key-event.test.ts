import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { keyFromEvent } from "./key-event.ts";

const event = (name: string, extra: Partial<KeyEvent> = {}): KeyEvent =>
  ({
    name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: name,
    ...extra,
  }) as KeyEvent;

test("keyFromEvent drops releases and keeps press/repeat", () => {
  expect(keyFromEvent(event("a", { eventType: "release" }))).toBeNull();
  expect(keyFromEvent(event("a"))).toEqual({
    name: "a",
    sequence: "a",
    shift: false,
    ctrl: false,
    meta: false,
    option: false,
  });
  expect(keyFromEvent(event("a", { eventType: "repeat" }))).not.toBeNull();
});
