/**
 * The wire shapes of the machine-facing read surface: the narrow questions an
 * agent can ask a daemon without the whole workspace snapshot.
 *
 * Every entry schema names the workspace model's own shape fields by
 * reference, so a response's documented shape cannot drift from what the model
 * emits. Computed fields — placement, focus flags, geometry — are the only
 * ones defined here, because they are not in the model.
 *
 * The entry builders live in workspace.ts next to the model they project. The
 * space and window shapes themselves live here instead, alongside the read
 * schemas that project them: workspace.ts imports commands.ts (for
 * isCoreCommand), and commands.ts imports this module for its result schemas,
 * so a definition here that needed workspace.ts back would complete a cycle.
 */
import { Schema as S } from "effect";
import { PersistedSessionSchema } from "./session.ts";
import { LayoutSchema } from "./layout.ts";
import { MAX_SESSIONS, MAX_WINDOWS } from "./limits.ts";
import { NonEmptyString, PositiveInt } from "./schema-primitives.ts";

const RectSchema = S.Struct({
  x: S.Int,
  y: S.Int,
  cols: S.Int,
  rows: S.Int,
});

const WindowStateSchema = S.Struct({
  focus: S.NullOr(NonEmptyString),
  last: S.NullOr(NonEmptyString),
  zoom: S.NullOr(S.Struct({ pane: NonEmptyString, from: LayoutSchema })),
  sync: S.Boolean,
  preset: S.NullOr(
    S.Union([
      S.Literals(["even-horizontal"]),
      S.Literals(["even-vertical"]),
      S.Literals(["main-horizontal"]),
      S.Literals(["main-vertical"]),
      S.Literals(["tiled"]),
    ]),
  ),
});
export const WorkspaceWindowSchema = S.Struct({
  number: PositiveInt,
  name: S.NullOr(S.String),
  sessions: S.mutable(S.Array(PersistedSessionSchema)).pipe(S.check(S.isMaxLength(MAX_SESSIONS))),
  layout: LayoutSchema,
  state: WindowStateSchema,
});
/** The space and window shapes, exported for workspace.ts's own snapshot
 *  schema and for the read surface's derived entries below: a read entry
 *  names a model field by reference, so the documented shape cannot drift
 *  from the emitted shape. */
export const WorkspaceSpaceSchema = S.Struct({
  id: NonEmptyString,
  name: S.String,
  dir: S.String,
  windows: S.mutable(S.Array(WorkspaceWindowSchema)).pipe(S.check(S.isMaxLength(MAX_WINDOWS))),
  state: S.Struct({
    activeWindow: S.NullOr(PositiveInt),
    lastWindow: S.NullOr(PositiveInt),
    nextWindow: PositiveInt,
    nextPane: PositiveInt,
  }),
  worktree: S.optional(S.Struct({ branch: S.String, repo: S.String, path: S.String })),
});

/** One space, as an agent reads it: identity, the window on screen, and how
 *  many windows it holds. */
export const SpaceEntrySchema = S.Struct({
  id: WorkspaceSpaceSchema.fields.id,
  name: WorkspaceSpaceSchema.fields.name,
  dir: WorkspaceSpaceSchema.fields.dir,
  activeWindow: WorkspaceSpaceSchema.fields.state.fields.activeWindow,
  windows: S.Int,
  worktree: WorkspaceSpaceSchema.fields.worktree,
});
export type SpaceEntry = S.Schema.Type<typeof SpaceEntrySchema>;

/** One window with the space that owns it. `space` is not in the model shape —
 *  ownership is the tree's, not the node's — so the read names it. */
export const WindowEntrySchema = S.Struct({
  space: S.String,
  number: WorkspaceWindowSchema.fields.number,
  name: WorkspaceWindowSchema.fields.name,
  panes: S.Int,
  active: S.Boolean,
  focused: S.Union([S.String, S.Null]),
});
export type WindowEntry = S.Schema.Type<typeof WindowEntrySchema>;

/** One pane: where it lives, what session fills it, and its focus flags.
 *  Geometry is not here — an agent asks `pane.layout` for that. */
export const PaneEntrySchema = S.Struct({
  id: S.String,
  space: S.String,
  window: WorkspaceWindowSchema.fields.number,
  session: S.optional(S.String),
  focused: S.Boolean,
  zoomed: S.Boolean,
  /** The session leader's pid, for resource attribution. Absent for a pane
   *  with no live session, or one whose daemon cannot resolve it. */
  pid: S.optional(S.Int),
});
export type PaneEntry = S.Schema.Type<typeof PaneEntrySchema>;

/** One agent: the model's record (already the model's shape, so this names
 *  those fields by reference) plus where it lives. */
export const AgentEntrySchema = S.Struct({
  ...PersistedSessionSchema.fields,
  space: S.String,
  window: WorkspaceWindowSchema.fields.number,
  pane: S.optional(S.String),
});
export type AgentEntry = S.Schema.Type<typeof AgentEntrySchema>;

/** The geometry of one pane and its window, so an agent can read "wide or
 *  tall" before it picks a split direction. `size` is the size the geometry
 *  was computed at, and `panes` carries every pane's rect for comparison. */
export const PaneLayoutSchema = S.Struct({
  pane: S.String,
  x: S.Int,
  y: S.Int,
  cols: S.Int,
  rows: S.Int,
  size: S.Struct({ cols: S.Int, rows: S.Int }),
  window: S.Struct({ cols: S.Int, rows: S.Int }),
  panes: S.Array(S.Struct({ id: S.String, ...RectSchema.fields })),
});
export type PaneLayout = S.Schema.Type<typeof PaneLayoutSchema>;

export const SpaceListResultSchema = S.Array(SpaceEntrySchema);
export const WindowListResultSchema = S.Array(WindowEntrySchema);
export const PaneListResultSchema = S.Array(PaneEntrySchema);
export const PaneCurrentResultSchema = S.Union([PaneEntrySchema, S.Null]);
export const PaneLayoutResultSchema = S.Union([PaneLayoutSchema, S.Null]);
export const AgentListResultSchema = S.Array(AgentEntrySchema);
export const AgentGetResultSchema = S.Union([AgentEntrySchema, S.Null]);
