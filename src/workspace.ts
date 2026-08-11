import type { Command } from "./commands.ts";
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
  makeLayout,
  nextPreset,
  presetLayout,
  prune,
  splitLayout,
  swapLayout,
  windowState,
  LayoutFormatError,
  type Layout,
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
    for (const pane of layoutPanes(window.layout.root)) ids.add(pane.id);
  return ids;
}

export interface WorkspaceCommandContext {
  size: LayoutSize;
  shell: string[];
  cwd: string;
  /** Native agents execute workspace commands in the window containing them. */
  agent?: string;
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
export const NATIVE_AGENT = "native";

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
  cmd: S.Array(NonEmptyString).pipe(S.minItems(1)),
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
      agent: NonEmptyString,
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
const LayoutShape = S.Struct({
  version: S.Literal(1),
  root: S.NullOr(LayoutNodeShape),
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
  }),
  worktree: S.optional(S.Struct({ branch: S.String, repo: S.String, path: S.String })),
});
const WorkspaceSnapshotShape = S.Struct({
  revision: S.Int.pipe(S.greaterThanOrEqualTo(0)),
  spaces: S.Array(WorkspaceSpaceShape).pipe(S.maxItems(MAX_SPACES)),
  state: S.Struct({ activeSpace: S.NullOr(NonEmptyString) }),
});
export const WorkspaceSnapshotJson = S.parseJson(WorkspaceSnapshotShape);

/** Decode the JSON string used by the control and attach protocols. */
export function parseWorkspaceJson(
  value: string,
): Effect.Effect<WorkspaceSnapshot, WorkspaceParseError | SessionStateError> {
  return S.decodeUnknown(WorkspaceSnapshotJson)(value).pipe(
    Effect.mapError(
      (error) =>
        new WorkspaceParseError({ message: `workspace JSON is invalid: ${String(error)}` }),
    ),
    Effect.flatMap(parseWorkspace),
  );
}

export const WorkspaceCommandContextSchema = S.Struct({
  size: TerminalSize,
  shell: S.Array(NonEmptyString).pipe(S.minItems(1)),
  cwd: NonEmptyString,
  agent: S.optional(NonEmptyString),
  blockedAgents: S.optional(S.Array(NonEmptyString)),
  input: S.optional(S.String),
  worktreesRoot: S.optional(S.String),
});

export type WorkspaceAction =
  | { readonly _tag: "spawn"; readonly agent: PersistedSession }
  | { readonly _tag: "steer"; readonly agent: string; readonly message: string }
  | { readonly _tag: "interrupt"; readonly agent: string; readonly reason?: string }
  | { readonly _tag: "kill"; readonly agent: string }
  | { readonly _tag: "restart"; readonly agent: string }
  | { readonly _tag: "input"; readonly agent: string; readonly data: string };

export interface WorkspaceMutation {
  readonly snapshot: WorkspaceSnapshot;
  readonly actions: readonly WorkspaceAction[];
  readonly changed: boolean;
}

