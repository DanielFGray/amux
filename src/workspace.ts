import type { AnyCommandResult, Command } from "./commands.ts";
import type { CreationResult } from "./creation-result.ts";
import type { PaneMoveResult } from "./commands.ts";
import type { PermissionAnswer } from "./effect/AttachProtocol.ts";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { worktreeDirname } from "./git.ts";
import { paneInDirection, resizeDivider, resizePane, type LayoutSize } from "./geometry.ts";
import {
  closeLayout,
  decodeLayout,
  encodeLayout,
  appendPane,
  layoutPanes,
  layoutRefs,
  layoutSessions,
  makeLayout,
  nextPreset,
  paneSession,
  placementOf,
  presetLayout,
  prune,
  setPlacement,
  splitLayout,
  swapLayout,
  windowState,
  PaneContentSchema,
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
  claimWindowNumber,
  closeWindowState,
  removeSpaceState,
  selectWindowState,
  spaceState,
  type SpaceSetState,
  type SpaceState,
} from "./space-model.ts";
import {
  MAX_SESSIONS,
  MAX_SPACES,
  MAX_TERMINAL_CELLS,
  MAX_TERMINAL_DIMENSION,
  MAX_WINDOWS,
} from "./limits.ts";
import { Effect, Either, Schema as S } from "effect";

export class WorkspaceParseError extends S.TaggedError<WorkspaceParseError>()(
  "WorkspaceParseError",
  {
    message: S.String,
  },
) {}

