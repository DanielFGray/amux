import { isCoreCommand, type Command, type RuntimeCommand } from "./commands.ts";
import type { JsonValue } from "./effect/AttachProtocol.ts";
import type { CreationResult } from "./creation-result.ts";
import type { PaneMoveResult } from "./commands.ts";
import {
  WorkspaceSpaceSchema,
  type AgentEntry as ReadAgentEntry,
  type PaneEntry as ReadPaneEntry,
  type PaneLayout as ReadPaneLayout,
  type SpaceEntry as ReadSpaceEntry,
  type WindowEntry as ReadWindowEntry,
} from "./read-model.ts";
import { randomUUID } from "node:crypto";
import { nodePath } from "./effect/node-path.ts";
import { worktreeDirname } from "./git.ts";
import { computeRects, moveFloat, resizeDivider, resizePane, setPaneSize, type LayoutSize } from "./geometry.ts";
import {
  decodeLayout,
  encodeLayout,
  appendPane,
  layoutPanes,
  layoutRefs,
  componentViewType,
  layoutSessions,
  makeLayout,
  nextPreset,
  paneRetainedSessions,
  paneSession,
  placementOf,
  presetLayout,
  prune,
  setPlacement,
  setDock,
  setPaneContent,
  setPaneDescriptor,
  setPaneAgentSession,
  undockPane,
  splitLayout,
  swapLayout,
  windowState,
  LayoutFormatError,
  type Layout,
  type PaneContent,
  type PaneRef,
  type WindowState,
} from "./layout.ts";
import {
  parseSessionState,
  SessionStateError,
  SESSION_VERSION,
  type PersistedSession,
  type SessionState,
} from "./session.ts";
import {
  activateSpaceState,
  claimPaneNumber,
  claimWindowNumber,
  closeWindowState,
  removeSpaceState,
  selectWindowState,
  spaceState,
  type SpaceSetState,
  type SpaceState,
} from "./space-model.ts";
import { MAX_SPACES, MAX_TERMINAL_CELLS, MAX_TERMINAL_DIMENSION } from "./limits.ts";
import { NonEmptyString, PositiveInt } from "./schema-primitives.ts";
import type { PaneAgentSessionSnapshot } from "./agent-session.ts";
import { Clock, Effect, Option, Result, Schema as S } from "effect";
import type { TilingAlgorithm } from "./tiling-algorithm.ts";
import { defaultTilingAlgorithm } from "./tiling-algorithm-default.ts";

const { basename, join, resolve } = nodePath;

export class WorkspaceParseError extends S.TaggedError<WorkspaceParseError>()(
  "WorkspaceParseError",
  {
    message: S.String,
  },
) {}

export interface WorkspaceWindow {
  number: number;
  name: string | null;
  sessions: PersistedSession[];
  layout: Layout;
  state: WindowState;
}

export interface WorkspaceSpace {
  id: string;
  name: string;
  dir: string;
  windows: WorkspaceWindow[];
  state: SpaceState;
  worktree?: { branch: string; repo: string; path: string };
}

/** The renderer-free value owned and ordered by one session daemon. */
export interface WorkspaceSnapshot {
  revision: number;
  spaces: WorkspaceSpace[];
  state: SpaceSetState;
}

/** A window with the space that owns it. The model is a tree — a space owns its
 *  windows, a window owns its sessions — so ownership is always determined and
 *  every traversal can hand back the owners rather than making callers re-nest
 *  to recover them. */
export interface WindowEntry {
  space: WorkspaceSpace;
  window: WorkspaceWindow;
}

export interface SessionEntry extends WindowEntry {
  session: PersistedSession;
}

export function* workspaceWindows(workspace: WorkspaceSnapshot): Generator<WindowEntry> {
  for (const space of workspace.spaces) for (const window of space.windows) yield { space, window };
}

export function* workspaceSessions(workspace: WorkspaceSnapshot): Generator<SessionEntry> {
  for (const entry of workspaceWindows(workspace))
    for (const session of entry.window.sessions) yield { ...entry, session };
}

export function workspaceSessionIds(workspace: WorkspaceSnapshot): Set<string> {
  return new Set(Array.from(workspaceSessions(workspace), ({ session }) => session.id));
}

export function workspacePaneIds(workspace: WorkspaceSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const { window } of workspaceWindows(workspace))
    for (const pane of layoutRefs(window.layout)) ids.add(pane.id);
  return ids;
}

export interface WorkspaceCommandContext {
  size: LayoutSize;
  shell: string[];
  cwd: string;
  /** Native agents execute workspace commands in the window containing them. */
  agent?: string;
  /** The pane the caller runs in, when the call came from inside one. */
  pane?: string;
  /** The daemon-owned session that caused a command from its process. This is
   * only attribution for durable feedback, never a workspace target. */
  originSession?: string;
  /** True when a background caller asked for no focus to move. The mutation
   *  applies its structure but leaves the workspace's focus and activation
   *  state exactly as it found it. */
  noFocus?: boolean;
  /** Client-observed attention state, used only by session.next-blocked. */
  blockedAgents?: readonly string[];
  /** A pre-processed payload for a workspace command that wants one, alongside
   *  `PanelContext.run`. `pane.send-keys` used to be its only caller; it now
   *  writes to its session directly (or routes to a client) instead. */
  input?: string;
  /** Root directory for space worktrees. Daemon authority: derived from the
   *  session env, never the client. Required only when a command creates a
   *  worktree space (space.new with a branch). */
  worktreesRoot?: string;
}

/** The agent amux runs itself, as opposed to a foreign CLI in a shell pane. */
const TerminalDimension = S.Int.pipe(
  S.check(S.isGreaterThan(0)),
  S.check(S.isLessThanOrEqualTo(MAX_TERMINAL_DIMENSION)),
);
const TerminalSize = S.Struct({
  cols: TerminalDimension,
  rows: TerminalDimension,
}).pipe(
  S.check(
    S.makeFilter(({ cols, rows }) => cols * rows <= MAX_TERMINAL_CELLS, {
      message: "terminal size is too large",
    }),
  ),
);
const WorkspaceSnapshotSchema = S.Struct({
  revision: S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(0))),
  spaces: S.mutable(S.Array(WorkspaceSpaceSchema)).pipe(S.check(S.isMaxLength(MAX_SPACES))),
  state: S.Struct({
    activeSpace: S.NullOr(NonEmptyString),
    nextSpace: PositiveInt,
  }),
});
export const WorkspaceSnapshotJson = S.fromJsonString(WorkspaceSnapshotSchema);

