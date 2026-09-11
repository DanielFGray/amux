import { paneSession } from "../layout.ts";
import {
  findWindow,
  workspacePaneOf,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
} from "../workspace.ts";
import type { ProcessPluginInvocationContext } from "./env.ts";

export interface ProcessPluginContextOptions {
  readonly workspace: WorkspaceSnapshot;
  readonly commandContext: Pick<WorkspaceCommandContext, "pane" | "cwd">;
  readonly invocationSource: string;
  readonly correlationId?: string;
}

/**
 * Fill AMUX_PLUGIN_CONTEXT_JSON from the daemon's live workspace.
 * Prefer the caller's pane when present; otherwise the focused pane of the
 * active window — the same default keybinds and CLI `--current` use.
 */
export function processPluginInvocationContextFromWorkspace(
  options: ProcessPluginContextOptions,
): ProcessPluginInvocationContext {
  const { workspace, commandContext, invocationSource, correlationId } = options;
  const focused =
    (commandContext.pane !== undefined
      ? workspacePaneOf(workspace, commandContext.pane)
      : null) ??
    (() => {
      const active = findWindow(workspace, {});
      if (!active || active.window.state.focus === null) return null;
      return workspacePaneOf(workspace, active.window.state.focus);
    })();

  const space = focused?.space;
  const window = focused?.window;
  const pane = focused?.pane;
  const sessionId = pane !== undefined ? paneSession(pane.content) : undefined;
  const session =
    sessionId !== undefined
      ? window?.sessions.find((entry) => entry.id === sessionId)
      : undefined;

  return {
    ...(space !== undefined
      ? { spaceId: space.id, spaceLabel: space.name, spaceCwd: space.dir }
      : {}),
    ...(window !== undefined
      ? {
          windowNumber: window.number,
          ...(window.name !== null ? { windowLabel: window.name } : {}),
        }
      : {}),
    ...(pane !== undefined ? { focusedPaneId: pane.id } : {}),
    ...(session?.cwd !== undefined
      ? { focusedPaneCwd: session.cwd }
      : commandContext.cwd !== undefined
        ? { focusedPaneCwd: commandContext.cwd }
        : {}),
    invocationSource,
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
}
