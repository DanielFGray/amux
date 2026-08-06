import type { Accessor } from "solid-js";
import type { WorkspaceSnapshot } from "../workspace.ts";
import type { Command, CommandError } from "../commands.ts";
import { Effect } from "effect";
import type { Options, OptionName, OptionValue } from "../options.ts";

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
}

/** Make the panel context from app-owned signals so it carries no domain objects. */
export function createPanelContext(
  snapshot: Accessor<WorkspaceSnapshot>,
  tick: Accessor<number>,
  run: (command: Command, input?: string) => Effect.Effect<WorkspaceSnapshot, CommandError>,
  options: Accessor<Options>,
  setOption: (name: OptionName, value: OptionValue) => void,
): PanelContext {
  return {
    snapshot: () => structuredClone(snapshot()),
    tick,
    run,
    options: () => ({ ...options() }),
    setOption,
  };
}
