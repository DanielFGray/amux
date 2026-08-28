/**
 * Serializing the live workspace model into session metadata, and restoring it.
 *
 * ## What a session file is, and what it is not
 *
 * It is metadata: which spaces exist, which windows they hold, what command
 * each agent was started with, where, at what size, how the panes were
 * arranged, and what had already exited. That is enough to put the *workspace*
 * back — the same windows under the same numbers, the same split tree, the same
 * pane focused.
 *
 * It is emphatically NOT terminal persistence. A restored agent's screen and
 * scrollback are empty, because they were never in the file: the emulator's
 * grid is tens of thousands of styled cells and a session file is a few
 * kilobytes of JSON that is rewritten on every change. What comes back is a
 * fresh run of the same command in the same directory. tmux draws the same
 * line, and for the same reason its panes survive a *client* detach but not a
 * *server* restart: keeping the screen means keeping the process, and keeping
 * the process means a daemon that owns the PTY.
 *
 * That daemon is where real continuity comes from, and the seam for it is
 * AgentBackend (see backend.ts): restore hands every agent its backend, so the
 * day the daemon owns the PTYs, restore attaches to the live ones instead of
 * re-running them, and nothing above here changes.
 *
 * ## Exited agents
 *
 * An agent that had already exited comes back as a tombstone — named, with its
 * exit code, running nothing. Re-running it would be worse than useless: the
 * command already had its turn, and some of them are not idempotent. It gets no
 * pane, which is the same state the live app leaves an agent in the moment it
 * exits.
 *
 * A detached daemon agent is deliberately not persisted as a state value. It is
 * still live (`exited: false`) and the daemon backend determines whether this
 * client is attached after restore.
 */

import { Effect } from "effect";
import {
  decodeLayout,
  encodeLayout,
  newPaneId,
  presetLayout,
  prune,
  type Layout,
} from "./layout.ts";
import type { SessionBackendFactory } from "./backend.ts";
import type { SessionHandle } from "./session-handle.ts";
import type { Window } from "./window.ts";
import type { Space, SpaceSet } from "./space.ts";
import {
  SESSION_VERSION,
  type PersistedSession,
  type PersistedSpace,
  type PersistedWindow,
  type SessionState,
} from "./session.ts";

/** The arrangement a restored window falls back to when none was recorded, or
 *  when the one recorded no longer parses. */
const FALLBACK_PRESET = "tiled";

export function snapshotSessionEntry(session: SessionHandle): PersistedSession {
  const entry: PersistedSession = {
    id: session.id,
    name: session.name,
    cols: session.term.cols,
    rows: session.term.rows,
    exited: session.exited,
    exitCode: session.exitCode,
  };
  if (session.kind === "component") Object.assign(entry, { kind: "component" as const });
  if (session.declaredAgent) Object.assign(entry, { declaredAgent: session.declaredAgent });
  if (session.cmd.length > 0) Object.assign(entry, { cmd: [...session.cmd] });
  if (session.provider) Object.assign(entry, { provider: session.provider });
  if (session.cwd) Object.assign(entry, { cwd: session.cwd });
  return entry;
}

/**
 * A window as metadata, including its arrangement.
 *
 * The agent list and the layout answer different questions and both are needed:
 * the list is every agent the window owns, including ones no pane is showing,
 * while the layout is only the ones on screen and how they are placed. An agent
 * that has exited, or whose view was closed, appears in the first and not the
 * second — and comes back the same way.
 */
export function snapshotWindow(window: Window): PersistedWindow {
  return {
    number: window.number,
    name: window.customName,
    sessions: window.sessions.map(snapshotSessionEntry),
    layout: encodeLayout(window.exportLayout()),
  };
}

export function snapshotSpace(space: Space): PersistedSpace {
  return {
    id: space.id,
    name: space.name,
    dir: space.dir,
    activeWindow: space.activeWindowNumber,
    windows: space.windows.map(snapshotWindow),
  };
}

/**
 * The whole workspace as a session state, carrying `base`'s identity forward.
 *
 * `base` is the state on disk (or the daemon's) so createdAt and the session id
 * survive; only the parts describing the workspace are replaced.
 */
export function snapshotSession(spaces: SpaceSet, base: SessionState): SessionState {
  return {
    ...base,
    version: SESSION_VERSION,
    updatedAt: Date.now(),
    activeSpace: spaces.activeSpaceId,
    spaces: spaces.spaces.map(snapshotSpace),
  };
}

export interface RestoreOptions {
  /** Where restored agents get their processes. Defaults to a local PTY, the
   *  same as any other agent; a daemon-attached client passes its own. */
  backend?: SessionBackendFactory;
}