/**
 * Adopt persisted state at the daemon boundary.
 *
 * Layouts from disk are untrusted: malformed trees fall back to a fresh tiled
 * arrangement over live agents, and recorded panes naming absent agents are
 * pruned. Internal command transforms do not pass through this validation and
 * may legitimately produce an empty layout.
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
        for (const pane of layoutPanes(layout.root)) usedPaneIds.add(pane.id);
      }
    }
    const paneId = () => allocateId("pane", usedPaneIds);
    return {
      revision: 0,
      state: {
        activeSpace: session.spaces.some((space) => space.id === session.activeSpace)
          ? (session.activeSpace ?? null)
          : (session.spaces[0]?.id ?? null),
      },
      spaces: yield* Effect.all(
        session.spaces.map((saved) =>
          Effect.gen(function* () {
            const windows: WorkspaceWindow[] = [];
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
                const panes = [...live].map((agent) => ({ id: paneId(), agent }));
                layout = presetLayout(panes, "tiled", panes[0]?.id);
              }
              layout ??= makeLayout(null);
              if (layout.root && !layout.focus)
                layout = makeLayout(layout.root, layoutPanes(layout.root)[0]?.id);
              const state = windowState();
              state.focus = layout.focus ?? null;
              windows.push({
                number: window.number,
                name: window.name,
                agents: structuredClone(window.agents),
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
                nextWindow: Math.max(1, ...numbers.map((number) => number + 1)),
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
    spaces: workspace.spaces.map((space) => ({
      id: space.id,
      name: space.name,
      dir: space.dir,
      activeWindow: space.state.activeWindow,
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
        const paneIds = new Set(layoutPanes(window.layout.root).map((pane) => pane.id));
        if (
          window.state.focus !== (window.layout.focus ?? null) ||
          (window.state.last !== null && !paneIds.has(window.state.last))
        ) {
          return yield* new WorkspaceParseError({
            message: "workspace window state names an invalid pane",
          });
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
          if (layoutPanes(from.root).some((pane) => !agents.has(pane.agent))) {
            return yield* new WorkspaceParseError({
              message: "workspace zoom layout names an invalid agent",
            });
          }
          window.state.zoom.from = from;
        }
      }
    }
    return raw;
  });
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
  const paneIds = workspacePaneIds(next);
  const spaceIds = new Set(next.spaces.map((space) => space.id));
  const newAgentId = () => allocateId("agent", agentIds);
  const newPaneId = () => allocateId("pane", paneIds);
  const newSpaceId = () => allocateId("space", spaceIds);
  const actions: WorkspaceAction[] = [];
  const before = JSON.stringify(next);
  const space = () => findSpace(next, "space" in command ? command.space : undefined);
  const window = () => findWindow(next, command as { space?: string; window?: number });
  const activeWindow = () =>
    context.agent
      ? [...workspaceWindows(next)].find((entry) =>
          entry.window.agents.some((agent) => agent.id === context.agent),
        ) ?? null
      : findWindow(next, {});
  const setFocus = (target: WorkspaceWindow, id: string | undefined) => {
    if (!id || target.state.focus === id) return;
    target.state.zoom = target.state.zoom?.pane === id ? target.state.zoom : null;
    target.state.last = target.state.focus;
    target.state.focus = id;
    target.layout = makeLayout(target.layout.root, id);
  };
  const addAgent = (target: WorkspaceWindow, dir: string): PersistedSession => {
    const native = command._tag === "agent.new";
    const agent: PersistedSession = {
      id: newAgentId(),
      name: native ? "native-agent" : commandName(context.shell),
      cmd: native
        ? [process.execPath, new URL("./agent/native-worker.ts", import.meta.url).pathname]
        : [...context.shell],
      cwd: dir,
      // Both axes: the worker's content is frames a component draws, and it is
      // an agent. A shell pane is neither, even when the user starts an agent
      // in it — that one is detected from its foreground process instead.
      ...(native ? { kind: "component" as const, agent: NATIVE_AGENT } : {}),
      cols: Math.max(1, context.size.cols),
      rows: Math.max(1, context.size.rows),
      exited: false,
      exitCode: null,
    };
    target.agents.push(agent);
    actions.push({ _tag: "spawn", agent });
    if (native && command.prompt)
      actions.push({ _tag: "steer", agent: agent.id, message: command.prompt });
    return agent;
  };
  const addWindow = (target: WorkspaceSpace): WorkspaceWindow => {
    let number: number;
    [target.state, number] = claimWindowNumber(target.state);
    const created: WorkspaceWindow = {
      number,
      name: null,
      agents: [],
      layout: makeLayout(null),
      state: windowState(),
    };
    target.windows.push(created);
    target.state = selectWindowState(
      target.state,
      target.windows.map((item) => item.number),
      number,
    );
    const agent = addAgent(created, target.dir);
    const pane = newPaneId();
    created.layout = makeLayout({ type: "pane", id: pane, agent: agent.id, weight: 1 }, pane);
    created.state.focus = pane;
    return created;
  };

  switch (command._tag) {
    case "agent.steer": {
      if (command.session) actions.push({ _tag: "steer", agent: command.session, message: command.message });
      break;
    }
    case "agent.interrupt": {
      if (command.session)
        actions.push({ _tag: "interrupt", agent: command.session, ...(command.reason ? { reason: command.reason } : {}) });
      break;
    }
    case "agent.new": {
      const target = activeWindow();
      if (!target) break;
      const agent = addAgent(target.window, target.space.dir);
      const pane = { id: newPaneId(), agent: agent.id };
      target.window.layout = target.window.layout.root
        ? splitLayout(target.window.layout, 0, "row", pane)
        : makeLayout({ type: "pane", ...pane, weight: 1 }, pane.id);
      target.window.state.focus = pane.id;
      break;
    }
    case "pane.split": {
      const found = activeWindow();
      if (!found) break;
      const agent = addAgent(found.window, found.space.dir);
      const panes = layoutPanes(found.window.layout.root);
      const at = panes.findIndex((pane) => pane.id === found.window.state.focus);
      const ref = { id: newPaneId(), agent: agent.id };
      found.window.layout =
        at === -1
          ? makeLayout({ type: "pane", ...ref, weight: 1 }, ref.id)
          : splitLayout(found.window.layout, at, command.axis, ref);
      found.window.state.focus = ref.id;
      found.window.state.last = at === -1 ? null : (panes[at]?.id ?? null);
      found.window.state.zoom = null;
      found.window.state.preset = null;
      break;
    }
    case "pane.next": {
      const target = activeWindow();
      if (!target) break;
      const panes = layoutPanes(target.window.layout.root);
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
      if (target && layoutPanes(target.layout.root).some((pane) => pane.id === command.pane)) {
        setFocus(target, command.pane);
      }
      break;
    }
    case "pane.resize": {
      const target = activeWindow();
      if (!target || !target.window.state.focus || target.window.state.zoom) break;
      const resized = resizePane(
        target.window.layout,
        context.size,
        target.window.state.focus,
        command.direction,
      );
      if (resized !== target.window.layout) {
        target.window.layout = resized;
        target.window.state.preset = null;
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
      const target = activeWindow()?.window;
      if (!target?.state.focus || layoutPanes(target.layout.root).length < 2) break;
      target.state.zoom = target.state.zoom
        ? null
        : { pane: target.state.focus, from: target.layout };
      break;
    }
    case "pane.swap": {
      const target = activeWindow()?.window;
      if (!target?.state.focus) break;
      const panes = layoutPanes(target.layout.root);
      const at = panes.findIndex((pane) => pane.id === target.state.focus);
      if (at !== -1 && panes.length > 1) {
        target.layout = swapLayout(
          target.layout,
          at,
          (at + (command.to === "next" ? 1 : -1) + panes.length) % panes.length,
        );
        target.state.zoom = null;
      }
      break;
    }
    case "pane.close": {
      const found = activeWindow();
      if (!found?.window?.state.focus) break;
      closePane(found.window, found.window.state.focus);
      afterPaneRemoved(next, found.space, found.window, actions);
      break;
    }
    case "pane.break": {
      const found = activeWindow();
      const pane = found?.window.state.focus;
      if (!found || !pane) break;
      const slot = layoutPanes(found.window.layout.root).find((item) => item.id === pane);
      const agent = found.window.agents.find((item) => item.id === slot?.agent);
      if (!slot || !agent) break;
      closePane(found.window, pane);
      const stillReferenced = layoutPanes(found.window.layout.root).some(
        (p) => p.agent === agent.id,
      );
      if (!stillReferenced)
        found.window.agents = found.window.agents.filter((item) => item.id !== agent.id);
      let number: number;
      [found.space.state, number] = claimWindowNumber(found.space.state);
      const created: WorkspaceWindow = {
        number,
        name: null,
        agents: [stillReferenced ? structuredClone(agent) : agent],
        layout: makeLayout({ ...slot, weight: 1 }, slot.id),
        state: { ...windowState(), focus: slot.id },
      };
      found.space.windows.push(created);
      found.space.state = selectWindowState(
        found.space.state,
        found.space.windows.map((item) => item.number),
        number,
      );
      afterPaneRemoved(next, found.space, found.window, actions);
      break;
    }
    case "pane.join": {
      const destination = activeWindow();
      if (!destination) break;
      const sourceNumber =
        command.source ??
        destination.space.state.lastWindow ??
        destination.space.windows.find((window) => window !== destination.window)?.number;
      const source = findWindow(next, { space: destination.space.id, window: sourceNumber });
      if (!source || source.window === destination.window) break;
      const paneId = source.window.state.focus;
      const slot = layoutPanes(source.window.layout.root).find((item) => item.id === paneId);
      if (!slot) break;
      const agent = source.window.agents.find((item) => item.id === slot.agent);
      if (!agent) break;

      closePane(source.window, slot.id);
      const stillReferenced = layoutPanes(source.window.layout.root).some(
        (pane) => pane.agent === agent.id,
      );
      if (!stillReferenced)
        source.window.agents = source.window.agents.filter((item) => item.id !== agent.id);
      destination.window.layout = appendPane(destination.window.layout, slot);
      destination.window.agents.push(stillReferenced ? structuredClone(agent) : agent);
      destination.window.state.focus = slot.id;
      destination.window.state.last = null;
      destination.window.state.zoom = null;
      afterPaneRemoved(next, source.space, source.window, actions);
      break;
    }
    case "pane.move": {
      const source = activeWindow();
      const destination = findSpace(next, command.space);
      const target = destination?.windows.find(
        (window) => window.number === destination.state.activeWindow,
      );
      if (!source || !destination || !target || destination === source.space) break;
      const paneId = source.window.state.focus;
      const slot = layoutPanes(source.window.layout.root).find((item) => item.id === paneId);
      const agent = source.window.agents.find((item) => item.id === slot?.agent);
      if (!slot || !agent) break;

      closePane(source.window, slot.id);
      const stillReferenced = layoutPanes(source.window.layout.root).some(
        (pane) => pane.agent === agent.id,
      );
      if (!stillReferenced)
        source.window.agents = source.window.agents.filter((item) => item.id !== agent.id);
      target.layout = appendPane(target.layout, slot);
      target.agents.push(stillReferenced ? structuredClone(agent) : agent);
      target.state.focus = slot.id;
      target.state.last = null;
      target.state.zoom = null;
      afterPaneRemoved(next, source.space, source.window, actions);
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
      break;
    }
    case "pane.send-keys": {
      const target = activeWindow()?.window;
      const focused = layoutPanes(target?.layout.root ?? null).find(
        (pane) => pane.id === target?.state.focus,
      );
      if (target?.state.sync) {
        for (const agent of new Set(layoutPanes(target.layout.root).map((pane) => pane.agent))) {
          actions.push({ _tag: "input", agent, data: context.input ?? command.keys });
        }
      } else if (focused)
        actions.push({ _tag: "input", agent: focused.agent, data: context.input ?? command.keys });
      break;
    }
    case "window.new": {
      const target = space();
      if (target) addWindow(target);
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
      target.layout = presetLayout(
        layoutPanes(target.layout.root),
        preset,
        target.state.focus ?? undefined,
      );
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
      if (!layoutPanes(target.window.layout.root).some((pane) => pane.agent === target.agent.id)) {
        const pane = { id: newPaneId(), agent: target.agent.id };
        target.window.layout = target.window.layout.root
          ? splitLayout(target.window.layout, 0, "row", pane)
          : makeLayout({ type: "pane", ...pane, weight: 1 }, pane.id);
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
      let pane = layoutPanes(target.window.layout.root).find(
        (candidate) => candidate.agent === target.agent.id,
      );
      if (!pane) {
        const ref = { id: newPaneId(), agent: target.agent.id };
        const slots = layoutPanes(target.window.layout.root);
        target.window.layout = slots.length
          ? splitLayout(
              target.window.layout,
              Math.max(
                0,
                slots.findIndex((candidate) => candidate.id === target.window.state.focus),
              ),
              "row",
              ref,
            )
          : makeLayout({ type: "pane", ...ref, weight: 1 }, ref.id);
        pane = layoutPanes(target.window.layout.root).find((candidate) => candidate.id === ref.id);
      }
      setFocus(target.window, pane?.id);
      break;
    }
    case "session.next-blocked": {
      const blocked = context.blockedAgents ?? [];
      const focused = activeWindow()?.window.state.focus;
      const currentAgent = next.spaces
        .flatMap((item) => item.windows)
        .flatMap((item) => layoutPanes(item.layout.root))
        .find((pane) => pane.id === focused)?.agent;
      const at = currentAgent ? blocked.indexOf(currentAgent) : -1;
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
        const pane = layoutPanes(target.window.layout.root).find((item) => item.agent === id);
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
      addWindow(created);
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

  for (const { window } of workspaceWindows(next)) normalizeWindowState(window);

  const changed = before !== JSON.stringify(next);
  return {
    snapshot: changed ? { ...next, revision: current.revision + 1 } : current,
    actions,
    changed,
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
  if (!found.window.layout.root) {
    const live = found.window.agents.find((agent) => !agent.exited);
    if (live) {
      const used = new Set(
        next.spaces.flatMap((space) =>
          space.windows.flatMap((window) => layoutPanes(window.layout.root).map((pane) => pane.id)),
        ),
      );
      const pane = allocateId("pane", used);
      found.window.layout = makeLayout({ type: "pane", id: pane, agent: live.id, weight: 1 }, pane);
      found.window.state.focus = pane;
    } else {
      removeWindow(next, found.space, found.window, []);
    }
  }
  normalizeWindowState(found.window);
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
    const pane = layoutPanes(target?.window.layout.root ?? null).find(
      (item) => item.id === target?.window.state.focus,
    );
    const agent = target?.window.agents.find((item) => item.id === pane?.agent);
    return target && agent ? { ...target, agent } : null;
  }
  for (const entry of workspaceSessions(workspace)) if (entry.agent.id === id) return entry;
  return null;
}

function closePane(window: WorkspaceWindow, id: string): void {
  const panes = layoutPanes(window.layout.root);
  const at = panes.findIndex((pane) => pane.id === id);
  if (at === -1) return;
  window.layout = closeLayout(window.layout, at);
  window.state.focus = window.layout.focus ?? null;
  window.state.zoom = null;
  window.state.preset = null;
}

/** When a pane leaves a window without its agent dying, the window may become
 *  empty. A window with no panes has no focus and silently swallows keyboard
 *  input — so either reveal a surviving live agent or close the window. */
