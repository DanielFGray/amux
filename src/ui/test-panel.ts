import { Effect } from "effect";
import { createPanelContext, type PanelContext } from "./panel.ts";
import { resolveOptions } from "../options.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";

/**
 * A panel context over an empty workspace and the default options.
 *
 * The context has no optional fields — a panel is entitled to every one of
 * them — so a check that is about one field still has to supply the rest.
 * Overriding the one it is about is the whole of what it should have to say.
 */
export function testPanelContext(parts: Partial<PanelContext> = {}): PanelContext {
  return createPanelContext({
    snapshot: () => EMPTY_SNAPSHOT,
    tick: () => 0,
    run: () => Effect.succeed(EMPTY_SNAPSHOT),
    options: () => resolveOptions({}),
    setOption: () => {},
    saveOptions: () => {},
    display: () => ({ rows: [], spaceCount: 0, agentCount: 0, blockedCount: 0 }),
    reportError: () => {},
    selectedAgentId: () => null,
    setSelectedAgentId: () => {},
    ...parts,
  });
}

const EMPTY_SNAPSHOT: WorkspaceSnapshot = { revision: 0, spaces: [], state: { activeSpace: null, nextSpace: 1 } };