export interface WorkspaceWindow {
  number: number;
  name: string | null;
  agents: PersistedSession[];
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
 *  windows, a window owns its agents — so ownership is always determined and
 *  every traversal can hand back the owners rather than making callers re-nest
 *  to recover them. */
export interface WindowEntry {
  space: WorkspaceSpace;
  window: WorkspaceWindow;
}

export interface AgentEntry extends WindowEntry {
  agent: PersistedSession;
}

export function* workspaceWindows(workspace: WorkspaceSnapshot): Generator<WindowEntry> {
  for (const space of workspace.spaces) for (const window of space.windows) yield { space, window };
}

export function* workspaceSessions(workspace: WorkspaceSnapshot): Generator<AgentEntry> {
  for (const entry of workspaceWindows(workspace))
    for (const agent of entry.window.agents) yield { ...entry, agent };
}

export function workspaceSessionIds(workspace: WorkspaceSnapshot): Set<string> {
  return new Set(Array.from(workspaceSessions(workspace), ({ agent }) => agent.id));
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
  /** True when a background caller asked for no focus to move. The mutation
   *  applies its structure but leaves the workspace's focus and activation
   *  state exactly as it found it. */
  noFocus?: boolean;
  /** Client-observed attention state, used only by agent.next-blocked. */
  blockedAgents?: readonly string[];
  /** Compiled bytes for pane.send-keys; the command remains the vocabulary. */
  input?: string;
  /** Root directory for space worktrees. Daemon authority: derived from the
   *  session env, never the client. Required only when a command creates a
   *  worktree space (space.new with a branch). */
  worktreesRoot?: string;
}

/** The agent amux runs itself, as opposed to a foreign CLI in a shell pane. */
const NonEmptyString = S.String.pipe(S.minLength(1));
const PositiveInt = S.Int.pipe(S.greaterThan(0));
const TerminalDimension = S.Int.pipe(S.greaterThan(0), S.lessThanOrEqualTo(MAX_TERMINAL_DIMENSION));
const TerminalSize = S.Struct({
  cols: TerminalDimension,
  rows: TerminalDimension,
}).pipe(
  S.filter(({ cols, rows }) => cols * rows <= MAX_TERMINAL_CELLS, {
    message: () => "terminal size is too large",
  }),
);
const PersistedAgentShape = S.Struct({
  id: NonEmptyString,
  name: S.String,
  kind: S.optional(S.Literal("pty", "component")),
  agent: S.optional(NonEmptyString),
  cmd: S.optional(S.Array(NonEmptyString).pipe(S.minItems(1))),
  provider: S.optional(NonEmptyString),
  cwd: S.optional(S.String),
  cols: TerminalDimension,
  rows: TerminalDimension,
  exited: S.Boolean,
  exitCode: S.NullOr(S.Int),
});
const LayoutNodeShape: S.Schema<any> = S.suspend(() =>
  S.Union(
    S.Struct({
      type: S.Literal("pane"),
      id: NonEmptyString,
      content: PaneContentSchema,
      weight: S.Number.pipe(S.greaterThan(0)),
    }),
    S.Struct({
      type: S.Literal("split"),
      direction: S.Union(S.Literal("row"), S.Literal("column")),
      weight: S.Number.pipe(S.greaterThan(0)),
      children: S.Array(LayoutNodeShape).pipe(S.minItems(2)),
    }),
  ),
);
/** Fractions of the window. Bounds are parseLayout's, restated here because a
 *  schema that merely said "number" would strip nothing and admit anything. */
const LayoutFloatShape = S.Struct({
  id: NonEmptyString,
  content: PaneContentSchema,
  x: S.Number.pipe(S.greaterThanOrEqualTo(0), S.lessThan(1)),
  y: S.Number.pipe(S.greaterThanOrEqualTo(0), S.lessThan(1)),
  width: S.Number.pipe(S.greaterThan(0), S.lessThanOrEqualTo(1)),
  height: S.Number.pipe(S.greaterThan(0), S.lessThanOrEqualTo(1)),
});
const LayoutShape = S.Struct({
  version: S.Literal(1),
  root: S.NullOr(LayoutNodeShape),
  // Optional, because a snapshot written before floats existed has no such key
  // and meant that nothing floats. Not optional in the Layout it decodes to:
  // a schema field this one omits is a field silently DROPPED from every
  // snapshot crossing the wire, which is how a float reached the daemon and
  // never reached the client.
  floats: S.optional(S.Array(LayoutFloatShape)),
  focus: S.optional(NonEmptyString),
});
const WindowStateShape = S.Struct({
  focus: S.NullOr(NonEmptyString),
  last: S.NullOr(NonEmptyString),
  zoom: S.NullOr(S.Struct({ pane: NonEmptyString, from: LayoutShape })),
  sync: S.Boolean,
  preset: S.NullOr(
    S.Union(
      S.Literal("even-horizontal"),
      S.Literal("even-vertical"),
      S.Literal("main-horizontal"),
      S.Literal("main-vertical"),
      S.Literal("tiled"),
    ),
  ),
});
const WorkspaceWindowShape = S.Struct({
  number: PositiveInt,
  name: S.NullOr(S.String),
  agents: S.Array(PersistedAgentShape).pipe(S.maxItems(MAX_SESSIONS)),
  layout: LayoutShape,
  state: WindowStateShape,
});
const WorkspaceSpaceShape = S.Struct({
  id: NonEmptyString,
  name: S.String,
  dir: S.String,
  windows: S.Array(WorkspaceWindowShape).pipe(S.maxItems(MAX_WINDOWS)),
  state: S.Struct({
    activeWindow: S.NullOr(PositiveInt),
    lastWindow: S.NullOr(PositiveInt),
    nextWindow: PositiveInt,
    nextPane: PositiveInt,
  }),
  worktree: S.optional(S.Struct({ branch: S.String, repo: S.String, path: S.String })),
});
const WorkspaceSnapshotShape = S.Struct({
  revision: S.Int.pipe(S.greaterThanOrEqualTo(0)),
  spaces: S.Array(WorkspaceSpaceShape).pipe(S.maxItems(MAX_SPACES)),
  state: S.Struct({
    activeSpace: S.NullOr(NonEmptyString),
    nextSpace: PositiveInt,
  }),
});
export const WorkspaceSnapshotJson = S.parseJson(WorkspaceSnapshotShape);

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
  return S.decodeUnknown(WorkspaceSnapshotJson)(value).pipe(
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
  shell: S.Array(NonEmptyString).pipe(S.minItems(1)),
  cwd: NonEmptyString,
  agent: S.optional(NonEmptyString),
  pane: S.optional(NonEmptyString),
  noFocus: S.optional(S.Boolean),
  blockedAgents: S.optional(S.Array(NonEmptyString)),
  input: S.optional(S.String),
  worktreesRoot: S.optional(S.String),
});

export type WorkspaceAction =
  | { readonly _tag: "spawn"; readonly agent: PersistedSession }
  | { readonly _tag: "prompt"; readonly agent: string; readonly text: string }
  | {
      readonly _tag: "interrupt";
      readonly agent: string;
      readonly reason?: string;
    }
  | {
      readonly _tag: "decide";
      readonly agent: string;
      readonly answer: PermissionAnswer;
    }
  | { readonly _tag: "kill"; readonly agent: string }
  | { readonly _tag: "restart"; readonly agent: string }
  | { readonly _tag: "input"; readonly agent: string; readonly data: string };

