/**
 * Layout operations and answers that cross the tiling-algorithm boundary.
 *
 * One operation in, one answer out — the shape a future plugin-host socket
 * will carry. Core folds focus visibility into the answer (no second
 * ensureVisible step). An algorithm that cannot handle an operation answers
 * `unsupported`; core then uses layout.ts free functions as today.
 */
import { Schema as S } from "effect";
import { PaneAgentSessionSnapshotSchema } from "./agent-session.ts";
import { LAYOUT_PRESETS, LayoutSchema, PaneContentSchema } from "./layout.ts";

export const LayoutSizeSchema = S.Struct({
  cols: S.Finite,
  rows: S.Finite,
});
export type LayoutSizeData = typeof LayoutSizeSchema.Type;

export const DirectionSchema = S.Literals(["left", "right", "up", "down"]);
export type DirectionData = typeof DirectionSchema.Type;

export const SplitDirectionSchema = S.Literals(["row", "column"]);
export type SplitDirectionData = typeof SplitDirectionSchema.Type;

export const LayoutPathSchema = S.Array(S.Finite);
export type LayoutPathData = typeof LayoutPathSchema.Type;

export const LayoutPresetSchema = S.Literals([...LAYOUT_PRESETS]);
export type LayoutPresetData = typeof LayoutPresetSchema.Type;

export const PaneRefSchema = S.Struct({
  id: S.String,
  content: PaneContentSchema,
  agentSession: S.optional(PaneAgentSessionSnapshotSchema),
});
export type PaneRefData = typeof PaneRefSchema.Type;

const layoutAndSize = {
  layout: LayoutSchema,
  size: LayoutSizeSchema,
};

export const TilingOpInitSchema = S.TaggedStruct("init", {
  panes: S.Array(PaneRefSchema),
  size: LayoutSizeSchema,
});

export const TilingOpCloseSchema = S.TaggedStruct("close", {
  ...layoutAndSize,
  pane: S.String,
});

export const TilingOpFocusDirectionSchema = S.TaggedStruct("focusDirection", {
  ...layoutAndSize,
  from: S.String,
  direction: DirectionSchema,
});

export const TilingOpRevealSchema = S.TaggedStruct("reveal", {
  ...layoutAndSize,
  pane: S.String,
});

export const TilingOpSplitSchema = S.TaggedStruct("split", {
  ...layoutAndSize,
  at: S.String,
  direction: SplitDirectionSchema,
  pane: PaneRefSchema,
});

export const TilingOpSwapSchema = S.TaggedStruct("swap", {
  ...layoutAndSize,
  from: S.String,
  step: S.Finite,
});

export const TilingOpPresetSchema = S.TaggedStruct("preset", {
  ...layoutAndSize,
  preset: LayoutPresetSchema,
});

export const TilingOpResizeFocusSchema = S.TaggedStruct("resizeFocus", {
  ...layoutAndSize,
  pane: S.String,
  direction: DirectionSchema,
  delta: S.Finite,
});

export const TilingOpResizeDividerSchema = S.TaggedStruct("resizeDivider", {
  ...layoutAndSize,
  path: LayoutPathSchema,
  index: S.Finite,
  delta: S.Finite,
});

export const TilingOperationSchema = S.Union([
  TilingOpInitSchema,
  TilingOpCloseSchema,
  TilingOpFocusDirectionSchema,
  TilingOpRevealSchema,
  TilingOpSplitSchema,
  TilingOpSwapSchema,
  TilingOpPresetSchema,
  TilingOpResizeFocusSchema,
  TilingOpResizeDividerSchema,
]);
export type TilingOperation = typeof TilingOperationSchema.Type;

/** Successful answer: new layout, and focus when the operation moves it. */
export const TilingAnswerOkSchema = S.TaggedStruct("ok", {
  layout: LayoutSchema,
  focus: S.optionalKey(S.NullOr(S.String)),
});

/** The algorithm does not support this operation; core uses layout.ts. */
export const TilingAnswerUnsupportedSchema = S.TaggedStruct("unsupported", {});

export const TilingAnswerSchema = S.Union([TilingAnswerOkSchema, TilingAnswerUnsupportedSchema]);
export type TilingAnswer = typeof TilingAnswerSchema.Type;
