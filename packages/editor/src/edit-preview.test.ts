import { describe, expect, test } from "bun:test";
import { unifiedDiff, workspaceEditPreview } from "./edit-preview.ts";

describe("edit-preview", () => {
  test("unifiedDiff marks replaced lines", () => {
    const diff = unifiedDiff(["a", "b", "c"], ["a", "B", "c"], "x.ts");
    expect(diff).toContain("--- a/x.ts");
    expect(diff).toContain("+++ b/x.ts");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
  });

  test("workspaceEditPreview applies current-uri edits", () => {
    const uri = "file:///workspace/x.ts";
    const text = workspaceEditPreview(
      uri,
      ["const x = 1;"],
      {
        changes: {
          [uri]: [
            {
              range: {
                start: { line: 0, character: 10 },
                end: { line: 0, character: 11 },
              },
              newText: "2",
            },
          ],
        },
      },
      "x.ts",
    );
    expect(text).toContain("-const x = 1;");
    expect(text).toContain("+const x = 2;");
  });

  test("workspaceEditPreview notes other URIs", () => {
    const uri = "file:///workspace/a.ts";
    const text = workspaceEditPreview(
      uri,
      ["a"],
      {
        changes: {
          [uri]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "A",
            },
          ],
          "file:///workspace/b.ts": [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "B",
            },
          ],
        },
      },
      "a.ts",
    );
    expect(text).toContain("1 other file not shown");
  });
});
