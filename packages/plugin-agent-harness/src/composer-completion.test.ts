import { describe, expect, test } from "bun:test";
import { activeCompletion, replaceCompletion } from "./composer-completion.ts";

describe("composer completions", () => {
  test("finds the final @file token", () => {
    expect(activeCompletion("fix @src/chat")).toEqual({
      trigger: "@",
      query: "src/chat",
      start: 4,
    });
  });

  test("replaces only the completed token", () => {
    const active = activeCompletion("fix @src/cha");
    if (!active) throw new Error("expected an active completion");
    expect(replaceCompletion("fix @src/cha", active, "@src/Chat.tsx ")).toBe("fix @src/Chat.tsx ");
  });
});