function afterPaneRemoved(
  workspace: WorkspaceSnapshot,
  space: WorkspaceSpace,
  window: WorkspaceWindow,
  actions: WorkspaceAction[],
): void {
  if (window.layout.root) return;
  const live = window.agents.find((agent) => !agent.exited);
  if (live) {
    const used = new Set(
      workspace.spaces.flatMap((s) =>
        s.windows.flatMap((w) => layoutPanes(w.layout.root).map((pane) => pane.id)),
      ),
    );
    const pane = allocateId("pane", used);
    window.layout = makeLayout({ type: "pane", id: pane, agent: live.id, weight: 1 }, pane);
    window.state.focus = pane;
  } else {
    removeWindow(workspace, space, window, actions);
  }
}

function normalizeWindowState(window: WorkspaceWindow): void {
  const panes = new Set(layoutPanes(window.layout.root).map((pane) => pane.id));
  window.state.focus = window.layout.focus ?? null;
  if (window.state.last !== null && !panes.has(window.state.last)) window.state.last = null;
  if (
    window.state.zoom &&
    (!panes.has(window.state.zoom.pane) ||
      !layoutPanes(window.state.zoom.from.root).some((pane) => pane.id === window.state.zoom!.pane))
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

const commandName = (command: readonly string[]) => basename(command[0] ?? "") || "shell";