/** The persisted counter bearing the space's id: `s3` -> 3, anything else -> null. */
function spaceCounter(id: string): number | null {
  const match = /^s([1-9]\d*)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/** The pane counter a persisted pane id carries, if any: `s2:p7` -> 7. */
function paneCounter(id: string): number | null {
  const match = /:p([1-9]\d*)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/** Decode the JSON string used by the control and attach protocols. */
export function parseWorkspaceJson(
  value: string,
): Effect.Effect<WorkspaceSnapshot, WorkspaceParseError | SessionStateError> {
  return S.decodeEffect(WorkspaceSnapshotJson)(value).pipe(
    Effect.mapError(
      (error) =>
        new WorkspaceParseError({
          message: `workspace JSON is invalid: ${String(error)}`,
        }),
    ),
    Effect.flatMap(parseWorkspace),
  );
}

export const WorkspaceCommandContextSchema = S.Struct({
  size: TerminalSize,
  shell: S.Array(NonEmptyString).pipe(S.check(S.isMinLength(1))),
  cwd: NonEmptyString,
  agent: S.optional(NonEmptyString),
  pane: S.optional(NonEmptyString),
  originSession: S.optional(NonEmptyString),
  noFocus: S.optional(S.Boolean),
  blockedAgents: S.optional(S.Array(NonEmptyString)),
  input: S.optional(S.String),
  worktreesRoot: S.optional(S.String),
});

// A turn's prompt/interrupt/permission-decision used to be named tags here.
// They carried no meaning core acts on beyond "deliver this opaque payload to
// a live session" — exactly what `SessionOps.message` already does generically
// — so they are ordinary `PluginWorkspaceAction`s now, owned and interpreted
// by whichever plugin pushes them (plugin-agent-harness).
export type CoreWorkspaceAction =
  | { readonly _tag: "spawn"; readonly agent: PersistedSession; pane?: string }
  | { readonly _tag: "kill"; readonly agent: string }
  | { readonly _tag: "restart"; readonly agent: string }
  | { readonly _tag: "input"; readonly agent: string; readonly data: string };

const CORE_ACTION_TAGS: ReadonlySet<string> = new Set(["spawn", "kill", "restart", "input"]);

export const isCoreWorkspaceAction = (action: WorkspaceAction): action is CoreWorkspaceAction =>
  CORE_ACTION_TAGS.has(action._tag);

/** A plugin-contributed action variant. Core never produces these; the
 *  transaction routes them to the executor the contributing plugin registered. */
export interface PluginWorkspaceAction {
  readonly _tag: string;
  readonly [key: string]: JsonValue;
}

export type WorkspaceAction = CoreWorkspaceAction | PluginWorkspaceAction;

export interface WorkspaceMutation {
  readonly snapshot: WorkspaceSnapshot;
  readonly actions: readonly WorkspaceAction[];
  readonly changed: boolean;
  readonly result?: JsonValue;
}

/**
 * What a daemon-resident plugin may do to the workspace draft for a command
 * core does not own.
 *
 * The layout algebra stays behind this interface: a reducer names sessions
 * and panes through opaque entries, never touching tree structure or id
 * counters itself. Methods mutate the same draft core's own reducer writes,
 * so the post-reduce fixups (spawn pane resolution, no-focus restore,
 * normalization, change detection) apply to plugin commands unchanged.
 */
export interface WorkspaceDraft {
  /** The window a command without an explicit target acts in. */
  readonly activeWindow: () => WindowEntry | null;
  /** A session by id, or the focused pane's session when no id is given. */
  readonly findSession: (id?: string) => SessionEntry | null;
  /**
   * Add a backend to a window's roster and queue its spawn. A `provider`
   * makes it a component session (a harness worker the client respawns);
   * without one it is a plain shell session.
   */
  readonly addSession: (
    target: WorkspaceWindow,
    dir: string,
    opts?: {
      readonly provider?: string;
      /** Reuse a prior session id (resume a stored conversation + AgentLog). */
      readonly id?: string;
    },
  ) => PersistedSession;
  /** Show a session in its window. Default splits/appends; `mode: "replace"`
   *  rewrites the calling (or focused) leaf in place and keeps any displaced
   *  session alive via `PaneContent.displaced`. Returns the pane id. */
  readonly placeSessionPane: (
    target: WindowEntry,
    agent: PersistedSession,
    opts?: { readonly mode?: "split" | "replace" },
  ) => string;
  /** Place a sessionless plugin pane. Default splits the focused pane in a
   *  row; `mode: "replace"` rewrites the calling (or focused) leaf and keeps
   *  the previous session alive off-layout. Returns its id, or null when
   *  there is no target. */
  readonly placePluginPane: (
    type: string,
    descriptor: JsonValue,
    opts?: { readonly mode?: "split" | "replace" },
  ) => string | null;
  readonly pushAction: (action: WorkspaceAction) => void;
  readonly setResult: (result: JsonValue) => void;
  /** Every agent in the draft, as the machine-facing read surface shapes them. */
  readonly listAgents: () => readonly ReadAgentEntry[];
  readonly getAgent: (id: string) => ReadAgentEntry | null;
}

export type PluginWorkspaceReducer = (
  draft: WorkspaceDraft,
  command: RuntimeCommand,
  context: WorkspaceCommandContext,
) => void;

/**
 * Adopt persisted state at the daemon boundary.
 *
 * Layouts from disk are untrusted: malformed trees fall back to a fresh tiled
 * arrangement over live agents, recorded panes naming absent agents are pruned,
 * and live agents the layout does not reference are pruned too. Internal
 * command transforms do not pass through this validation and may legitimately
 * produce an empty layout.
 */
export function workspaceFromSession(
  session: SessionState,
): Effect.Effect<WorkspaceSnapshot, LayoutFormatError | SessionStateError> {
  return Effect.gen(function* () {
    const usedPaneIds = new Set<string>();
    for (const saved of session.spaces) {
      for (const window of saved.windows) {
        if (!window.layout) continue;
        const layout = yield* decodeLayout(window.layout);
        for (const pane of layoutRefs(layout)) usedPaneIds.add(pane.id);
      }
    }
    // The id counters resume from what the data itself proves was issued:
    // persisted counters if this session was written by a counter-era daemon,
    // else the live maximum. Either way the promise is kept — a closed id is
    // never reissued — because the persisted counter only ever advances.
    const spaceCounters = session.spaces.map((saved) => spaceCounter(saved.id) ?? 0);
    const paneId = () => allocateId("pane", usedPaneIds);
    return {
      revision: 0,
      state: {
        activeSpace: session.spaces.some((space) => space.id === session.activeSpace)
          ? (session.activeSpace ?? null)
          : (session.spaces[0]?.id ?? null),
        nextSpace: Math.max(
          session.nextSpace ?? 1,
          ...spaceCounters.map((counter) => counter + 1),
          1,
        ),
      },
      spaces: yield* Effect.all(
        session.spaces.map((saved) =>
          Effect.gen(function* () {
            const windows: WorkspaceWindow[] = [];
            const livePaneCounters: number[] = [];
            for (const window of saved.windows) {
              const live = new Set(
                window.sessions.filter((agent) => !agent.exited).map((agent) => agent.id),
              );
              const fromDisk = window.layout
                ? yield* Effect.result(decodeLayout(window.layout)).pipe(
                    Effect.map((result) =>
                      Result.match(result, {
                        onSuccess: (decoded) =>
                          Option.some(prune(decoded, (agent) => live.has(agent))),
                        onFailure: () => Option.none<Layout>(),
                      }),
                    ),
                  )
                : Option.none<Layout>();
              let layout = Option.match(
                Option.filter(fromDisk, (candidate) => candidate.root != null),
                {
                  onSome: (candidate) => candidate,
                  onNone: () => {
                    if (live.size > 0) {
                      const panes = window.sessions
                        .filter((agent) => !agent.exited)
                        .map((agent) => ({
                          id: paneId(),
                          content: paneContentFor(agent),
                        }));
                      return presetLayout(panes, "tiled", panes[0]?.id);
                    }
                    return Option.getOrElse(fromDisk, () => makeLayout({ root: null }));
                  },
                },
              );
              for (const pane of layoutRefs(layout)) {
                const counter = paneCounter(pane.id);
                if (counter !== null) livePaneCounters.push(counter);
              }
              // A live agent the layout does not reference would restore as a
              // roster entry no pane shows — supervised but invisible, a snapshot
              // parseWorkspace then refuses. The model has no detached backend
              // state, so the agent is pruned rather than given a viewport. An
              // exited agent stays: it is the restart target its panes left.
              const placed = new Set(layoutSessions(layout));
              const roster = window.sessions.filter(
                (agent) => agent.exited || placed.has(agent.id),
              );
              if (!layout.focus)
                layout = makeLayout({
                  ...layout,
                  focus: layoutRefs(layout)[0]?.id,
                });
              const state = windowState();
              state.focus = layout.focus ?? null;
              windows.push({
                number: window.number,
                name: window.name,
                sessions: structuredClone(roster),
                layout,
                state,
              });
            }
            const numbers = windows.map((window) => window.number);
            const base = spaceState();
            const activeWindow = numbers.includes(saved.activeWindow ?? -1)
              ? saved.activeWindow
              : (numbers[0] ?? null);
            return {
              id: saved.id,
              name: saved.name,
              dir: saved.dir,
              windows,
              worktree: saved.worktree,
              state: {
                ...base,
                activeWindow,
                nextWindow: Math.max(
                  saved.nextWindow ?? 1,
                  ...numbers.map((number) => number + 1),
                  1,
                ),
                nextPane: Math.max(saved.nextPane ?? 1, ...livePaneCounters.map((c) => c + 1), 1),
              },
            };
          }),
        ),
      ),
    };
  });
}

/** Serialize only durable model fields. Transient WindowState stays daemon-live. */
export const workspaceSession = Effect.fnUntraced(function* (
  workspace: WorkspaceSnapshot,
  base: SessionState,
) {
  return {
    ...base,
    version: SESSION_VERSION,
    updatedAt: yield* Clock.currentTimeMillis,
    activeSpace: workspace.state.activeSpace,
    nextSpace: workspace.state.nextSpace,
    spaces: workspace.spaces.map((space) => ({
      id: space.id,
      name: space.name,
      dir: space.dir,
      activeWindow: space.state.activeWindow,
      nextWindow: space.state.nextWindow,
      nextPane: space.state.nextPane,
      worktree: space.worktree,
      windows: space.windows.map((window) => ({
        number: window.number,
        name: window.name,
        sessions: structuredClone(window.sessions),
        layout: encodeLayout(window.layout),
      })),
    })),
  } satisfies SessionState;
});

/** Parse a subscribed model before a client projects it. */
export function parseWorkspace(
  value: unknown,
): Effect.Effect<WorkspaceSnapshot, WorkspaceParseError | SessionStateError> {
  return Effect.gen(function* () {
    const decoded = yield* S.decodeUnknownEffect(WorkspaceSnapshotSchema)(value).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceParseError({
            message: `workspace does not match schema: ${error.message}`,
          }),
      ),
    );
    const raw = structuredClone(decoded) as WorkspaceSnapshot;
    yield* parseSessionState(
      yield* workspaceSession(raw, {
        version: SESSION_VERSION,
        id: "workspace",
        createdAt: 0,
        updatedAt: 0,
        attached: false,
        spaces: [],
      }),
    );
    const spaceIds = new Set(raw.spaces.map((space) => space.id));
    if (raw.state.activeSpace !== null && !spaceIds.has(raw.state.activeSpace)) {
      return yield* new WorkspaceParseError({
        message: "workspace active space does not exist",
      });
    }
    const spaceCounters = raw.spaces.map((space) => spaceCounter(space.id) ?? 0);
    if (raw.state.nextSpace <= Math.max(0, ...spaceCounters)) {
      return yield* new WorkspaceParseError({
        message: "workspace space counter would reuse a closed space id",
      });
    }
    for (const space of raw.spaces) {
      const numbers = new Set(space.windows.map((window) => window.number));
      if (
        (space.state.activeWindow !== null && !numbers.has(space.state.activeWindow)) ||
        (space.state.lastWindow !== null && !numbers.has(space.state.lastWindow)) ||
        space.state.nextWindow <= Math.max(0, ...numbers)
      ) {
        return yield* new WorkspaceParseError({
          message: "workspace space state names an invalid window",
        });
      }
      for (const window of space.windows) {
        window.layout = yield* decodeLayout(encodeLayout(window.layout)).pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceParseError({
                message: `workspace has an invalid layout: ${error.message}`,
              }),
          ),
        );
        const paneIds = new Set(layoutRefs(window.layout).map((pane) => pane.id));
        if (
          window.state.focus !== (window.layout.focus ?? null) ||
          (window.state.last !== null && !paneIds.has(window.state.last))
        ) {
          return yield* new WorkspaceParseError({
            message: "workspace window state names an invalid pane",
          });
        }
        for (const pane of paneIds) {
          const counter = paneCounter(pane);
          if (counter !== null && space.state.nextPane <= counter) {
            return yield* new WorkspaceParseError({
              message: "workspace pane counter would reuse a closed pane id",
            });
          }
        }
        if (window.state.zoom !== null) {
          if (typeof window.state.zoom.pane !== "string" || !paneIds.has(window.state.zoom.pane)) {
            return yield* new WorkspaceParseError({
              message: "workspace zoom names an invalid pane",
            });
          }
          const from = yield* decodeLayout(encodeLayout(window.state.zoom.from as Layout)).pipe(
            Effect.mapError(
              (error) =>
                new WorkspaceParseError({
                  message: `workspace zoom has an invalid layout: ${error.message}`,
                }),
            ),
          );
          const agents = new Set(
            window.sessions.filter((agent) => !agent.exited).map((agent) => agent.id),
          );
          if (
            layoutRefs(from).some((pane) => {
              const session = paneSession(pane.content);
              return session !== undefined && !agents.has(session);
            })
          ) {
            return yield* new WorkspaceParseError({
              message: "workspace zoom layout names an invalid agent",
            });
          }
          window.state.zoom.from = from;
        }
      }
    }
    const referenceError = checkWorkspaceReferences(raw);
    if (referenceError) return yield* referenceError;
    return raw;
  });
}

