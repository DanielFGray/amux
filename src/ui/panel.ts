import type { Accessor } from "solid-js";
import type { WorkspaceSnapshot } from "../workspace.ts";
import type { Command, CommandError } from "../commands.ts";
import { Effect } from "effect";
import type { Options, OptionName, OptionValue } from "../options.ts";

/**
 * A single row of display data for the sidebar tree.
 *
 * Carries only plain values derived from the app's live projections; a plugin
 * never references Space, Window, Agent, TerminalPane, or any FFI handle.
 */
export interface SidebarDisplayRow {
  readonly kind: "space" | "branch" | "window" | "agent";
  /** Selectable index (branch rows are skipped). */
  readonly index: number;
  readonly spaceId: string;
  readonly spaceName: string;
  /** Active space, active window, or focused agent. */
  readonly active: boolean;
  readonly branch?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly windowNumber?: number;
  readonly windowLabel?: string;
  readonly agentId?: string;
  readonly agentState?: string;
  readonly agentCliKind?: string | null;
  readonly agentSessionKind?: string;
  readonly title?: string;
  readonly foregroundCommand?: string | null;
  readonly viewers?: number;
  readonly unseen?: boolean;
  readonly scrolled?: boolean;
  readonly exited?: boolean;
}

export interface SidebarDisplay {
  readonly rows: readonly SidebarDisplayRow[];
  readonly spaceCount: number;
  readonly agentCount: number;
  readonly blockedCount: number;
}

/**
 * The read-model projection a panel receives: plain data, no live domain objects.
 *
 * Every field is derived from the daemon-owned workspace and the client's option
 * store, so a panel never holds a reference to SpaceSet, Space, Window, Agent,
 * TerminalPane, or any FFI handle. The snapshot carries `PersistedAgent`,
 * `Layout`, `WindowState`, and `SpaceSetState` — the full authoritative
 * immutable model the daemon and the control socket already speak.
 */

export interface PanelContext {
  /** The current workspace as a reactive immutable snapshot. */
  readonly snapshot: Accessor<WorkspaceSnapshot>;
  /** Advances on the UI poll timer — panels that display polled state read this. */
  readonly tick: Accessor<number>;
  /** Invoke a workspace command through the daemon's model queue. The result
   *  is the authored generation; the snapshot signal updates from the attach
   *  stream independently. */
  readonly run: (
    command: Command,
    input?: string,
  ) => Effect.Effect<WorkspaceSnapshot, CommandError>;
  /** Current resolved option values. */
  readonly options: Accessor<Options>;
  /** Set an option value. Clamping and delta storage are the option table's job;
   *  this just routes the change into the app's config state. */
  readonly setOption: (name: OptionName, value: OptionValue) => void;
  /** Value-only display data derived from live projections, recomputed on poll. */
  readonly display: Accessor<SidebarDisplay>;
  /** User-visible command error callback. */
  readonly reportError: (message: string) => void;
  /** The agent the sidebar last activated, as a plain id. Read for
   *  capture/send-keys fallback when the focused pane is absent. */
  readonly selectedAgentId: Accessor<string | null>;
  readonly setSelectedAgentId: (id: string | null) => void;
}

/** Make the panel context from app-owned signals so it carries no domain objects. */
export function createPanelContext(
  snapshot: Accessor<WorkspaceSnapshot>,
  tick: Accessor<number>,
  run: (command: Command, input?: string) => Effect.Effect<WorkspaceSnapshot, CommandError>,
  options: Accessor<Options>,
  setOption: (name: OptionName, value: OptionValue) => void,
  display: Accessor<SidebarDisplay>,
  reportError: (message: string) => void,
  selectedAgentId: Accessor<string | null>,
  setSelectedAgentId: (id: string | null) => void,
): PanelContext {
  return {
    snapshot: () => structuredClone(snapshot()),
    tick,
    run,
    options: () => ({ ...options() }),
    setOption,
    display: () => structuredClone(display()),
    reportError,
    selectedAgentId,
    setSelectedAgentId,
  };
}
