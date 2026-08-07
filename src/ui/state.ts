import { createSignal, createMemo, type Accessor } from "solid-js";
import type { SpaceSet, Space } from "../space.ts";
import type { Window } from "../window.ts";
import type { Session } from "../agent.ts";
import type { TerminalPane } from "../pane.ts";

/** How often polled state (agent status, spinner frame) is re-read. */
export const POLL_MS = 100;

export interface AppState {
  spaces: Accessor<readonly Space[]>;
  active: Accessor<Space | null>;
  /** The window keystrokes land in. */
  activeWindow: Accessor<Window | null>;
  focusedPane: Accessor<TerminalPane | null>;
  allAgents: Accessor<Session[]>;
  /** Advances on a timer. Read this in anything that displays polled state. */
  tick: Accessor<number>;
  /** Current spinner frame index, derived from the tick. */
  frame: Accessor<number>;
  /** Bump after any structural change (space/agent/pane added or removed). */
  refresh: () => void;
  /** Advance every view of state that must be polled. */
  poll: () => void;
}

/**
 * A reactive view of the imperative domain objects.
 *
 * Two kinds of change, modelled differently on purpose:
 *
 * - *Structural* — a space or agent appears or disappears, focus moves. These
 *   are push events; `refresh()` bumps a revision signal from SpaceSet.onChange.
 * - *Polled* — an agent's state, its foreground command, the spinner frame.
 *   There is nothing to push from: the state lives in the kernel (the pty's
 *   foreground pgid) or on the agent's screen, and ghostty deliberately offers
 *   no notification for scroll position either. The app's one polling timer
 *   calls `poll()` alongside its other fixed-cadence work.
 *
 * Views read `tick()` alongside a getter to opt into the polled refresh.
 */
export function createAppState(spaces: SpaceSet): AppState {
  const [revision, setRevision] = createSignal(0);
  const [tick, setTick] = createSignal(0);

  const refresh = () => setRevision((r) => r + 1);
  const poll = () => setTick((t) => t + 1);

  const previous = spaces.onChange;
  spaces.onChange = () => {
    previous?.();
    refresh();
  };

  const spacesList = createMemo(() => {
    revision();
    return [...spaces.spaces];
  });

  return {
    spaces: spacesList,
    // equals:false on every memo that returns a domain OBJECT. Solid dedupes
    // by identity, and these return the same Space/Window/pane instance across
    // revisions even when its contents changed — so a dependent reading
    // `active().windows` would never see a window added. The array-returning
    // memos below build a fresh array each time and notify on their own.
    active: createMemo(
      () => {
        revision();
        return spaces.active;
      },
      undefined,
      { equals: false },
    ),
    activeWindow: createMemo(
      () => {
        revision();
        return spaces.activeWindow;
      },
      undefined,
      { equals: false },
    ),
    focusedPane: createMemo(
      () => {
        revision();
        return spaces.activeWindow?.focused ?? null;
      },
      undefined,
      { equals: false },
    ),
    allAgents: createMemo(() => {
      revision();
      return spaces.allAgents;
    }),
    tick,
    frame: tick,
    refresh,
    poll,
  };
}