/** Validate the pane↔session edge, the model's only non-tree relationship.
 *
 * A window owns two sibling collections — sessions and a layout of panes —
 * joined by the pane's session id (viewport) and optional `displaced`
 * (keepalive for a replace-in-place open). Schema decodes structure, not
 * references, so this pass asserts every retained id is a live session the
 * window owns, and every live session is retained by at least one pane. The
 * one legal unreferenced session is an exited one: it keeps its record as a
 * restart target after its viewport is pruned.
 */
function checkWorkspaceReferences(workspace: WorkspaceSnapshot): WorkspaceParseError | null {
  for (const { window } of workspaceWindows(workspace)) {
    const referenced = new Set<string>();
    for (const pane of layoutRefs(window.layout)) {
      for (const session of paneRetainedSessions(pane.content)) {
        referenced.add(session);
        const owned = window.sessions.find((item) => item.id === session);
        if (!owned)
          return new WorkspaceParseError({
            message: `workspace pane '${pane.id}' references session '${session}', which this window does not own`,
          });
        if (owned.exited)
          return new WorkspaceParseError({
            message: `workspace pane '${pane.id}' references session '${session}', which has already exited`,
          });
      }
    }
    for (const session of window.sessions) {
      if (!session.exited && !referenced.has(session.id))
        return new WorkspaceParseError({
          message: `workspace session '${session.id}' is live but no pane retains it`,
        });
    }
  }
  return null;
}

export function parseWorkspaceCommandContext(
  value: unknown,
  workspace?: WorkspaceSnapshot,
): Effect.Effect<WorkspaceCommandContext, WorkspaceParseError> {
  return Effect.gen(function* () {
    const decoded = yield* S.decodeUnknownEffect(WorkspaceCommandContextSchema)(value).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceParseError({
            message: `invalid workspace command context: ${error.message}`,
          }),
      ),
    );
    const blocked = decoded.blockedAgents ?? [];
    if (new Set(blocked).size !== blocked.length) {
      return yield* new WorkspaceParseError({
        message: "invalid blocked agent ids",
      });
    }
    if (workspace) {
      const agents = workspaceSessionIds(workspace);
      if (blocked.some((id: string) => !agents.has(id)))
        return yield* new WorkspaceParseError({
          message: "blocked agent does not exist",
        });
    }
    return structuredClone(decoded) as WorkspaceCommandContext;
  });
}

/**
 * Apply one existing command value to a private candidate generation.
 *
 * Core tags run the switch below; anything else is a daemon-plugin command
 * and runs the reducer the plugin registered for its tag, against the same
 * draft and the same post-reduce fixups. An unregistered tag reduces to a
 * no-op mutation (the daemon refuses it before it ever gets here).
 */
