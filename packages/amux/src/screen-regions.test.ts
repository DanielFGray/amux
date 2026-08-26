import { expect, test } from "bun:test";
import { extractScreenRegion, type ScreenSnapshot } from "./screen-regions.ts";

const capturedScreen: ScreenSnapshot = {
  oscTitle: "⠋ update dependencies",
  oscProgress: "42%;running",
  lines: [
    "earlier output",
    "› old prompt",
    "old response",
    "────────────────────",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
    "────────────────────",
    "› ",
    "",
  ],
};

test("extracts named regions from a captured agent screen", () => {
  expect(extractScreenRegion(capturedScreen, "osc_title")).toBe("⠋ update dependencies");
  expect(extractScreenRegion(capturedScreen, "osc_progress")).toBe("42%;running");
  expect(extractScreenRegion(capturedScreen, "prompt_box_body")).toBe(
    "Do you want to proceed?\n❯ 1. Yes\n  2. No",
  );
  expect(extractScreenRegion(capturedScreen, "above_prompt_box")).toBe(
    "earlier output\n› old prompt\nold response",
  );
  expect(extractScreenRegion(capturedScreen, "last_non_empty_above_prompt_box")).toBe(
    "old response",
  );
  expect(extractScreenRegion(capturedScreen, "after_last_horizontal_rule")).toBe("›\n");
  expect(extractScreenRegion(capturedScreen, "after_last_prompt_marker")).toBe("");
  expect(extractScreenRegion(capturedScreen, "bottom_lines(3)")).toBe("────────────────────\n›\n");
  expect(extractScreenRegion(capturedScreen, "bottom_non_empty_lines(2)")).toBe(
    "────────────────────\n›\n",
  );
  expect(extractScreenRegion(capturedScreen, "whole_recent")).toContain("old response");
});
