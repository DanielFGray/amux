import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { pickerKeyHandler } from "./keys.ts";
import type { PickerView } from "./types.ts";

const key = (name: string): KeyEvent => ({ name }) as KeyEvent;

const view = (selected: number): PickerView<string> => ({
  allEntries: ["a", "b", "c"],
  entries: ["a", "b", "c"],
  query: "",
  selected,
});

describe("picker keys", () => {
  test("up/down move, enter chooses, escape dismisses", () => {
    let current = view(0);
    let chosen = 0;
    let closed = 0;
    const handle = pickerKeyHandler(
      () => current,
      (update) => {
        current = update(current);
      },
      {
        onChoose: () => {
          chosen++;
        },
        onClose: () => {
          closed++;
        },
      },
    );
    expect(handle(key("down"))).toBe(true);
    expect(current.selected).toBe(1);
    expect(handle(key("up"))).toBe(true);
    expect(current.selected).toBe(0);
    expect(handle(key("j"))).toBe(true);
    expect(handle(key("k"))).toBe(true);
    expect(handle(key("enter"))).toBe(true);
    expect(chosen).toBe(1);
    expect(handle(key("escape"))).toBe(true);
    expect(closed).toBe(1);
  });

  test("unclaimed keys fall through and a closed picker ignores everything", () => {
    let current = view(0);
    const open = pickerKeyHandler(
      () => current,
      (update) => {
        current = update(current);
      },
      { onChoose: () => {}, onClose: () => {} },
    );
    expect(open(key("x"))).toBe(false);
    const closed = pickerKeyHandler(
      () => null,
      () => {},
      {
        onChoose: () => {},
        onClose: () => {},
      },
    );
    expect(closed(key("down"))).toBe(false);
  });
});