export function applyWorkspaceCommand(
  current: WorkspaceSnapshot,
  command: Command | RuntimeCommand,
  context: WorkspaceCommandContext,
  plugins?: { readonly reducers: ReadonlyMap<string, PluginWorkspaceReducer> },
  algorithm: TilingAlgorithm = defaultTilingAlgorithm,
): WorkspaceMutation {
  const next = structuredClone(current);
  const agentIds = workspaceSessionIds(next);
  const newAgentId = () => allocateId("agent", agentIds);
  // Readable hierarchical handles: a space is `s3`, a pane is `s3:p7`. The
  // counters live in the model's state so a closed id is never reissued, and a
  // pane carries the space it belongs to, so moving it to another space must
  // mint a new id (the move reports the old one — see pane.move).
  const newSpaceId = () => {
    const id = `s${next.state.nextSpace}`;
    next.state = { ...next.state, nextSpace: next.state.nextSpace + 1 };
    return id;
  };
  const newPaneId = (space: WorkspaceSpace) => {
    const [state, counter] = claimPaneNumber(space.state);
    space.state = state;
    return `${space.id}:p${counter}`;
  };
  const actions: WorkspaceAction[] = [];
  let result: JsonValue | undefined;
  const before = JSON.stringify(next);
  const space = () =>
    findSpace(
      next,
      "space" in command && typeof command.space === "string" ? command.space : undefined,
    );
  const window = () => findWindow(next, command as { space?: string; window?: number });
  const activeWindow = () =>
    context.agent
      ? ([...workspaceWindows(next)].find((entry) =>
          entry.window.sessions.some((agent) => agent.id === context.agent),
        ) ?? null)
      : findWindow(next, {});
  /** The pane the caller runs in: its session (the stable identity, which
   *  survives a pane move) first, then the pane id its env named (which may be
   *  stale if the pane moved). */
  const callingPane = (): { window: WindowEntry; pane: PaneRef } | null => {
    if (context.agent) {
      for (const entry of workspaceWindows(next)) {
        const pane = layoutRefs(entry.window.layout).find(
          (item) => paneSession(item.content) === context.agent,
        );
        if (pane) return { window: entry, pane };
      }
    }
    if (context.pane) {
      for (const entry of workspaceWindows(next)) {
        const pane = layoutRefs(entry.window.layout).find((item) => item.id === context.pane);
        if (pane) return { window: entry, pane };
      }
    }
    return null;
  };
  /** Where a pane command acts: a named pane, the caller's own pane, or the
   *  focused pane of the active window. Absent both targets, the command keeps
   *  today's meaning — the focused pane — so a keybinding and the UI mean the
   *  same thing. */
  const paneTarget = (): { window: WindowEntry; pane: PaneRef } | null => {
    const named = "pane" in command && typeof command.pane === "string" && command.pane !== "";
    if (named) {
      for (const entry of workspaceWindows(next)) {
        const pane = layoutRefs(entry.window.layout).find((item) => item.id === command.pane);
        if (pane) return { window: entry, pane };
      }
      return null;
    }
    if ("current" in command && command.current === true) return callingPane();
    const target = activeWindow();
    if (!target) return null;
    const pane = layoutRefs(target.window.layout).find(
      (item) => item.id === target.window.state.focus,
    );
    return pane ? { window: target, pane } : null;
  };
  /** Where a read whose name is "current" acts: the caller's own pane, else the
   *  focused pane. Reads are the way an agent resolves itself, so "current"
   *  means the caller rather than whoever has the human's focus. */
  const readTarget = (): { window: WindowEntry; pane: PaneRef } | null => {
    const named = "pane" in command && typeof command.pane === "string" && command.pane !== "";
    if (named) {
      for (const entry of workspaceWindows(next)) {
        const pane = layoutRefs(entry.window.layout).find((item) => item.id === command.pane);
        if (pane) return { window: entry, pane };
      }
      return null;
    }
    return (
      callingPane() ??
      (() => {
        const target = activeWindow();
        if (!target) return null;
        const pane = layoutRefs(target.window.layout).find(
          (item) => item.id === target.window.state.focus,
        );
        return pane ? { window: target, pane } : null;
      })()
    );
  };
  const setFocus = (target: WorkspaceWindow, id: string | undefined) => {
    if (!id) return;
    if (target.state.focus !== id) {
      target.state.zoom = target.state.zoom?.pane === id ? target.state.zoom : null;
      target.state.last = target.state.focus;
      target.state.focus = id;
      target.layout = makeLayout({ ...target.layout, focus: id });
    }
    // Viewport algorithms (niri) keep a scroll offset the focus move must
    // update — see TilingAlgorithm.ensureVisible. Split-tree algorithms omit
    // it and this is a no-op.
    const shown = algorithm.ensureVisible?.(target.layout, context.size, id);
    if (shown && shown !== target.layout) target.layout = shown;
  };
  /** Focus a session's viewport, restore into its displace-host, or place a new pane. */
  const revealSession = (target: SessionEntry): void => {
    const pane = layoutRefs(target.window.layout).find(
      (candidate) => paneSession(candidate.content) === target.session.id,
    );
    if (pane) {
      setFocus(target.window, pane.id);
      return;
    }
    const holder = layoutRefs(target.window.layout).find(
      (candidate) =>
        candidate.content.kind === "plugin" && candidate.content.displaced === target.session.id,
    );
    if (holder) {
      target.window.layout = setPaneContent(
        target.window.layout,
        holder.id,
        paneContentFor(target.session),
      );
      setFocus(target.window, holder.id);
      return;
    }
    const placed = { id: newPaneId(target.space), content: paneContentFor(target.session) };
    target.window.layout = target.window.layout.root
      ? splitLayout(target.window.layout, 0, "row", placed)
      : appendPane(target.window.layout, placed);
    target.window.state.focus = placed.id;
  };
  const addSession = (
    target: WorkspaceWindow,
    dir: string,
    opts?: {
      readonly provider?: string;
      readonly cmd?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly name?: string;
      readonly transient?: boolean;
      readonly id?: string;
    },
  ): PersistedSession => {
    const component = opts?.provider !== undefined;
    const shellCmd = opts?.cmd ?? context.shell;
    const id =
      opts?.id !== undefined && opts.id.length > 0 && !agentIds.has(opts.id)
        ? opts.id
        : newAgentId();
    agentIds.add(id);
    const agent = {
      id,
      name: opts?.name ?? (component ? `${opts.provider}-agent` : commandName(shellCmd)),
      cwd: dir,
      // Both axes: the worker's content is frames a component draws, and it is
      // an agent. A shell pane is neither, even when the user starts an agent
      // in it — that one is detected from its foreground process instead.
      cols: Math.max(1, context.size.cols),
      rows: Math.max(1, context.size.rows),
      exited: false,
      exitCode: null,
    };
    if (!component) Object.assign(agent, { cmd: [...shellCmd] });
    if (opts?.env !== undefined && Object.keys(opts.env).length > 0) {
      Object.assign(agent, { env: { ...opts.env } });
    }
    if (opts?.transient === true) Object.assign(agent, { transient: true });
    if (component) {
      Object.assign(agent, {
        kind: "component" as const,
        provider: opts.provider,
        // The spawning plugin names its own worker unambiguously — the
        // highest-authority identity source presence.ts arbitrates over.
        declaredAgent: opts.provider,
      });
    }
    target.sessions.push(agent);
    actions.push({ _tag: "spawn", agent });
    return agent;
  };
  const placeSessionPane = (
    entry: WindowEntry,
    agent: PersistedSession,
    opts?: { readonly mode?: "split" | "replace" },
  ): string => {
    const content = paneContentFor(agent);
    if (opts?.mode === "replace") {
      const target = callingPane() ?? paneTarget();
      if (target && target.window.window === entry.window) {
        return replacePaneContent(target, content);
      }
    }
    const pane = { id: newPaneId(entry.space), content };
    entry.window.layout = entry.window.layout.root
      ? splitLayout(entry.window.layout, 0, "row", pane)
      : appendPane(entry.window.layout, pane);
    entry.window.state.focus = pane.id;
    return pane.id;
  };
  const replacePaneContent = (
    target: { window: WindowEntry; pane: PaneRef },
    content: PaneContent,
  ): string => {
    const { window, space } = target.window;
    const previous = target.pane.content;
    // Depth-1 keepalive: the original shell stays displaced across chained
    // replaces. Prefer an existing displaced id; otherwise keep the session
    // this leaf was viewing. The session that drops out of retention is
    // reaped below — otherwise it stays live with no pane and the next
    // attach fails the workspace invariant (same trap as pane.close).
    const displaced =
      (previous.kind === "plugin" ? previous.displaced : undefined) ?? paneSession(previous);
    const nextContent: PaneContent =
      content.kind === "plugin"
        ? displaced !== undefined
          ? { ...content, displaced }
          : content
        : content;
    window.layout = setPaneContent(window.layout, target.pane.id, nextContent);
    window.state.focus = target.pane.id;
    window.state.zoom = null;
    window.state.preset = null;
    afterPaneRemoved(next, space, window, actions);
    return target.pane.id;
  };
  const placePluginPane = (
    type: string,
    descriptor: JsonValue,
    opts?: { readonly mode?: "split" | "replace" },
  ): string | null => {
    if (opts?.mode === "replace") {
      const target = callingPane() ?? paneTarget();
      if (!target) return null;
      return replacePaneContent(target, {
        kind: "plugin",
        type,
        descriptor,
      });
    }
    const target = paneTarget();
    if (!target) return null;
    const { space, window } = target.window;
    const panes = layoutPanes(window.layout.root);
    const at = panes.findIndex((pane) => pane.id === target.pane.id);
    const ref = {
      id: newPaneId(space),
      content: { kind: "plugin", type, descriptor } satisfies PaneContent,
    };
    window.layout =
      at === -1
        ? appendPane(window.layout, ref)
        : (algorithm.split?.(window.layout, context.size, target.pane.id, "row", ref) ??
          splitLayout(window.layout, at, "row", ref));
    window.state.focus = ref.id;
    window.state.last = at === -1 ? null : (panes[at]?.id ?? null);
    window.state.zoom = null;
    window.state.preset = null;
    return ref.id;
  };
  const draft: WorkspaceDraft = {
    activeWindow: () => activeWindow(),
    findSession: (id) => findSession(next, id),
    addSession,
    placeSessionPane,
    placePluginPane,
    pushAction: (action) => void actions.push(action),
    setResult: (value) => {
      result = value;
    },
    listAgents: () => agentEntries(next),
    getAgent: (id) => {
      const found = findSession(next, id);
      return found ? agentEntry(found.space, found.window, found.session) : null;
    },
  };
  const addWindow = (target: WorkspaceSpace): WorkspaceWindow => {
    let number: number;
    [target.state, number] = claimWindowNumber(target.state);
    const created: WorkspaceWindow = {
      number,
      name: null,
      sessions: [],
      layout: makeLayout({ root: null }),
      state: windowState(),
    };
    target.windows.push(created);
    target.state = selectWindowState(
      target.state,
      target.windows.map((item) => item.number),
      number,
    );
    const agent = addSession(created, target.dir);
    const pane = newPaneId(target);
    created.layout = makeLayout({
      root: { type: "pane", id: pane, content: paneContentFor(agent), weight: 1 },
      focus: pane,
    });
    created.state.focus = pane;
    return created;
  };
  const splitAtTarget = (
    axis: "row" | "column",
    agent: PersistedSession,
    target: { window: WindowEntry; pane: PaneRef },
  ): string => {
    const { space, window } = target.window;
    const panes = layoutPanes(window.layout.root);
    const at = panes.findIndex((pane) => pane.id === target.pane.id);
    const ref = { id: newPaneId(space), content: paneContentFor(agent) };
    window.layout =
      at === -1
        ? appendPane(window.layout, ref)
        : (algorithm.split?.(window.layout, context.size, target.pane.id, axis, ref) ??
          splitLayout(window.layout, at, axis, ref));
    window.state.focus = ref.id;
    window.state.last = at === -1 ? null : (panes[at]?.id ?? null);
    window.state.zoom = null;
    window.state.preset = null;
    return ref.id;
  };
  if (!isCoreCommand(command)) {
    plugins?.reducers.get(command._tag)?.(draft, command, context);
    return finish();
  }
  switch (command._tag) {
    case "pane.split": {
      const target = paneTarget();
      if (!target) break;
      // A split inherits the caller's directory, not the space's: an agent
      // delegating from a worktree pane must not land the sibling in the repo
      // root. The flag overrides that default.
      const agent = addSession(
        target.window.window,
        resolve(context.cwd, command.cwd?.trim() || "."),
      );
      result = {
        session: agent.id,
        pane: splitAtTarget(command.axis, agent, target),
      } satisfies CreationResult<"pane.split">;
      break;
    }
    case "pane.open-plugin": {
      const pane = draft.placePluginPane(command.type, command.descriptor);
      if (pane !== null) result = { pane } satisfies CreationResult<"pane.open-plugin">;
      break;
    }
    case "process-plugin.pane.open": {
      const target = paneTarget();
      if (!target) break;
      // Daemon must resolve argv/env before apply; an unresolved open is a no-op.
      if (command.command === undefined || command.command.length === 0) break;
      const agent = addSession(target.window.window, resolve(context.cwd, command.cwd?.trim() || "."), {
        cmd: command.command,
        ...(command.env !== undefined ? { env: command.env } : {}),
        ...(command.title !== undefined ? { name: command.title } : {}),
        ...(command.transient === true ? { transient: true } : {}),
      });
      const paneId = splitAtTarget(command.axis ?? "row", agent, target);
      const placement = command.placement ?? "tiled";
      // Amux Placement only — floating uses setPlacement; docks use setDock.
      // Not herdr overlay/popup/tab (ep-4d545c).
      if (placement === "floating") {
        target.window.window.layout = setPlacement(
          target.window.window.layout,
          paneId,
          "floating",
        );
      } else if (placement !== "tiled") {
        target.window.window.layout = setDock(target.window.window.layout, paneId, placement);
      }
      target.window.window.state.focus = paneId;
      result = {
        session: agent.id,
        pane: paneId,
      } satisfies CreationResult<"process-plugin.pane.open">;
      break;
    }
    case "pane.next": {
      const target = activeWindow();
      if (!target) break;
      // Every placed pane, floats included. Cycling is how a float is reached
      // and left at all: directional focus stays inside the tiled plane,
      // because a float shares no edge with what it covers.
      const panes = layoutRefs(target.window.layout);
      const at = panes.findIndex((pane) => pane.id === target.window.state.focus);
      setFocus(target.window, panes[(at + 1 + panes.length) % panes.length]?.id);
      break;
    }
    case "pane.last": {
      const target = activeWindow();
      if (target) setFocus(target.window, target.window.state.last ?? undefined);
      break;
    }
    case "pane.focus": {
      const target = activeWindow();
      if (!target) break;
      const { window } = target;
      const focus = window.state.focus;
      if (!focus) break;
      // A float covers the tiled plane, so there is no pane to focus across a
      // shared edge from one — the arrows move it instead, which is why the
      // gesture is called a move mode. Directional focus stays tiled.
      if (placementOf(window.layout, focus) === "floating") {
        const moved = moveFloat(window.layout, context.size, focus, command.direction);
        if (moved !== window.layout) window.layout = moved;
        break;
      }
      setFocus(
        window,
        algorithm.focusInDirection(window.layout, context.size, focus, command.direction) ??
          undefined,
      );
      break;
    }
    case "pane.select": {
      const target = activeWindow()?.window;
      if (target && layoutRefs(target.layout).some((pane) => pane.id === command.pane)) {
        setFocus(target, command.pane);
      }
      break;
    }
    case "pane.set-descriptor": {
      const target = paneTarget();
      if (!target) break;
      const window = target.window.window;
      const next = setPaneDescriptor(window.layout, target.pane.id, command.descriptor);
      // A descriptor change only rewrites content; placement and focus hold.
      window.layout = next;
      break;
    }
    case "pane.resize": {
      const target = paneTarget();
      if (!target || target.window.window.state.zoom) break;
      const layout = target.window.window.layout;
      const resized =
        algorithm.resizeFocus?.(layout, context.size, target.pane.id, command.direction, 1) ??
        resizePane(layout, context.size, target.pane.id, command.direction);
      if (resized !== layout) {
        target.window.window.layout = resized;
        // A float is placed by its own rectangle, not by the tree, so resizing
        // one leaves the tiled arrangement — and the preset describing it —
        // intact.
        if (placementOf(layout, target.pane.id) !== "floating") {
          target.window.window.state.preset = null;
        }
      }
      break;
    }
    case "pane.resize-divider": {
      const target = activeWindow()?.window;
      if (!target || target.state.zoom) break;
      const resized =
        algorithm.resizeDivider?.(
          target.layout,
          context.size,
          command.path,
          command.index,
          command.delta,
        ) ?? resizeDivider(target.layout, context.size, command.path, command.index, command.delta);
      if (resized !== target.layout) {
        target.layout = resized;
        target.state.preset = null;
      }
      break;
    }
    case "pane.set-size": {
      const target = paneTarget();
      if (!target || target.window.window.state.zoom) break;
      const layout = target.window.window.layout;
      const cells = command.cells === undefined ? null : command.cells;
      const resized = setPaneSize(layout, context.size, target.pane.id, command.axis, cells);
      if (resized !== layout) {
        target.window.window.layout = resized;
        if (placementOf(layout, target.pane.id) !== "floating") {
          target.window.window.state.preset = null;
        }
      }
      break;
    }
    case "pane.zoom": {
      const target = paneTarget();
      if (!target || layoutRefs(target.window.window.layout).length < 2) break;
      const pane = target.pane.id;
      target.window.window.state.zoom = target.window.window.state.zoom
        ? null
        : { pane, from: target.window.window.layout };
      break;
    }
    case "pane.float": {
      const target = paneTarget();
      if (!target) break;
      const window = target.window.window;
      const placement = placementOf(window.layout, target.pane.id);
      if (!placement) break;
      window.layout = setPlacement(
        window.layout,
        target.pane.id,
        placement === "floating" ? "tiled" : "floating",
      );
      // A float is outside the tiled arrangement, so putting one in or taking
      // one out changes which panes the preset describes — and a zoom is a
      // capture of an arrangement that no longer holds.
      window.state.zoom = null;
      window.state.preset = null;
      break;
    }
    case "pane.dock-left":
    case "pane.dock-right":
    case "pane.dock-top":
    case "pane.dock-bottom": {
      const target = paneTarget();
      if (!target) break;
      const side = command._tag.slice("pane.dock-".length) as "left" | "right" | "top" | "bottom";
      target.window.window.layout = setDock(target.window.window.layout, target.pane.id, side);
      target.window.window.state.zoom = null;
      target.window.window.state.preset = null;
      break;
    }
    case "pane.undock": {
      const target = paneTarget();
      if (!target) break;
      target.window.window.layout = undockPane(target.window.window.layout, target.pane.id);
      target.window.window.state.zoom = null;
      target.window.window.state.preset = null;
      break;
    }
    case "pane.swap": {
      const target = paneTarget();
      if (!target) break;
      const window = target.window.window;
      const panes = layoutPanes(window.layout.root);
      const at = panes.findIndex((pane) => pane.id === target.pane.id);
      if (at !== -1 && panes.length > 1) {
        const step = command.to === "next" ? 1 : -1;
        window.layout =
          algorithm.swap?.(window.layout, context.size, target.pane.id, step) ??
          swapLayout(window.layout, at, (at + step + panes.length) % panes.length);
        window.state.zoom = null;
      }
      break;
    }
    case "pane.close": {
      const found = paneTarget();
      if (!found) break;
      // Restoring a displace-keepalive puts the previous session back in the
      // leaf. The plugin/component that was the viewport is then unreferenced
      // and must go through afterPaneRemoved — otherwise it stays live with
      // no pane and the next attach fails the workspace invariant.
      if (restoreDisplacedContent(found.window.window, found.pane)) {
        afterPaneRemoved(next, found.window.space, found.window.window, actions);
        break;
      }
      closePane(found.window.window, found.pane.id, context.size, algorithm);
      afterPaneRemoved(next, found.window.space, found.window.window, actions);
      break;
    }
    case "workspace.rebuild-tiling": {
      const targets =
        command.window === undefined
          ? [...workspaceWindows(next)].filter(
              ({ space }) => command.space === undefined || space.id === command.space,
            )
          : (() => {
              const target = findWindow(next, command);
              return target ? [target] : [];
            })();
      for (const { window } of targets) {
        const rebuilt = algorithm.init(layoutPanes(window.layout.root), context.size);
        window.layout = makeLayout({
          ...rebuilt,
          floats: window.layout.floats,
          docks: window.layout.docks,
          dockSizes: window.layout.dockSizes,
          focus: window.state.focus ?? rebuilt.focus,
        });
        window.state.zoom = null;
        window.state.preset = null;
      }
      break;
    }
    case "pane.break": {
      const found = paneTarget();
      if (!found) break;
      const { space, window } = found.window;
      const slot = found.pane;
      const session = paneSession(slot.content);
      const agent = session ? window.sessions.find((item) => item.id === session) : undefined;
      if (!agent) break;
      takeSession(window, agent.id, context.size, algorithm);
      let number: number;
      [space.state, number] = claimWindowNumber(space.state);
      const created: WorkspaceWindow = {
        number,
        name: null,
        sessions: [agent],
        // Tiled in its new window whichever plane it was in here: a break makes
        // the pane the whole window, and a float filling a window is a tile.
        layout: makeLayout({
          root: { type: "pane", ...slot, weight: 1 },
          focus: slot.id,
        }),
        state: { ...windowState(), focus: slot.id },
      };
      space.windows.push(created);
      space.state = selectWindowState(
        space.state,
        space.windows.map((item) => item.number),
        number,
      );
      afterPaneRemoved(next, space, window, actions);
      break;
    }
    case "pane.join": {
      const destination = paneTarget()?.window;
      if (!destination) break;
      const sourceNumber =
        command.source ??
        destination.space.state.lastWindow ??
        destination.space.windows.find((window) => window !== destination.window)?.number;
      const source = findWindow(next, {
        space: destination.space.id,
        window: sourceNumber,
      });
      if (!source || source.window === destination.window) break;
      const paneId = source.window.state.focus;
      const slot = layoutRefs(source.window.layout).find((item) => item.id === paneId);
      if (!slot) break;
      const session = paneSession(slot.content);
      const agent = session
        ? source.window.sessions.find((item) => item.id === session)
        : undefined;
      if (!agent) break;

      takeSession(source.window, agent.id, context.size, algorithm);
      destination.window.layout = appendPane(destination.window.layout, slot);
      destination.window.sessions.push(agent);
      destination.window.state.focus = slot.id;
      destination.window.state.last = null;
      destination.window.state.zoom = null;
      afterPaneRemoved(next, source.space, source.window, actions);
      break;
    }
    case "pane.move": {
      const source = paneTarget();
      const destination = findSpace(next, command.space);
      const target = destination?.windows.find(
        (window) => window.number === destination.state.activeWindow,
      );
      if (!source || !destination || !target || destination === source.window.space) break;
      const slot = source.pane;
      const session = paneSession(slot.content);
      const agent = session
        ? source.window.window.sessions.find((item) => item.id === session)
        : undefined;
      if (!agent) break;

      // A pane id is space-qualified, so crossing spaces re-qualifies it. The
      // caller must be told — its handle no longer names the pane — and the old
      // id lets it re-anchor deterministically.
      const previousPaneId = slot.id;
      takeSession(source.window.window, agent.id, context.size, algorithm);
      const moved = { ...slot, id: newPaneId(destination) };
      target.layout = appendPane(target.layout, moved);
      target.sessions.push(agent);
      target.state.focus = moved.id;
      target.state.last = null;
      target.state.zoom = null;
      afterPaneRemoved(next, source.window.space, source.window.window, actions);
      destination.state = selectWindowState(
        destination.state,
        destination.windows.map((window) => window.number),
        target.number,
      );
      next.state = activateSpaceState(
        next.state,
        next.spaces.map((space) => space.id),
        destination.id,
      );
      result = { pane: moved.id, previous_pane_id: previousPaneId } satisfies PaneMoveResult;
      break;
    }
    case "window.new": {
      const target = space();
      if (target) {
        const created = addWindow(target);
        const pane = layoutRefs(created.layout)[0]!;
        result = {
          window: created.number,
          pane: pane.id,
          session: paneSession(pane.content) ?? "",
        } satisfies CreationResult<"window.new">;
      }
      break;
    }
    case "window.next":
    case "window.previous": {
      const target = space();
      if (!target || target.windows.length < 2) break;
      const at = target.windows.findIndex((item) => item.number === target.state.activeWindow);
      const step = command._tag === "window.next" ? 1 : -1;
      target.state = selectWindowState(
        target.state,
        target.windows.map((item) => item.number),
        target.windows[(at + step + target.windows.length) % target.windows.length]!.number,
      );
      break;
    }
    case "window.last": {
      const target = space();
      if (target && target.state.lastWindow !== null) {
        target.state = selectWindowState(
          target.state,
          target.windows.map((item) => item.number),
          target.state.lastWindow,
        );
      }
      break;
    }
    case "window.select": {
      const target = space();
      if (target)
        target.state = selectWindowState(
          target.state,
          target.windows.map((item) => item.number),
          command.number,
        );
      break;
    }
    case "window.rename": {
      const target = window();
      if (target) target.window.name = command.name.trim() || null;
      break;
    }
    case "window.close": {
      const target = window();
      if (target) removeWindow(next, target.space, target.window, actions);
      break;
    }
    case "window.next-layout":
    case "window.select-layout": {
      const target = activeWindow()?.window;
      if (!target) break;
      const preset =
        command._tag === "window.next-layout" ? nextPreset(target.state.preset) : command.preset;
      // A preset rearranges the tiled plane; the floats stay where they are,
      // over whatever it becomes.
      target.layout = makeLayout({
        ...presetLayout(layoutPanes(target.layout.root), preset, target.state.focus ?? undefined),
        floats: target.layout.floats,
        focus: target.state.focus ?? undefined,
      });
      target.state.zoom = null;
      target.state.preset = preset;
      break;
    }
    case "window.synchronize-panes": {
      const target = activeWindow()?.window;
      if (target) target.state.sync = !target.state.sync;
      break;
    }
    case "session.kill": {
      const target = findSession(next, command.target);
      if (!target) break;
      actions.push({ _tag: "kill", agent: target.session.id });
      target.window.sessions = target.window.sessions.filter(
        (session) => session.id !== target.session.id,
      );
      target.window.layout = prune(
        target.window.layout,
        (session) => session !== target.session.id,
      );
      target.window.state.focus = target.window.layout.focus ?? null;
      afterPaneRemoved(next, target.space, target.window, actions);
      break;
    }
    case "session.restart": {
      const target = findSession(next, command.target);
      if (!target || !target.session.exited) break;
      target.session.exited = false;
      target.session.exitCode = null;
      target.session.kind ??= "pty";
      if (
        !layoutRefs(target.window.layout).some(
          (pane) => paneSession(pane.content) === target.session.id,
        )
      ) {
        const pane = { id: newPaneId(target.space), content: paneContentFor(target.session) };
        target.window.layout = target.window.layout.root
          ? splitLayout(target.window.layout, 0, "row", pane)
          : appendPane(target.window.layout, pane);
        target.window.state.focus = pane.id;
      }
      actions.push({ _tag: "spawn", agent: structuredClone(target.session) });
      break;
    }
    case "session.reveal": {
      const target = findSession(next, command.target);
      if (!target || target.session.exited) break;
      next.state = activateSpaceState(
        next.state,
        next.spaces.map((space) => space.id),
        target.space.id,
      );
      target.space.state = selectWindowState(
        target.space.state,
        target.space.windows.map((window) => window.number),
        target.window.number,
      );
      revealSession(target);
      // Revealing into a replace-host drops that host's viewport session from
      // the layout the same way pane.close's restore path does.
      afterPaneRemoved(next, target.space, target.window, actions);
      break;
    }
    case "session.next-blocked": {
      const blocked = context.blockedAgents ?? [];
      const focused = activeWindow()?.window.state.focus;
      const currentAgent = next.spaces
        .flatMap((item) => item.windows)
        .flatMap((item) => layoutRefs(item.layout))
        .find((pane) => pane.id === focused);
      const currentId = currentAgent ? paneSession(currentAgent.content) : undefined;
      const at = currentId ? blocked.indexOf(currentId) : -1;
      const id = blocked[(at + 1 + blocked.length) % blocked.length];
      const target = id ? findSession(next, id) : null;
      if (target) {
        next.state = activateSpaceState(
          next.state,
          next.spaces.map((item) => item.id),
          target.space.id,
        );
        target.space.state = selectWindowState(
          target.space.state,
          target.space.windows.map((item) => item.number),
          target.window.number,
        );
        const pane = layoutRefs(target.window.layout).find(
          (item) => paneSession(item.content) === id,
        );
        if (pane) setFocus(target.window, pane.id);
      }
      break;
    }
    case "space.new": {
      const branch = typeof command.branch === "string" ? command.branch.trim() : "";
      const repo = resolve(command.dir?.trim() || space()?.dir || context.cwd);
      const id = newSpaceId();
      const created: WorkspaceSpace = branch
        ? (() => {
            const root = context.worktreesRoot;
            if (!root) throw new Error("worktree space requires a worktreesRoot context");
            const dir = join(root, `${id}-${worktreeDirname(branch)}`);
            return {
              id,
              name: command.name?.trim() || branch,
              dir,
              worktree: { branch, repo, path: dir },
              windows: [],
              state: spaceState(),
            };
          })()
        : {
            id,
            name: command.name?.trim() || basename(repo),
            dir: repo,
            windows: [],
            state: spaceState(),
          };
      next.spaces.push(created);
      next.state = activateSpaceState(
        next.state,
        next.spaces.map((item) => item.id),
        created.id,
      );
      const window = addWindow(created);
      const pane = layoutRefs(window.layout)[0]!;
      result = {
        space: created.id,
        window: window.number,
        pane: pane.id,
        session: paneSession(pane.content) ?? "",
      } satisfies CreationResult<"space.new">;
      break;
    }
    case "space.select": {
      next.state = activateSpaceState(
        next.state,
        next.spaces.map((space) => space.id),
        command.space,
      );
      break;
    }
    case "space.rename": {
      const target = space();
      if (target && command.name.trim()) target.name = command.name.trim();
      break;
    }
    case "space.close": {
      const target = space();
      if (target) removeSpace(next, target, actions);
      break;
    }
    case "space.next":
    case "space.previous": {
      if (next.spaces.length < 2) break;
      const at = next.spaces.findIndex((item) => item.id === next.state.activeSpace);
      const step = command._tag === "space.next" ? 1 : -1;
      next.state = activateSpaceState(
        next.state,
        next.spaces.map((item) => item.id),
        next.spaces[(at + step + next.spaces.length) % next.spaces.length]!.id,
      );
      break;
    }
    // The read surface: pure projections, no actions, no frame, nothing seen.
    case "space.list": {
      result = spaceEntries(next);
      break;
    }
    case "window.list": {
      result = windowEntries(next);
      break;
    }
    case "pane.list": {
      result = paneEntries(next);
      break;
    }
    case "pane.current": {
      const target = readTarget();
      result = target ? paneEntry(target.window.space, target.window.window, target.pane) : null;
      break;
    }
    case "pane.layout": {
      const target = readTarget();
      result = target ? paneLayout(next, target.pane.id, context.size) : null;
      break;
    }
  }

  return finish();

  // The post-reduce fixups both core and plugin commands share: spawn pane
  // resolution, the no-focus restore, normalization, and change detection.
  function finish(): WorkspaceMutation {
    // A spawn names the pane it will show, so the daemon can hand the child its
    // own pane id as the AMUX_PANE_ID env var. Resolved here, after the command
    // placed the pane, because the pane id is a fact about the resulting layout.
    for (const a of actions) {
      if (!isCoreWorkspaceAction(a) || a._tag !== "spawn" || a.pane !== undefined) continue;
      const pane = findPaneBySession(next, a.agent.id);
      if (pane) a.pane = pane.id;
    }

    // A background caller asked for no focus to move. The command's structure
    // stays, but the workspace's view — active space, active window, focused
    // pane, last and zoom — is put back the way it was. Only targets that still
    // exist get their view back: closing the focused pane cannot restore its
    // focus, so the window's own heir focus stands. The id counters are not view
    // state and advance regardless.
    if (context.noFocus) {
      next.state = { ...next.state, activeSpace: current.state.activeSpace };
      for (const space of next.spaces) {
        const prior = current.spaces.find((item) => item.id === space.id);
        if (!prior) continue;
        space.state = {
          ...space.state,
          activeWindow: prior.state.activeWindow,
          lastWindow: prior.state.lastWindow,
        };
        for (const window of space.windows) {
          const priorWindow = prior.windows.find((item) => item.number === window.number);
          if (!priorWindow) continue;
          const priorFocus = priorWindow.state.focus;
          const placed =
            priorFocus !== null && layoutRefs(window.layout).some((pane) => pane.id === priorFocus);
          window.layout = makeLayout({
            ...window.layout,
            focus: placed ? priorFocus : window.layout.focus,
          });
          window.state = {
            ...window.state,
            focus: window.layout.focus ?? null,
            last: priorWindow.state.last,
            zoom: priorWindow.state.zoom,
          };
        }
      }
    }

    for (const { window } of workspaceWindows(next)) normalizeWindowState(window);

    const changed = before !== JSON.stringify(next);
    const mutation = {
      snapshot: changed ? { ...next, revision: current.revision + 1 } : current,
      actions,
      changed,
    };
    return result === undefined ? mutation : { ...mutation, result };
  }
}

