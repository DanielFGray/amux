import { describe, expect, test } from "bun:test";
import {
  hoverLines,
  placeHoverPopup,
  splitHoverSegments,
  fitHoverText,
  fitHoverSegments,
  hoverContentWidth,
  hoverContentRows,
} from "./hover-layout.ts";

describe("placeHoverPopup", () => {
  test("prefers below the cursor when there is room", () => {
    const place = placeHoverPopup({
      cursorRow: 5,
      cursorCol: 10,
      viewportTop: 0,
      paneWidth: 80,
      paneHeight: 30,
      gutter: 4,
      contentLines: 4,
    });
    expect(place.top).toBe(6);
    // rawLeft=14 but width=72 in an 80-col pane → clamp to 8
    expect(place.left).toBe(8);
    expect(place.width).toBe(72);
  });

  test("flips above when the bottom edge is tight", () => {
    const place = placeHoverPopup({
      cursorRow: 28,
      cursorCol: 2,
      viewportTop: 0,
      paneWidth: 80,
      paneHeight: 30,
      gutter: 4,
      contentLines: 10,
    });
    expect(place.top).toBeLessThan(28);
    expect(place.top + place.maxHeight).toBeLessThanOrEqual(28);
  });

  test("clamps left so the popup stays inside the pane", () => {
    const place = placeHoverPopup({
      cursorRow: 1,
      cursorCol: 70,
      viewportTop: 0,
      paneWidth: 80,
      paneHeight: 24,
      gutter: 4,
      contentLines: 2,
      preferredWidth: 56,
    });
    expect(place.left + place.width).toBeLessThanOrEqual(80);
    expect(place.left).toBe(80 - 56);
  });

  test("accounts for viewport scroll when placing", () => {
    const place = placeHoverPopup({
      cursorRow: 40,
      cursorCol: 0,
      viewportTop: 30,
      paneWidth: 80,
      paneHeight: 24,
      gutter: 0,
      contentLines: 3,
    });
    expect(place.top).toBe(11);
    expect(place.left).toBe(0);
  });
});

describe("fitHoverText", () => {
  test("wraps long lines to width and caps rows", () => {
    const long =
      'type KeymapMode = "normal" | "insert" | "replace" | "command" | "visual" | "search"';
    const fitted = fitHoverText(long, 40, 2);
    expect(fitted.rows).toBe(2);
    expect(fitted.truncated).toBe(true);
    for (const line of fitted.text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    const wrapped = fitHoverText(long, 40, 20);
    expect(wrapped.truncated).toBe(false);
    expect(wrapped.rows).toBeGreaterThan(1);
  });

  test("keeps short content intact", () => {
    const fitted = fitHoverText("hello\nworld", 40, 10);
    expect(fitted).toEqual({ text: "hello\nworld", rows: 2, truncated: false });
  });
});

describe("fitHoverSegments", () => {
  test("wraps code body without counting fence markers as rows", () => {
    const fitted = fitHoverSegments(
      "```typescript\ntype A = { readonly x: number; readonly y: string }\n```",
      24,
      10,
    );
    expect(fitted.segments).toHaveLength(1);
    expect(fitted.segments[0]).toMatchObject({ kind: "code", language: "typescript" });
    expect(fitted.rows).toBeGreaterThan(1);
    const code = (fitted.segments[0] as { code: string }).code;
    for (const line of code.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(24);
    }
  });

  test("content width leaves room for border and padding", () => {
    expect(hoverContentWidth(80)).toBe(76);
    expect(hoverContentRows(10)).toBe(8);
  });
});

describe("hoverLines", () => {
  test("trims surrounding blank lines", () => {
    expect(hoverLines("\n```ts\nfoo\n```\n\n")).toEqual(["```ts", "foo", "```"]);
  });

  test("empty text becomes a placeholder", () => {
    expect(hoverLines("   \n  ")).toEqual(["(empty)"]);
  });
});

describe("splitHoverSegments", () => {
  test("splits fenced typescript from prose", () => {
    expect(
      splitHoverSegments("See docs\n```typescript\nfunction f(): void\n```\nmore"),
    ).toEqual([
      { kind: "text", text: "See docs" },
      { kind: "code", language: "typescript", code: "function f(): void" },
      { kind: "text", text: "more" },
    ]);
  });
});
