import { paneSession } from "../layout.ts";
import {
  resolveTarget,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
} from "../workspace.ts";
import type { ProcessPluginInvocationContext } from "./env.ts";

export interface ProcessPluginContextOptions {
  readonly workspace: WorkspaceSnapshot;
  readonly commandContext: Pick<WorkspaceCommandContext, "agent" | "pane" | "cwd">;
  readonly invocationSource: string;
  readonly correlationId?: string;
}

/** Mutable builder for {@link ProcessPluginInvocationContext}. */
type ContextDraft = {
  spaceId?: string;
  spaceLabel?: string;
  spaceCwd?: string;
  windowNumber?: number;
  windowLabel?: string;
  focusedPaneId?: string;
  focusedPaneCwd?: string;
  invocationSource: string;
  correlationId?: string;
};

/**
 * Fill AMUX_PLUGIN_CONTEXT_JSON from the daemon's live workspace.
 * Prefer the caller's pane when present; otherwise the focused pane of the
 * active window — the same {@link resolveTarget} rule every pane command uses.
 */
export function processPluginInvocationContextFromWorkspace(
  options: ProcessPluginContextOptions,
): ProcessPluginInvocationContext {
  const { workspace, commandContext, invocationSource, correlationId } = options;
  const target = resolveTarget(workspace, {}, {
    agent: commandContext.agent,
    pane: commandContext.pane,
  });
  const space = target?.window.space;
  const window = target?.window.window;
  const pane = target?.pane;
  const sessionId = pane !== undefined ? paneSession(pane.content) : undefined;
  const session =
    sessionId !== undefined
      ? window?.sessions.find((entry) => entry.id === sessionId)
      : undefined;

  const context: ContextDraft = { invocationSource };
  if (space !== undefined) {
    context.spaceId = space.id;
    context.spaceLabel = space.name;
    context.spaceCwd = space.dir;
  }
  if (window !== undefined) {
    context.windowNumber = window.number;
    if (window.name !== null) context.windowLabel = window.name;
  }
  if (pane !== undefined) context.focusedPaneId = pane.id;
  if (session?.cwd !== undefined) context.focusedPaneCwd = session.cwd;
  else if (commandContext.cwd !== undefined) context.focusedPaneCwd = commandContext.cwd;
  if (correlationId !== undefined) context.correlationId = correlationId;
  return context;
}