/** Natural PTY exit is a daemon-side model mutation too. */
export function markSessionExited(
  current: WorkspaceSnapshot,
  id: string,
  code: number | null,
): WorkspaceSnapshot {
  const next = structuredClone(current);
  const found = findSession(next, id);
  if (!found) return current;
  const restoreLast = found.session.transient === true ? found.window.state.last : null;
  found.session.exited = true;
  found.session.exitCode = code;
  found.window.layout = prune(found.window.layout, (agent) => agent !== id);
  const panes = new Set(layoutRefs(found.window.layout).map((pane) => pane.id));
  if (restoreLast !== null && panes.has(restoreLast)) {
    found.window.layout = makeLayout({ ...found.window.layout, focus: restoreLast });
    found.window.state.focus = restoreLast;
  } else {
    found.window.state.focus = found.window.layout.focus ?? null;
  }
  // Every non-exited agent still holds a pane, so an empty layout means every
  // agent has exited and the window has nothing left to show.
  if (layoutRefs(found.window.layout).length === 0) {
    removeWindow(next, found.space, found.window, []);
  }
  normalizeWindowState(found.window);
  return { ...next, revision: current.revision + 1 };
}

/** Restore failure is not a natural exit: keep the record so its owner can see why it is unavailable. */
export function markSessionUnavailable(
  current: WorkspaceSnapshot,
  id: string,
  reason: string,
): WorkspaceSnapshot {
  const next = structuredClone(current);
  const found = findSession(next, id);
  if (!found) return current;
  found.session.exited = true;
  found.session.exitCode = null;
  found.session.name = `${found.session.name} (unavailable: ${reason})`;
  found.window.layout = prune(found.window.layout, (agent) => agent !== id);
  found.window.state.focus = found.window.layout.focus ?? null;
  return { ...next, revision: current.revision + 1 };
}