export interface WorkspaceMutation {
  readonly snapshot: WorkspaceSnapshot;
  readonly actions: readonly WorkspaceAction[];
  readonly changed: boolean;
  readonly result?: AnyCommandResult;
}

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
                window.agents.filter((agent) => !agent.exited).map((agent) => agent.id),
              );
              let layout: Layout | null = null;
              if (window.layout) {
                const result = yield* Effect.either(decodeLayout(window.layout));
                if (Either.isRight(result)) {
                  layout = prune(result.right, (agent) => live.has(agent));
                }
              }
              if (!layout?.root && live.size > 0) {
                const panes = window.agents
                  .filter((agent) => !agent.exited)
                  .map((agent) => ({
                    id: paneId(),
                    content: paneContentFor(agent),
                  }));
                layout = presetLayout(panes, "tiled", panes[0]?.id);
              }
              layout ??= makeLayout({ root: null });
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
              const roster = window.agents.filter((agent) => agent.exited || placed.has(agent.id));
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
                agents: structuredClone(roster),
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
export function workspaceSession(workspace: WorkspaceSnapshot, base: SessionState): SessionState {
  return {
    ...base,
    version: SESSION_VERSION,
    updatedAt: Date.now(),
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
        agents: structuredClone(window.agents),
        layout: encodeLayout(window.layout),
      })),
    })),
  };
}

