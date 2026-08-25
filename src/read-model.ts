/**
 * The wire shapes of the machine-facing read surface: the narrow questions an
 * agent can ask a daemon without the whole workspace snapshot.
 *
 * Every entry schema names the workspace model's own shape fields by
 * reference, so a response's documented shape cannot drift from what the model
 * emits. Computed fields — placement, focus flags, geometry — are the only
 * ones defined here, because they are not in the model.
 *
 * The entry builders live in workspace.ts next to the model they project; this
 * module is the schema half so commands.ts can declare results without a
 * runtime cycle.
 */
import { Schema as S } from "effect";
import { PersistedSessionSchema, WorkspaceSpaceSchema, WorkspaceWindowSchema } from "./workspace.ts";

const RectSchema = S.Struct({
  x: S.Int,
  y: S.Int,
  cols: S.Int,
  rows: S.Int,
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
  focused: S.Union(S.String, S.Null),
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
export const PaneCurrentResultSchema = S.Union(PaneEntrySchema, S.Null);
export const PaneLayoutResultSchema = S.Union(PaneLayoutSchema, S.Null);
export const AgentListResultSchema = S.Array(AgentEntrySchema);
export const AgentGetResultSchema = S.Union(AgentEntrySchema, S.Null);