function findSpace(workspace: WorkspaceSnapshot, id?: string): WorkspaceSpace | null {
  const wanted = id ?? workspace.state.activeSpace;
  return workspace.spaces.find((space) => space.id === wanted) ?? null;
}

/** The window a bare `{space?, window?}` target names: the given space and
 *  window number, or the active ones when either is omitted. Shared with
 *  callers outside the reducer — the daemon's send-keys resolver, notably —
 *  that need "the active window" read-only, off a snapshot rather than the
 *  reducer's mutable draft. */
export function findWindow(
  workspace: WorkspaceSnapshot,
  target: { space?: string; window?: number },
): WindowEntry | null {
  const space = findSpace(workspace, target.space);
  if (!space) return null;
  const number = target.window ?? space.state.activeWindow;
  const window = space.windows.find((item) => item.number === number);
  return window ? { space, window } : null;
}

function findSession(workspace: WorkspaceSnapshot, id?: string): SessionEntry | null {
  if (!id) {
    const target = findWindow(workspace, {});
    const pane = (target ? layoutRefs(target.window.layout) : []).find(
      (item) => item.id === target?.window.state.focus,
    );
    const session = pane ? paneSession(pane.content) : undefined;
    const found = session ? target?.window.sessions.find((item) => item.id === session) : undefined;
    return target && found ? { ...target, session: found } : null;
  }
  for (const entry of workspaceSessions(workspace)) if (entry.session.id === id) return entry;
  return null;
}

