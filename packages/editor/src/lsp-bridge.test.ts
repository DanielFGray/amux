import { expect } from "bun:test";
import { describe, test } from "bun:test";
import { Option } from "effect";
import {
  applyGoto,
  asLocations,
  completionLabels,
  diagnosticsSummary,
  fileUri,
  flattenDocumentSymbols,
  hoverText,
  jumpDiagnostic,
  locationLabel,
  pathFromUri,
  wordAtCursor,
} from "./lsp-bridge.ts";
import { initialEditor, bufferFromLines, setBuffer } from "@danielfgray/amux-vim";

describe("lsp-bridge helpers", () => {
  test("fileUri encodes absolute paths", () => {
    expect(fileUri("/workspace/main.ts")).toBe("file:///workspace/main.ts");
  });

  test("pathFromUri decodes file URIs and absolute paths", () => {
    expect(Option.getOrUndefined(pathFromUri("file:///workspace/main.ts"))).toBe(
      "/workspace/main.ts",
    );
    expect(Option.getOrUndefined(pathFromUri("/abs/path.ts"))).toBe("/abs/path.ts");
    expect(Option.isNone(pathFromUri("https://example.com/x"))).toBe(true);
  });

  test("hoverText flattens marked strings", () => {
    expect(hoverText("plain")).toBe("plain");
    expect(hoverText({ language: "ts", value: "code" })).toBe("code");
    expect(hoverText(["a", { language: "ts", value: "b" }])).toBe("a\nb");
  });

  test("hoverText flattens MarkupContent (tsserver hover)", () => {
    expect(hoverText({ kind: "markdown", value: "```ts\nconst x: number\n```" })).toBe(
      "```ts\nconst x: number\n```",
    );
    expect(hoverText({ kind: "plaintext", value: "number" })).toBe("number");
  });

  test("diagnosticsSummary counts severities", () => {
    expect(diagnosticsSummary([])).toBe("");
    expect(
      diagnosticsSummary([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: "e",
          severity: 1,
        },
      ]),
    ).toBe("[1 error]");
    expect(
      diagnosticsSummary([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: "e",
          severity: 1,
        },
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          message: "w",
          severity: 2,
        },
      ]),
    ).toBe("[1E 1W]");
  });

  test("completionLabels reads list and CompletionList shapes", () => {
    expect(completionLabels([{ label: "a" }, { label: "b" }])).toEqual(["a", "b"]);
    expect(completionLabels({ isIncomplete: false, items: [{ label: "c" }] })).toEqual(["c"]);
  });

  test("asLocations normalizes single and list definitions", () => {
    const loc = {
      uri: "file:///a.ts",
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
    };
    expect(asLocations(loc)).toEqual([loc]);
    expect(asLocations([loc, loc])).toEqual([loc, loc]);
  });

  test("locationLabel formats path:line:col relative to workspace", () => {
    const loc = {
      uri: "file:///workspace/src/a.ts",
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 5 } },
    };
    expect(locationLabel(loc, Option.some("/workspace"))).toBe("src/a.ts:3:5");
    expect(locationLabel(loc)).toBe("/workspace/src/a.ts:3:5");
  });

  test("wordAtCursor returns the identifier under the cursor", () => {
    const state = setBuffer(
      { ...initialEditor(), cursor: { row: 0, col: 6 } },
      bufferFromLines(["const renamed = 1"]),
    );
    expect(Option.getOrUndefined(wordAtCursor(state))).toBe("renamed");
  });

  test("applyGoto moves in-file and opens another file with a landing cursor", () => {
    const base = {
      ...initialEditor(),
      file: "/workspace/a.ts",
      cursor: { row: 0, col: 0 },
    };
    const same = applyGoto(base, "/workspace/a.ts", 3, 1);
    expect(same.cursor).toEqual({ row: 3, col: 1 });
    expect(same.request).toBeNull();
    expect(same.jumpList.entries.length).toBeGreaterThan(0);

    const other = applyGoto(base, "/workspace/b.ts", 1, 2);
    expect(other.request).toEqual({
      _tag: "open",
      path: "/workspace/b.ts",
      row: 1,
      col: 2,
    });
  });

  test("jumpDiagnostic walks next/prev/first/last with wrap", () => {
    const diags = [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        message: "a",
      },
      {
        range: { start: { line: 3, character: 2 }, end: { line: 3, character: 3 } },
        message: "b",
      },
      {
        range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } },
        message: "c",
      },
    ];
    expect(Option.getOrUndefined(jumpDiagnostic(diags, { row: 0, col: 0 }, "next"))).toEqual({
      row: 1,
      col: 0,
    });
    expect(Option.getOrUndefined(jumpDiagnostic(diags, { row: 1, col: 0 }, "next"))).toEqual({
      row: 3,
      col: 2,
    });
    expect(Option.getOrUndefined(jumpDiagnostic(diags, { row: 5, col: 0 }, "next"))).toEqual({
      row: 1,
      col: 0,
    });
    expect(Option.getOrUndefined(jumpDiagnostic(diags, { row: 3, col: 2 }, "prev"))).toEqual({
      row: 1,
      col: 0,
    });
    expect(Option.getOrUndefined(jumpDiagnostic(diags, { row: 0, col: 0 }, "first"))).toEqual({
      row: 1,
      col: 0,
    });
    expect(Option.getOrUndefined(jumpDiagnostic(diags, { row: 0, col: 0 }, "last"))).toEqual({
      row: 5,
      col: 0,
    });
  });

  test("flattenDocumentSymbols walks children", () => {
    const locs = flattenDocumentSymbols("file:///a.ts", [
      {
        name: "outer",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        children: [
          {
            name: "inner",
            kind: 6,
            range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } },
            selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 7 } },
          },
        ],
      },
    ]);
    expect(locs).toEqual([
      {
        uri: "file:///a.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      },
      {
        uri: "file:///a.ts",
        range: { start: { line: 2, character: 2 }, end: { line: 2, character: 7 } },
      },
    ]);
  });
});
