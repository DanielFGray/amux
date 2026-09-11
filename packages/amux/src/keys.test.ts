import { describe, expect, test } from "bun:test";
import { encodeKey } from "./keys.ts";
import type { KeyEvent } from "@opentui/core";

function event(partial: Partial<KeyEvent> & Pick<KeyEvent, "name" | "raw" | "sequence">): KeyEvent {
  return {
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    eventType: "press",
    source: "raw",
    preventDefault() {},
    stopPropagation() {},
    ...partial,
  } as KeyEvent;
}

describe("encodeKey", () => {
  test("legacy ctrl+c / ctrl+d keep their control bytes", () => {
    expect(encodeKey(event({ name: "c", ctrl: true, raw: "\x03", sequence: "\x03" }))).toBe("\x03");
    expect(encodeKey(event({ name: "d", ctrl: true, raw: "\x04", sequence: "\x04" }))).toBe("\x04");
  });

  test("kitty-sourced ctrl+c / ctrl+d re-encode to legacy control bytes", () => {
    // What OpenTUI emits when the outer terminal speaks CSI-u (herdr, kitty).
    const ctrlC = event({
      name: "c",
      ctrl: true,
      raw: "\x1b[99;5u",
      sequence: "c",
      source: "kitty",
      baseCode: 99,
    });
    const ctrlD = event({
      name: "d",
      ctrl: true,
      raw: "\x1b[100;5u",
      sequence: "d",
      source: "kitty",
      baseCode: 100,
    });
    expect(encodeKey(ctrlC)).toBe("\x03");
    expect(encodeKey(ctrlD)).toBe("\x04");
  });

  test("kitty releases are not forwarded", () => {
    expect(
      encodeKey(
        event({
          name: "c",
          ctrl: true,
          raw: "\x1b[99;5u",
          sequence: "c",
          source: "kitty",
          eventType: "release",
        }),
      ),
    ).toBeNull();
  });
});
