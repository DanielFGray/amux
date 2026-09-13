/**
 * Plugin workspace reducer contract: reads and changes as plain Schema data.
 * Core applies the decoded answer synchronously; the reducer never holds a draft.
 *
 * Open fields on the change Schema are {@link JsonValueSchema} — the Encoded
 * side of an owner Schema on the wire. Plugins encode through typed handles
 * before answering; apply keeps only data checks (ids, declared tags, size).
 */
import { Schema as S } from "effect";
import { PersistedSessionSchema } from "./session.ts";
import { AgentEntrySchema } from "./read-model.ts";
import { JsonValueSchema, type JsonValue } from "./effect/AttachProtocol.ts";
import { NewPaneIdSchema, SessionIdSchema } from "./workspace-ids.ts";
import { PositiveInt } from "./schema-primitives.ts";

export const PLUGIN_REDUCE_TIMEOUT_MS = 2000;

/** Per-call budget for an elected plugin tiling algorithm (same scale as reducers). */
export const PLUGIN_TILING_TIMEOUT_MS = 2000;

/** Per-call budget for a pane-type owner descriptor check (same scale as reducers). */
export const PLUGIN_DESCRIPTOR_CHECK_TIMEOUT_MS = 2000;

export class WorkspaceChangeError extends S.TaggedError<WorkspaceChangeError>()(
  "WorkspaceChangeError",
  { message: S.String },
) {}

/** Declared failure from a plugin reducer Effect. Mapped to WorkspaceTransactionError. */
export class PluginReducerError extends S.TaggedError<PluginReducerError>()("PluginReducerError", {
  message: S.String,
}) {}

export const WindowRefSchema = S.Struct({
  space: S.String,
  window: S.Finite,
});
export type WindowRef = typeof WindowRefSchema.Type;

export const ActiveWindowReadSchema = S.Struct({
  space: S.String,
  window: S.Finite,
  dir: S.String,
});
export type ActiveWindowRead = typeof ActiveWindowReadSchema.Type;

export const WorkspaceReadPackageSchema = S.Struct({
  activeWindow: S.NullOr(ActiveWindowReadSchema),
  focusedSession: S.NullOr(PersistedSessionSchema),
  sessionsById: S.Record(S.String, PersistedSessionSchema),
  agents: S.Array(AgentEntrySchema),
  /** Space id → next pane number the space will mint (same as `SpaceState.nextPane`). */
  nextPaneBySpace: S.Record(S.String, PositiveInt),
});
export type WorkspaceReadPackage = typeof WorkspaceReadPackageSchema.Type;

export const SessionAddChangeSchema = S.TaggedStruct("session.add", {
  id: SessionIdSchema,
  target: WindowRefSchema,
  dir: S.String,
  provider: S.optionalKey(S.String),
  firstMessage: S.optionalKey(JsonValueSchema),
});

export const SessionPlaceSplitSchema = S.TaggedStruct("session.place", {
  mode: S.Literal("split"),
  pane: NewPaneIdSchema,
  target: WindowRefSchema,
  session: SessionIdSchema,
});

export const SessionPlaceReplaceSchema = S.TaggedStruct("session.place", {
  mode: S.Literal("replace"),
  target: WindowRefSchema,
  session: SessionIdSchema,
});

export const SessionPlaceChangeSchema = S.Union([
  SessionPlaceSplitSchema,
  SessionPlaceReplaceSchema,
]);

export const PluginPlaceSplitSchema = S.TaggedStruct("plugin.place", {
  mode: S.Literal("split"),
  pane: NewPaneIdSchema,
  type: S.String,
  descriptor: JsonValueSchema,
});

export const PluginPlaceReplaceSchema = S.TaggedStruct("plugin.place", {
  mode: S.Literal("replace"),
  type: S.String,
  descriptor: JsonValueSchema,
});

export const PluginPlaceChangeSchema = S.Union([PluginPlaceSplitSchema, PluginPlaceReplaceSchema]);

export const ActionPushChangeSchema = S.TaggedStruct("action.push", {
  action: JsonValueSchema,
});

export const ResultSetChangeSchema = S.TaggedStruct("result.set", {
  result: JsonValueSchema,
});

export const WorkspaceChangeSchema = S.Union([
  SessionAddChangeSchema,
  SessionPlaceChangeSchema,
  PluginPlaceChangeSchema,
  ActionPushChangeSchema,
  ResultSetChangeSchema,
]);
export type WorkspaceChange = typeof WorkspaceChangeSchema.Type;

export const WorkspaceReducerAnswerSchema = S.Struct({
  changes: S.Array(WorkspaceChangeSchema),
});
export type WorkspaceReducerAnswer = typeof WorkspaceReducerAnswerSchema.Type;

/**
 * Queued plugin action: tag for routing, payload is the Encoded form of the
 * registration's Schema (validated by the plugin builder; decoded once at run).
 */
export type QueuedPluginAction = {
  readonly _tag: string;
  readonly payload: JsonValue;
};

/**
 * What the sync apply path needs after the Effect stage. No Schema closures —
 * only the answer and declaration facts.
 */
export interface PluginCommandApply {
  readonly changes: readonly WorkspaceChange[];
  /** Absent means result.set is invalid for this command. */
  readonly declaresResult: boolean;
  /** Action tags this command's registration declared. */
  readonly actionTags: ReadonlySet<string>;
  /** Registered pane types (plugin.place / pane.open-plugin). */
  readonly paneTypes: ReadonlySet<string>;
  /** Registered session providers (session.add firstMessage). */
  readonly providers: ReadonlySet<string>;
}

/** Read `_tag` from an action.push value without a cast. */
export const ActionTagSchema = S.Struct({ _tag: S.String });
