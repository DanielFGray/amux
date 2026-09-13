/**
 * Plugin workspace reducer contract: reads and changes as plain Schema data.
 * Core applies the decoded answer synchronously; the reducer never holds a draft.
 *
 * Open fields on the change Schema are {@link JsonValueSchema} — the Encoded
 * side of an owner Schema on the wire. Apply runs owner-supplied closures that
 * close over real Schemas — never `Schema<unknown>`.
 */
import { Result, Schema as S } from "effect";
import { PersistedSessionSchema } from "./session.ts";
import { AgentEntrySchema } from "./read-model.ts";
import { errorMessage } from "./error-message.ts";
import { NonEmptyString } from "./schema-primitives.ts";
import { JsonValueSchema, type JsonValue } from "./effect/AttachProtocol.ts";

export const PLUGIN_REDUCE_TIMEOUT_MS = 2000;

/** Per-call budget for an elected plugin tiling algorithm (same scale as reducers). */
export const PLUGIN_TILING_TIMEOUT_MS = 2000;

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
  window: S.Number,
});
export type WindowRef = typeof WindowRefSchema.Type;

export const ActiveWindowReadSchema = S.Struct({
  space: S.String,
  window: S.Number,
  dir: S.String,
});
export type ActiveWindowRead = typeof ActiveWindowReadSchema.Type;

export const WorkspaceReadPackageSchema = S.Struct({
  activeWindow: S.NullOr(ActiveWindowReadSchema),
  focusedSession: S.NullOr(PersistedSessionSchema),
  sessionsById: S.Record(S.String, PersistedSessionSchema),
  agents: S.Array(AgentEntrySchema),
});
export type WorkspaceReadPackage = typeof WorkspaceReadPackageSchema.Type;

/** Symbolic change ref — tagged so a payload field `{ ref: "main" }` is not a ref. */
export const RefSchema = S.TaggedStruct("WorkspaceRef", {
  ref: S.String,
});
export type ChangeRef = typeof RefSchema.Type;

export const IdOrRefSchema = S.Union([S.String, RefSchema]);
export type IdOrRef = typeof IdOrRefSchema.Type;

const PlaceModeSchema = S.optionalKey(S.Literals(["split", "replace"]));

export const SessionAddChangeSchema = S.TaggedStruct("session.add", {
  ref: S.String,
  target: WindowRefSchema,
  dir: S.String,
  provider: S.optionalKey(S.String),
  id: S.optionalKey(NonEmptyString),
  firstMessage: S.optionalKey(JsonValueSchema),
});

export const SessionPlaceChangeSchema = S.TaggedStruct("session.place", {
  ref: S.optionalKey(S.String),
  target: WindowRefSchema,
  session: IdOrRefSchema,
  mode: PlaceModeSchema,
});

export const PluginPlaceChangeSchema = S.TaggedStruct("plugin.place", {
  ref: S.optionalKey(S.String),
  type: S.String,
  descriptor: JsonValueSchema,
  mode: PlaceModeSchema,
});

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
 * Owner-supplied decode→encode→JsonValue closure. Built by {@link ownerJsonCodec}
 * (and pane-descriptor / action helpers that layer checks on top).
 */
export type OwnerJsonCodec = (raw: JsonValue) => Result.Result<JsonValue, WorkspaceChangeError>;

/** Alias kept for call sites that name a command result codec. */
export type ResultCodec = OwnerJsonCodec;

/**
 * Queued plugin action: tag for routing, payload is the Encoded form of the
 * registration's Schema (validated at apply, decoded once at run).
 */
export type QueuedPluginAction = {
  readonly _tag: string;
  readonly payload: JsonValue;
};

/** Sync validate+re-encode of an action.push value into {@link QueuedPluginAction}. */
export type ActionDecode = (
  encoded: JsonValue,
) => Result.Result<QueuedPluginAction, WorkspaceChangeError>;

export interface PluginCommandApply {
  readonly changes: readonly WorkspaceChange[];
  /** Absent means result.set is invalid for this command. */
  readonly resultCodec: ResultCodec | undefined;
  /** Action tag → sync decode that closes over the payload Schema. */
  readonly actionDecoders: ReadonlyMap<string, ActionDecode>;
  /** Pane type → descriptor codec (decode, encode, size-check). */
  readonly paneDescriptors: ReadonlyMap<string, OwnerJsonCodec>;
  /** Provider id → firstMessage codec. */
  readonly providerMessages: ReadonlyMap<string, OwnerJsonCodec>;
}

/** Close over an owner Schema: decode, encode, confirm JsonValue. */
export const ownerJsonCodec = <A>(schema: S.Codec<A>, label: string): OwnerJsonCodec => {
  return (raw) => {
    const decoded = S.decodeUnknownResult(schema)(raw);
    if (Result.isFailure(decoded)) {
      return Result.fail(
        new WorkspaceChangeError({
          message: `${label}: ${errorMessage(decoded.failure)}`,
        }),
      );
    }
    const encoded = S.encodeUnknownResult(schema)(decoded.success);
    if (Result.isFailure(encoded)) {
      return Result.fail(new WorkspaceChangeError({ message: `${label}: encode failed` }));
    }
    const wire = S.decodeUnknownResult(JsonValueSchema)(encoded.success);
    if (Result.isFailure(wire)) {
      return Result.fail(
        new WorkspaceChangeError({
          message: `${label}: ${errorMessage(wire.failure)}`,
        }),
      );
    }
    return Result.succeed(wire.success);
  };
};

/** Close over a result Schema for the answer wire form. */
export const commandResultCodec = <A>(schema: S.Codec<A>): ResultCodec =>
  ownerJsonCodec(schema, "result.set");

export const isRefLeaf = (value: JsonValue): value is ChangeRef =>
  Result.isSuccess(S.decodeUnknownResult(RefSchema)(value));

export const resolveRefsInJson = (
  value: JsonValue,
  refs: ReadonlyMap<string, string>,
): Result.Result<JsonValue, WorkspaceChangeError> => {
  if (value === null) return Result.succeed(value);
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const resolved = resolveRefsInJson(item, refs);
      if (Result.isFailure(resolved)) return resolved;
      items.push(resolved.success);
    }
    return Result.succeed(items);
  }
  if (typeof value === "object") {
    if (isRefLeaf(value)) {
      const id = refs.get(value.ref);
      if (id === undefined) {
        return Result.fail(new WorkspaceChangeError({ message: `unknown ref '${value.ref}'` }));
      }
      return Result.succeed(id);
    }
    const out: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      const resolved = resolveRefsInJson(child, refs);
      if (Result.isFailure(resolved)) return resolved;
      out[key] = resolved.success;
    }
    return Result.succeed(out);
  }
  return Result.succeed(value);
};

export const resolveIdOrRef = (
  value: IdOrRef,
  refs: ReadonlyMap<string, string>,
): Result.Result<string, WorkspaceChangeError> => {
  if (typeof value === "string") return Result.succeed(value);
  const id = refs.get(value.ref);
  if (id === undefined) {
    return Result.fail(new WorkspaceChangeError({ message: `unknown ref '${value.ref}'` }));
  }
  return Result.succeed(id);
};

/** Read `_tag` from an action.push value without a cast. */
export const ActionTagSchema = S.Struct({ _tag: S.String });
