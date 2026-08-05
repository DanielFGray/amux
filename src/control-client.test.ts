import { describe, expect, it } from "vitest";
import { eventGap } from "./control-client.ts";

describe("eventGap", () => {
  it("reports missing sliding events", () => {
    expect(
      eventGap(
        { sequence: 3, event: { _tag: "pane.exited", session: "a", code: 0 } },
        { sequence: 8, event: { _tag: "pane.exited", session: "b", code: 1 } },
      ),
    ).toBe(4);
  });

  it("does not report a gap for adjacent or reordered frames", () => {
    const current = { sequence: 4, event: { _tag: "pane.exited", session: "b", code: 1 } } as const;
    expect(eventGap({ sequence: 3, event: current.event }, current)).toBe(0);
    expect(eventGap({ sequence: 5, event: current.event }, current)).toBe(0);
  });
});