/** Parse a subscribed model before a client projects it. */
export function parseWorkspace(
  value: unknown,
): Effect.Effect<WorkspaceSnapshot, WorkspaceParseError | SessionStateError> {
  return Effect.gen(function* () {
    const decoded = yield* S.decodeUnknown(WorkspaceSnapshotShape)(value).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceParseError({
            message: `workspace does not match schema: ${error.message}`,
          }),
      ),
    );
    const raw = structuredClone(decoded) as WorkspaceSnapshot;
    yield* parseSessionState(
      workspaceSession(raw, {
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
            window.agents.filter((agent) => !agent.exited).map((agent) => agent.id),
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

/** Validate the pane->agent edge, the model's only non-tree relationship.
 *
 * A window owns two sibling collections — agents and a layout of panes — joined
 * by the pane's session id. Schema decodes structure, not references, so this
 * pass asserts every pane names a live agent its own window owns, and every
 * live agent is visible in at least one pane. The one legal unreferenced agent
 * is an exited one: it keeps its record as a restart target after its viewport
 * is pruned. */
function checkWorkspaceReferences(workspace: WorkspaceSnapshot): WorkspaceParseError | null {
  for (const { window } of workspaceWindows(workspace)) {
    const referenced = new Set<string>();
    for (const pane of layoutRefs(window.layout)) {
      const session = paneSession(pane.content);
      if (session === undefined) continue;
      referenced.add(session);
      const agent = window.agents.find((item) => item.id === session);
      if (!agent || agent.exited)
        return new WorkspaceParseError({
          message: `workspace pane '${pane.id}' names an agent this window does not have live`,
        });
    }
    for (const agent of window.agents) {
      if (!agent.exited && !referenced.has(agent.id))
        return new WorkspaceParseError({
          message: `workspace agent '${agent.id}' has no pane`,
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
    const decoded = yield* S.decodeUnknown(WorkspaceCommandContextSchema)(value).pipe(
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

/** Apply one existing command value to a private candidate generation. */
export function applyWorkspaceCommand(
  current: WorkspaceSnapshot,
  command: Command,
  context: WorkspaceCommandContext,
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
    const id = `${space.id}:p${space.state.nextPane}`;
    space.state = { ...space.state, nextPane: space.state.nextPane + 1 };
    return id;
  };
  const actions: WorkspaceAction[] = [];
  let result: AnyCommandResult | undefined;
  const before = JSON.stringify(next);
  const space = () => findSpace(next, "space" in command ? command.space : undefined);
  const window = () => findWindow(next, command as { space?: string; window?: number });
  const activeWindow = () =>
    context.agent
      ? ([...workspaceWindows(next)].find((entry) =>
          entry.window.agents.some((agent) => agent.id === context.agent),
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
  const setFocus = (target: WorkspaceWindow, id: string | undefined) => {
    if (!id || target.state.focus === id) return;
    target.state.zoom = target.state.zoom?.pane === id ? target.state.zoom : null;
    target.state.last = target.state.focus;
    target.state.focus = id;
    target.layout = makeLayout({ ...target.layout, focus: id });
  };
  const addAgent = (target: WorkspaceWindow, dir: string): PersistedSession => {
    const component = command._tag === "agent.new";
    if (component && !command.provider) throw new Error("agent.new requires a spawn provider");
    const agent: PersistedSession = {
      id: newAgentId(),
      name: component ? `${command.provider!}-agent` : commandName(context.shell),
      ...(component ? {} : { cmd: [...context.shell] }),
      cwd: dir,
      // Both axes: the worker's content is frames a component draws, and it is
      // an agent. A shell pane is neither, even when the user starts an agent
      // in it — that one is detected from its foreground process instead.
      ...(component
        ? {
            kind: "component" as const,
            agent: command.provider,
            provider: command.provider,
          }
        : {}),
      cols: Math.max(1, context.size.cols),
      rows: Math.max(1, context.size.rows),
      exited: false,
      exitCode: null,
    };
    target.agents.push(agent);
    actions.push({ _tag: "spawn", agent });
    if (component && command.prompt)
      actions.push({ _tag: "prompt", agent: agent.id, text: command.prompt });
    return agent;
  };
  const addWindow = (target: WorkspaceSpace): WorkspaceWindow => {
    let number: number;
    [target.state, number] = claimWindowNumber(target.state);
    const created: WorkspaceWindow = {
      number,
      name: null,
      agents: [],
      layout: makeLayout({ root: null }),
      state: windowState(),
    };
    target.windows.push(created);
    target.state = selectWindowState(
      target.state,
      target.windows.map((item) => item.number),
      number,
    );
    const agent = addAgent(created, target.dir);
    const pane = newPaneId(target);
    created.layout = makeLayout({
      root: { type: "pane", id: pane, content: paneContentFor(agent), weight: 1 },
      focus: pane,
    });
    created.state.focus = pane;
    return created;
  };

  switch (command._tag) {
    case "agent.permission": {
      if (command.session)
        actions.push({
          _tag: "decide",
          agent: command.session,
          answer: {
            request: command.request,
            decision: command.decision,
            ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
          },
        });
      break;
    }
    case "agent.interrupt": {
      if (command.session)
        actions.push({
          _tag: "interrupt",
          agent: command.session,
          ...(command.reason ? { reason: command.reason } : {}),
        });
      break;
    }
    case "agent.new": {
      const target = activeWindow();
      if (!target) break;
      const agent = addAgent(target.window, target.space.dir);
      const pane = { id: newPaneId(target.space), content: paneContentFor(agent) };
      target.window.layout = target.window.layout.root
        ? splitLayout(target.window.layout, 0, "row", pane)
        : appendPane(target.window.layout, pane);
      target.window.state.focus = pane.id;
      result = { session: agent.id, pane: pane.id } satisfies CreationResult<"agent.new">;
      break;
    }
    case "pane.split": {
      const target = paneTarget();
      if (!target) break;
      const { space, window } = target.window;
      // A split inherits the caller's directory, not the space's: an agent
      // delegating from a worktree pane must not land the sibling in the repo
      // root. The flag overrides that default.
      const agent = addAgent(window, resolve(context.cwd, command.cwd?.trim() || "."));
      const panes = layoutPanes(window.layout.root);
      const at = panes.findIndex((pane) => pane.id === target.pane.id);
      const ref = { id: newPaneId(space), content: paneContentFor(agent) };
      window.layout =
        at === -1
          ? appendPane(window.layout, ref)
          : splitLayout(window.layout, at, command.axis, ref);
      window.state.focus = ref.id;
      window.state.last = at === -1 ? null : (panes[at]?.id ?? null);
      window.state.zoom = null;
      window.state.preset = null;
      result = { session: agent.id, pane: ref.id } satisfies CreationResult<"pane.split">;
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
      if (!target || !target.window.state.focus) break;
      setFocus(
        target.window,
        paneInDirection(
          target.window.layout,
          context.size,
          target.window.state.focus,
          command.direction,
        ) ?? undefined,
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
    case "pane.resize": {
      const target = paneTarget();
      if (!target || target.window.window.state.zoom) break;
      const resized = resizePane(
        target.window.window.layout,
        context.size,
        target.pane.id,
        command.direction,
      );
      if (resized !== target.window.window.layout) {
        target.window.window.layout = resized;
        target.window.window.state.preset = null;
      }
      break;
    }
    case "pane.resize-divider": {
      const target = activeWindow()?.window;
      if (!target || target.state.zoom) break;
      const resized = resizeDivider(
        target.layout,
        context.size,
        command.path,
        command.index,
        command.delta,
      );
      if (resized !== target.layout) {
        target.layout = resized;
        target.state.preset = null;
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
    case "pane.swap": {
      const target = paneTarget();
      if (!target) break;
      const window = target.window.window;
      const panes = layoutPanes(window.layout.root);
      const at = panes.findIndex((pane) => pane.id === target.pane.id);
      if (at !== -1 && panes.length > 1) {
        window.layout = swapLayout(
          window.layout,
          at,
          (at + (command.to === "next" ? 1 : -1) + panes.length) % panes.length,
        );
        window.state.zoom = null;
      }
      break;
    }
    case "pane.close": {
      const found = paneTarget();
      if (!found) break;
      closePane(found.window.window, found.pane.id);
      afterPaneRemoved(next, found.window.space, found.window.window, actions);
      break;
    }
    case "pane.break": {
      const found = paneTarget();
      if (!found) break;
      const { space, window } = found.window;
      const slot = found.pane;
      const session = paneSession(slot.content);
      const agent = session ? window.agents.find((item) => item.id === session) : undefined;
      if (!agent) break;
      takeSession(window, agent.id);
      let number: number;
      [space.state, number] = claimWindowNumber(space.state);
      const created: WorkspaceWindow = {
        number,
        name: null,
        agents: [agent],
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
      const agent = session ? source.window.agents.find((item) => item.id === session) : undefined;
      if (!agent) break;

      takeSession(source.window, agent.id);
      destination.window.layout = appendPane(destination.window.layout, slot);
      destination.window.agents.push(agent);
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
        ? source.window.window.agents.find((item) => item.id === session)
        : undefined;
      if (!agent) break;

      // A pane id is space-qualified, so crossing spaces re-qualifies it. The
      // caller must be told — its handle no longer names the pane — and the old
      // id lets it re-anchor deterministically.
      const previousPaneId = slot.id;
      takeSession(source.window.window, agent.id);
      const moved = { ...slot, id: newPaneId(destination) };
      target.layout = appendPane(target.layout, moved);
      target.agents.push(agent);
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
    case "pane.send-keys": {
      const target = paneTarget();
      if (!target) break;
      const { window } = target.window;
      const sessions = layoutRefs(window.layout)
        .map((pane) => paneSession(pane.content))
        .filter((session): session is string => session !== undefined);
      if (window.state.sync) {
        for (const agent of new Set(sessions)) {
          actions.push({
            _tag: "input",
            agent,
            data: context.input ?? command.keys,
          });
        }
      } else {
        const session = paneSession(target.pane.content);
        if (session)
          actions.push({
            _tag: "input",
            agent: session,
            data: context.input ?? command.keys,
          });
      }
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
      const target = findSession(next, command.session);
      if (!target) break;
      actions.push({ _tag: "kill", agent: target.agent.id });
      target.window.agents = target.window.agents.filter((agent) => agent.id !== target.agent.id);
      target.window.layout = prune(target.window.layout, (agent) => agent !== target.agent.id);
      target.window.state.focus = target.window.layout.focus ?? null;
      afterPaneRemoved(next, target.space, target.window, actions);
      break;
    }
    case "session.restart": {
      const target = findSession(next, command.session);
      if (!target || !target.agent.exited) break;
      target.agent.exited = false;
      target.agent.exitCode = null;
      target.agent.kind ??= "pty";
      if (
        !layoutRefs(target.window.layout).some(
          (pane) => paneSession(pane.content) === target.agent.id,
        )
      ) {
        const pane = { id: newPaneId(target.space), content: paneContentFor(target.agent) };
        target.window.layout = target.window.layout.root
          ? splitLayout(target.window.layout, 0, "row", pane)
          : appendPane(target.window.layout, pane);
        target.window.state.focus = pane.id;
      }
      actions.push({ _tag: "spawn", agent: structuredClone(target.agent) });
      break;
    }
    case "session.reveal": {
      const target = findSession(next, command.session);
      if (!target || target.agent.exited) break;
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
      // A live agent always holds a pane, so revealing it is a focus move.
      const pane = layoutRefs(target.window.layout).find(
        (candidate) => paneSession(candidate.content) === target.agent.id,
      );
      if (pane) setFocus(target.window, pane.id);
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
          priorFocus !== null &&
          layoutRefs(window.layout).some((pane) => pane.id === priorFocus);
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
  return {
    snapshot: changed ? { ...next, revision: current.revision + 1 } : current,
    actions,
    changed,
    ...(result === undefined ? {} : { result }),
  };
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
  found.agent.exited = true;
  found.agent.exitCode = code;
  found.window.layout = prune(found.window.layout, (agent) => agent !== id);
  found.window.state.focus = found.window.layout.focus ?? null;
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
  found.agent.exited = true;
  found.agent.exitCode = null;
  found.agent.name = `${found.agent.name} (unavailable: ${reason})`;
  found.window.layout = prune(found.window.layout, (agent) => agent !== id);
  found.window.state.focus = found.window.layout.focus ?? null;
  return { ...next, revision: current.revision + 1 };
}

function findSpace(workspace: WorkspaceSnapshot, id?: string): WorkspaceSpace | null {
  const wanted = id ?? workspace.state.activeSpace;
  return workspace.spaces.find((space) => space.id === wanted) ?? null;
}

function findWindow(
  workspace: WorkspaceSnapshot,
  target: { space?: string; window?: number },
): WindowEntry | null {
  const space = findSpace(workspace, target.space);
  if (!space) return null;
  const number = target.window ?? space.state.activeWindow;
  const window = space.windows.find((item) => item.number === number);
  return window ? { space, window } : null;
}

function findSession(workspace: WorkspaceSnapshot, id?: string): AgentEntry | null {
  if (!id) {
    const target = findWindow(workspace, {});
    const pane = (target ? layoutRefs(target.window.layout) : []).find(
      (item) => item.id === target?.window.state.focus,
    );
    const session = pane ? paneSession(pane.content) : undefined;
    const agent = session ? target?.window.agents.find((item) => item.id === session) : undefined;
    return target && agent ? { ...target, agent } : null;
  }
  for (const entry of workspaceSessions(workspace)) if (entry.agent.id === id) return entry;
  return null;
}

function closePane(window: WorkspaceWindow, id: string): void {
  const closed = closeLayout(window.layout, id);
  if (closed === window.layout) return;
  window.layout = closed;
  window.state.focus = window.layout.focus ?? null;
  window.state.zoom = null;
  window.state.preset = null;
}

/** Remove a session and every source view of it before ownership moves.
 *
 * A session belongs to one window. Moving only one of several panes would leave
 * the other panes displaying a session their window no longer owns. Closing
 * those views follows the same rule as process exit: the session goes away, so
 * its old viewports go away and the remaining layout takes their space.
 */
function takeSession(window: WorkspaceWindow, agent: string): void {
  for (const pane of layoutRefs(window.layout)) {
    if (paneSession(pane.content) === agent) closePane(window, pane.id);
  }
  window.agents = window.agents.filter((item) => item.id !== agent);
}

/** Keep the model honest when a pane leaves its window.
 *
 * A backend has a viewport or it is gone. There is no detached backend state:
 * closing the last pane that names one stops it and removes it from the model.
 * Move and break operations transfer the pane before this runs, so their
 * backends remain referenced and survive normally.
 */
function afterPaneRemoved(
  workspace: WorkspaceSnapshot,
  space: WorkspaceSpace,
  window: WorkspaceWindow,
  actions: WorkspaceAction[],
): void {
  const referenced = new Set(
    layoutRefs(window.layout)
      .map((pane) => paneSession(pane.content))
      .filter((session): session is string => session !== undefined),
  );
  const removed = window.agents.filter((agent) => !referenced.has(agent.id));
  for (const agent of removed) {
    if (!agent.exited) actions.push({ _tag: "kill", agent: agent.id });
  }
  if (removed.length > 0) window.agents = window.agents.filter((agent) => referenced.has(agent.id));
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
  for (const agent of window.agents)
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
    for (const agent of window.agents)
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

/** The content a session's pane shows: a pty view onto the session, or a plugin
 *  view of its declared agent kind when the session is a component (the
 *  agent-harness worker). The descriptor is empty for a session-backed plugin
 *  pane — the session already names the backend — and becomes the remount
 *  contract for a client-only plugin pane (ts-a4e25e). */
function paneContentFor(agent: PersistedSession): PaneContent {
  return agent.kind === "component"
    ? {
        kind: "plugin",
        type: agent.agent ?? agent.provider ?? "component",
        descriptor: {},
        session: agent.id,
      }
    : { kind: "pty", session: agent.id };
}

const commandName = (command: readonly string[]) => basename(command[0] ?? "") || "shell";