/**
 * Rebuild a workspace from persisted spaces.
 *
 * Additive: spaces are appended to whatever the set already holds, so this is
 * usable both at boot (an empty set) and to merge a saved session in. Returns
 * the spaces it created.
 *
 * The active space and window are selected last. Creating a space activates it
 * and creating a window selects it, so doing it as we go would leave whatever
 * happened to be built last on screen rather than what was recorded.
 */
export const restoreSpaces = Effect.fnUntraced(function* (
  spaces: SpaceSet,
  persisted: readonly PersistedSpace[],
  options: RestoreOptions = {},
) {
  const created: Space[] = [];
  for (const saved of persisted) {
    const space = yield* spaces.create(saved.name, saved.dir, saved.id);
    created.push(space);
    for (const savedWindow of saved.windows) {
      yield* restoreWindow(space, savedWindow, options);
    }
    const active = saved.activeWindow;
    const window = active === null ? undefined : space.windows.find((w) => w.number === active);
    if (window) space.selectWindow(window);
  }
  return created;
});

/** Rebuild a whole session, including which space was on screen. */
export const restoreSession = Effect.fnUntraced(function* (
  spaces: SpaceSet,
  state: SessionState,
  options: RestoreOptions = {},
) {
  const created = yield* restoreSpaces(spaces, state.spaces, options);
  const active = state.activeSpace ? created.find((s) => s.id === state.activeSpace) : undefined;
  if (active) spaces.activate(active);
  return created;
});

/** Rebuild one window into `space`, agents first and then the arrangement. */
export const restoreWindow = Effect.fnUntraced(function* (
  space: Space,
  saved: PersistedWindow,
  options: RestoreOptions = {},
) {
  const window = yield* space.newWindow(saved.name ?? undefined, saved.number);
  for (const session of saved.sessions) {
    const sessionSpec = {
      id: session.id,
      name: session.name,
      kind: session.kind,
      agent: session.declaredAgent,
      cmd: session.cmd ?? [],
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
    };
    if (session.provider) Object.assign(sessionSpec, { provider: session.provider });
    // A dead agent is restored as a tombstone rather than re-run. Its own
    // backend is fixed by that, so the option deliberately does not reach it.
    Object.assign(
      sessionSpec,
      session.exited ? { exited: { code: session.exitCode } } : { backend: options.backend },
    );
    yield* window.startSession(sessionSpec);
  }

  // Only the live agents get panes: an exited one has no view in the running
  // app either, and applyLayout would happily build it one.
  const live = window.sessions.filter((a) => !a.exited);
  if (live.length > 0) {
    const layout = yield* restoredLayout(saved, live);
    window.applyLayout(layout);
  }
  return window;
});

/**
 * The layout to rebuild with: the recorded one, or a preset over the survivors.
 *
 * Pruned to the live agents first. A window's agent list outlives its layout —
 * tombstones are owned by the window but have no view, so a layout naming one
 * would build it a pane that the running app would never have given it.
 *
 * A layout that no longer parses is a corrupted or hand-edited field, not a
 * reason to lose the session: the agents are all still there and an arrangement
 * can always be invented. Same for one that prunes away to nothing.
 *
 * Focus rides along inside the layout and is not recorded beside it. It used to
 * be, as PersistedWindow.focusedAgent, because a layout could only name the
 * focused pane by its agent and two panes on one agent were indistinguishable;
 * panes carry their own identity now (layout.ts PaneRef), so the layout says it
 * exactly and a second copy could only ever disagree with it. makeLayout
 * already drops a focus whose pane did not survive the prune.
 *
 * The invented fallback gets fresh pane ids: those panes are being created here
 * and now, and nothing else has ever named them.
 */
function restoredLayout(
  saved: PersistedWindow,
  live: SessionHandle[],
): Effect.Effect<Layout, never> {
  const alive = new Set(live.map((session) => session.id));
  return Effect.gen(function* () {
    let recorded: Layout | null = null;
    if (saved.layout) {
      const result = yield* Effect.result(decodeLayout(saved.layout));
      if (result._tag === "Success") recorded = result.success;
    }
    const pruned = recorded ? prune(recorded, (id) => alive.has(id)) : null;
    if (pruned?.root) return pruned;
    return presetLayout(
      live.map((session) => ({
        id: newPaneId(),
        content:
          session.kind === "component"
            ? {
                kind: "plugin",
                type: session.declaredAgent ?? "component",
                descriptor: {},
                session: session.id,
              }
            : { kind: "pty", session: session.id },
      })),
      FALLBACK_PRESET,
    );
  });
}
