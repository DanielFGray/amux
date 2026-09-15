import { describe, expect, it } from "bun:test";
import { Schema as S } from "effect";
import { unchangedOutput } from "./client.ts";
import { OwnerJsonText } from "./layout.ts";
import type { WorkspaceSnapshot } from "./workspace.ts";
import { spaceSetState } from "./space-model.ts";

const ownerText = (value: typeof OwnerJsonText.Encoded) => S.decodeSync(OwnerJsonText)(value);

const workspace: WorkspaceSnapshot = { revision: 7, spaces: [], state: spaceSetState() };

describe("unchangedOutput", () => {
  it("resolves a workspace-less output to the current snapshot", () => {
    expect(unchangedOutput(workspace, undefined)).toEqual({ snapshot: workspace });
  });

  it("passes a result through alongside the current snapshot", () => {
    const result = ownerText({ ok: true });
    expect(unchangedOutput(workspace, result)).toEqual({
      snapshot: workspace,
      result,
    });
  });

  it("returns a copy, not the live model", () => {
    const folded = unchangedOutput(workspace, undefined);
    expect(folded.snapshot).toEqual(workspace);
    expect(folded.snapshot).not.toBe(workspace);
  });
});
