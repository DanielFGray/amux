import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { activeCompletion, replaceCompletion } from "./composer-completion.ts";

describe("composer completions", () => {
  test("finds the final @file token", () => {
    expect(activeCompletion("fix @src/chat")).toEqual(
      Option.some({
        trigger: "@",
        query: "src/chat",
        start: 4,
      }),
    );
  });

  test("replaces only the completed token", () => {
    const active = activeCompletion("fix @src/cha");
    Option.match(active, {
      onNone: () => expect(false).toBe(true),
      onSome: (value) =>
        expect(replaceCompletion("fix @src/cha", value, "@src/Chat.tsx ")).toBe(
          "fix @src/Chat.tsx ",
        ),
    });
  });
});
