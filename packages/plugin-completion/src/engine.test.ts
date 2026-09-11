import { describe, expect, test } from "bun:test";
import { activeCompletion, replaceCompletion } from "./engine.ts";
import { filterEntries, moveSelected } from "./list.ts";
import type { PickerView } from "./types.ts";

describe("activeCompletion", () => {
  test("finds the final @file token at end of text", () => {
    expect(activeCompletion("fix @src/chat", 13)).toEqual({
      trigger: "@",
      query: "src/chat",
      start: 4,
      end: 13,
    });
  });

  test("finds a / command at the start of the text", () => {
    expect(activeCompletion("/model", 6)).toEqual({
      trigger: "/",
      query: "model",
      start: 0,
      end: 6,
    });
  });

  test("detects the token the cursor sits in, mid-line", () => {
    expect(activeCompletion("fix @src/chat and more", 13)).toEqual({
      trigger: "@",
      query: "src/chat",
      start: 4,
      end: 13,
    });
  });

  test("detects a partial token mid-word", () => {
    expect(activeCompletion("fix @src/chat", 8)).toEqual({
      trigger: "@",
      query: "src",
      start: 4,
      end: 8,
    });
  });

  test("a cursor parked after a space completes nothing", () => {
    expect(activeCompletion("fix @src/chat ", 14)).toBeUndefined();
    expect(activeCompletion("fix ", 4)).toBeUndefined();
  });

  test("a trigger inside a word does not fire", () => {
    expect(activeCompletion("mail a@b", 8)).toBeUndefined();
  });

  test("empty text and cursor zero complete nothing", () => {
    expect(activeCompletion("", 0)).toBeUndefined();
  });

  test("a cursor past the end clamps to the text", () => {
    expect(activeCompletion("fix @src", 99)).toEqual({
      trigger: "@",
      query: "src",
      start: 4,
      end: 8,
    });
  });
});

describe("replaceCompletion", () => {
  test("replaces only the completed token at end of text", () => {
    const active = activeCompletion("fix @src/cha", 12);
    if (!active) throw new Error("expected an active completion");
    expect(replaceCompletion("fix @src/cha", active, "@src/Chat.tsx ")).toBe("fix @src/Chat.tsx ");
  });

  test("a mid-line replacement keeps its tail", () => {
    const active = activeCompletion("fix @src/cha and more", 12);
    if (!active) throw new Error("expected an active completion");
    expect(replaceCompletion("fix @src/cha and more", active, "@src/Chat.tsx ")).toBe(
      "fix @src/Chat.tsx  and more",
    );
  });

  test("detect-replace-detect round-trips to idle", () => {
    const text = "fix @src/cha";
    const active = activeCompletion(text, text.length);
    if (!active) throw new Error("expected an active completion");
    const replaced = replaceCompletion(text, active, "@src/Chat.tsx ");
    expect(activeCompletion(replaced, replaced.length)).toBeUndefined();
  });
});

describe("picker list", () => {
  interface Entry {
    readonly value: string;
    readonly label: string;
  }
  const view = (entries: readonly Entry[]): PickerView<Entry> => ({
    allEntries: entries,
    entries,
    query: "",
    selected: 0,
  });
  const entries: readonly Entry[] = [
    { value: "anthropic/claude", label: "Claude" },
    { value: "openai/gpt", label: "GPT" },
  ];

  test("filter narrows and resets the selection", () => {
    const filtered = filterEntries(
      { ...view(entries), selected: 1 },
      "gpt",
      (entry) => `${entry.value} ${entry.label}`,
    );
    expect(filtered.entries).toEqual([{ value: "openai/gpt", label: "GPT" }]);
    expect(filtered.selected).toBe(0);
    expect(filtered.query).toBe("gpt");
  });

  test("an empty query matches everything", () => {
    expect(filterEntries(view(entries), "", (entry) => entry.value).entries).toEqual(entries);
  });

  test("selection moves clamp to the list", () => {
    const moved = moveSelected(view(entries), 5);
    expect(moved.selected).toBe(1);
    expect(moveSelected(moved, -5).selected).toBe(0);
    expect(moveSelected(view([]), 1).selected).toBe(0);
  });
});
