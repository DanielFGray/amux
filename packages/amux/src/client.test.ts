import { describe, expect, it } from "bun:test";
import { unchangedOutput } from "./client.ts";
import type { WorkspaceSnapshot } from "./workspace.ts";
import { spaceSetState } from "./space-model.ts";

const workspace: WorkspaceSnapshot = { revision: 7, spaces: [], state: spaceSetState() };

describe("unchangedOutput", () => {
  it("resolves a workspace-less output to the current snapshot", () => {
    expect(unchangedOutput(workspace, undefined)).toEqual({ snapshot: workspace });
  });

  it("passes a result through alongside the current snapshot", () => {
    expect(unchangedOutput(workspace, { ok: true })).toEqual({
      snapshot: workspace,
      result: { ok: true },
    });
  });

  it("returns a copy, not the live model", () => {
    const folded = unchangedOutput(workspace, undefined);
    expect(folded.snapshot).toEqual(workspace);
    expect(folded.snapshot).not.toBe(workspace);
  });
});