/** The pane a session shows, if the model places it. A session normally has
 *  exactly one pane; when it has several, the first in walk order wins. */
export function findPaneBySession(workspace: WorkspaceSnapshot, id: string): PaneRef | null {
  for (const { window } of workspaceWindows(workspace)) {
    const pane = layoutRefs(window.layout).find((item) => paneSession(item.content) === id);
    if (pane) return pane;
  }
  return null;
}

/** A pane placed anywhere in the workspace, with the window that owns it. */
export function workspacePaneOf(
  workspace: WorkspaceSnapshot,
  paneId: string,
): { space: WorkspaceSpace; window: WorkspaceWindow; pane: PaneRef } | null {
  for (const { space, window } of workspaceWindows(workspace)) {
    const pane = layoutRefs(window.layout).find((item) => item.id === paneId);
    if (pane) return { space, window, pane };
  }
  return null;
}

/**
 * Write a trusted agent conversation ref onto the pane that owns it.
 * Returns null when the pane is missing or the ref is already stored.
 */
export function applyPaneAgentSession(
  workspace: WorkspaceSnapshot,
  paneId: string,
  agentSession: PaneAgentSessionSnapshot | undefined,
): WorkspaceSnapshot | null {
  if (!workspacePaneOf(workspace, paneId)) return null;
  const next = structuredClone(workspace);
  const target = workspacePaneOf(next, paneId);
  if (!target) return null;
  const nextLayout = setPaneAgentSession(target.window.layout, paneId, agentSession);
  if (nextLayout === target.window.layout) return null;
  target.window.layout = nextLayout;
  return { ...next, revision: workspace.revision + 1 };
}

function closePane(
  window: WorkspaceWindow,
  id: string,
  size: LayoutSize,
  algorithm: TilingAlgorithm,
): void {
  const closed = algorithm.close(window.layout, size, id);
  if (closed === window.layout) return;
  window.layout = closed;
  window.state.focus = window.layout.focus ?? null;
  window.state.zoom = null;
  window.state.preset = null;
  const focus = window.state.focus;
  if (!focus) return;
  const shown = algorithm.ensureVisible?.(window.layout, size, focus);
  if (shown && shown !== window.layout) window.layout = shown;
}

/**
 * If `pane` is a replace-host holding a live displaced session, restore that
 * session into the same leaf and return true. Otherwise leave the layout alone.
 */
function restoreDisplacedContent(window: WorkspaceWindow, pane: PaneRef): boolean {
  const content = pane.content;
  if (content.kind !== "plugin" || content.displaced === undefined) return false;
  const displaced = window.sessions.find(
    (session) => session.id === content.displaced && !session.exited,
  );
  const stillPlaced = layoutRefs(window.layout).some(
    (item) => paneSession(item.content) === content.displaced,
  );
  if (!displaced || stillPlaced) return false;
  window.layout = setPaneContent(window.layout, pane.id, paneContentFor(displaced));
  window.state.focus = pane.id;
  window.state.zoom = null;
  window.state.preset = null;
  return true;
}

/** Remove a session and every source view of it before ownership moves.
 *
 * A session belongs to one window. Moving only one of several panes would leave
 * the other panes displaying a session their window no longer owns. Closing
 * those views follows the same rule as process exit: the session goes away, so
 * its old viewports go away and the remaining layout takes their space.
 */
function takeSession(
  window: WorkspaceWindow,
  agent: string,
  size: LayoutSize,
  algorithm: TilingAlgorithm,
): void {
  for (const pane of layoutRefs(window.layout)) {
    if (paneSession(pane.content) === agent) closePane(window, pane.id, size, algorithm);
  }
  window.sessions = window.sessions.filter((item) => item.id !== agent);
}

/** Keep the model honest when a pane leaves its window.
 *
 * A backend has a viewport, or a displace-keepalive on a replace-host pane, or
 * it is gone. Closing the last pane that retains one stops it and removes it
 * from the model. Move and break operations transfer the pane before this
 * runs, so their backends remain referenced and survive normally.
 */
function afterPaneRemoved(
  workspace: WorkspaceSnapshot,
  space: WorkspaceSpace,
  window: WorkspaceWindow,
  actions: WorkspaceAction[],
): void {
  const referenced = new Set(
    layoutRefs(window.layout).flatMap((pane) => [...paneRetainedSessions(pane.content)]),
  );
  const removed = window.sessions.filter((agent) => !referenced.has(agent.id));
  for (const agent of removed) {
    if (!agent.exited) actions.push({ _tag: "kill", agent: agent.id });
  }
  if (removed.length > 0)
    window.sessions = window.sessions.filter((agent) => referenced.has(agent.id));
  if (layoutRefs(window.layout).length > 0) return;
  removeWindow(workspace, space, window, actions);
}

function normalizeWindowState(window: WorkspaceWindow): void {
  const panes = new Set(layoutRefs(window.layout).map((pane) => pane.id));
  window.state.focus = window.layout.focus ?? null;
  if (window.state.last !== null && !panes.has(window.state.last)) window.state.last = null;
  if (
    window.state.zoom &&
    (!panes.has(window.state.zoom.pane) ||
      !layoutRefs(window.state.zoom.from).some((pane) => pane.id === window.state.zoom!.pane))
  ) {
    window.state.zoom = null;
  }
}

function removeWindow(
  workspace: WorkspaceSnapshot,
  space: WorkspaceSpace,
  window: WorkspaceWindow,
  actions: WorkspaceAction[],
): void {
  const at = space.windows.indexOf(window);
  if (at === -1) return;
  for (const agent of window.sessions)
    if (!agent.exited) actions.push({ _tag: "kill", agent: agent.id });
  space.windows.splice(at, 1);
  space.state = closeWindowState(
    space.state,
    space.windows.map((item) => item.number),
    window.number,
    at,
  );
  if (space.windows.length === 0) removeSpace(workspace, space, actions);
}

function removeSpace(
  workspace: WorkspaceSnapshot,
  space: WorkspaceSpace,
  actions: WorkspaceAction[],
): void {
  const at = workspace.spaces.indexOf(space);
  if (at === -1) return;
  for (const window of space.windows) {
    for (const agent of window.sessions)
      if (!agent.exited) actions.push({ _tag: "kill", agent: agent.id });
  }
  workspace.spaces.splice(at, 1);
  workspace.state = removeSpaceState(
    workspace.state,
    workspace.spaces.map((item) => item.id),
    space.id,
    at,
  );
}

function allocateId(prefix: string, used: Set<string>): string {
  const id = `${prefix}-${randomUUID()}`;
  if (used.has(id)) throw new Error(`generated duplicate ${prefix} id`);
  used.add(id);
  return id;
}

/** The content a session's pane shows: a pty view onto the session, or a
 *  plugin view under its provider's registered key when the session is a
 *  component (the agent-harness worker). The descriptor is empty for a
 *  session-backed plugin pane — the session already names the backend — and
 *  becomes the remount contract for a client-only plugin pane (ts-a4e25e). */
function paneContentFor(session: PersistedSession): PaneContent {
  return session.kind === "component"
    ? {
        kind: "plugin",
        type: componentViewType(session),
        descriptor: {},
        session: session.id,
      }
    : { kind: "pty", session: session.id };
}

const commandName = (command: readonly string[]) => basename(command[0] ?? "") || "shell";

// ---------------------------------------------------------------------------
// The machine-facing read surface. These are pure projections of a snapshot:
// they build no actions, change nothing, publish no frame, and therefore mark
// nothing seen. They share types with read-model.ts, whose schemas derive from
// this model's own entity shapes, so the emitted shape cannot drift from the
// documented one.
// ---------------------------------------------------------------------------

export function spaceEntries(workspace: WorkspaceSnapshot): ReadSpaceEntry[] {
  return workspace.spaces.map((space) => {
    const entry = {
      id: space.id,
      name: space.name,
      dir: space.dir,
      activeWindow: space.state.activeWindow,
      windows: space.windows.length,
    };
    if (space.worktree !== undefined) Object.assign(entry, { worktree: space.worktree });
    return entry;
  });
}

export function windowEntries(workspace: WorkspaceSnapshot): ReadWindowEntry[] {
  const entries: ReadWindowEntry[] = [];
  for (const space of workspace.spaces) {
    for (const window of space.windows) {
      entries.push({
        space: space.id,
        number: window.number,
        name: window.name,
        panes: layoutRefs(window.layout).length,
        active: window.number === space.state.activeWindow,
        focused: window.state.focus,
      });
    }
  }
  return entries;
}

export function paneEntries(workspace: WorkspaceSnapshot): ReadPaneEntry[] {
  const entries: ReadPaneEntry[] = [];
  for (const { space, window } of workspaceWindows(workspace)) {
    for (const pane of layoutRefs(window.layout)) {
      entries.push(paneEntry(space, window, pane));
    }
  }
  return entries;
}

function paneEntry(space: WorkspaceSpace, window: WorkspaceWindow, pane: PaneRef): ReadPaneEntry {
  const session = paneSession(pane.content);
  const entry = {
    id: pane.id,
    space: space.id,
    window: window.number,
    focused: pane.id === window.state.focus,
    zoomed: window.state.zoom?.pane === pane.id,
  };
  if (session !== undefined) Object.assign(entry, { session });
  return entry;
}

export function agentEntries(workspace: WorkspaceSnapshot): ReadAgentEntry[] {
  const entries: ReadAgentEntry[] = [];
  for (const { space, window, session } of workspaceSessions(workspace)) {
    entries.push(agentEntry(space, window, session));
  }
  return entries;
}

function agentEntry(
  space: WorkspaceSpace,
  window: WorkspaceWindow,
  agent: PersistedSession,
): ReadAgentEntry {
  const pane = layoutRefs(window.layout).find((item) => paneSession(item.content) === agent.id);
  const entry = {
    id: agent.id,
    name: agent.name,
    cols: agent.cols,
    rows: agent.rows,
    exited: agent.exited,
    exitCode: agent.exitCode,
    space: space.id,
    window: window.number,
  };
  if (agent.kind !== undefined) Object.assign(entry, { kind: agent.kind });
  if (agent.declaredAgent !== undefined)
    Object.assign(entry, { declaredAgent: agent.declaredAgent });
  if (agent.cmd !== undefined) Object.assign(entry, { cmd: agent.cmd });
  if (agent.provider !== undefined) Object.assign(entry, { provider: agent.provider });
  if (agent.cwd !== undefined) Object.assign(entry, { cwd: agent.cwd });
  if (pane !== undefined) Object.assign(entry, { pane: pane.id });
  return entry;
}

/** The geometry of one pane inside its window, computed at `size` — the size
 *  every layout calculation in this model uses. Null when the pane is not
 *  placed. */
export function paneLayout(
  workspace: WorkspaceSnapshot,
  paneId: string,
  size: LayoutSize,
): ReadPaneLayout | null {
  for (const { window } of workspaceWindows(workspace)) {
    const placed = layoutRefs(window.layout).some((pane) => pane.id === paneId);
    if (!placed) continue;
    const rects = computeRects(window.layout, size);
    const rect = rects.get(paneId);
    if (!rect) return null;
    return {
      pane: paneId,
      x: rect.x,
      y: rect.y,
      cols: rect.width,
      rows: rect.height,
      size: { cols: size.cols, rows: size.rows },
      window: {
        cols: Math.max(0, Math.floor(size.cols)),
        rows: Math.max(0, Math.floor(size.rows)),
      },
      panes: [...rects.entries()].map(([id, item]) => ({
        id,
        x: item.x,
        y: item.y,
        cols: item.width,
        rows: item.height,
      })),
    };
  }
  return null;
}
// ---------------------------------------------------------------------------
