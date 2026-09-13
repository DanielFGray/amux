/**
 * Pane-type handle: typed place builder for reducers, Effect check for
 * pane.open-plugin (the only decode-from-raw-JsonValue path).
 */
import { Effect, Schema as S } from "effect";
import { DescriptorSchema } from "./layout.ts";
import { errorMessage } from "./error-message.ts";
import { type JsonValue } from "./effect/AttachProtocol.ts";
import { PluginReducerError, type WorkspaceChange } from "./workspace-changes.ts";
import { encodeOwner } from "./workspace-change-builders.ts";
import type { NewPaneId } from "./workspace-ids.ts";

export type PaneTypeHandle<D> = {
  readonly type: string;
  /** Effect-stage owner check for core pane.open-plugin: decode raw, encode, size-limit. */
  readonly check: (raw: JsonValue) => Effect.Effect<JsonValue, PluginReducerError>;
  readonly place: (
    input:
      | { readonly mode: "split"; readonly pane: NewPaneId; readonly descriptor: D }
      | { readonly mode: "replace"; readonly descriptor: D },
  ) => Effect.Effect<WorkspaceChange, PluginReducerError>;
};

/** Registration entry — type + check for apply; reducer closes over the typed handle. */
export type PaneTypeRegistration = {
  readonly type: string;
  readonly check: (raw: JsonValue) => Effect.Effect<JsonValue, PluginReducerError>;
};

/** Declare a pane type with its descriptor Schema. */
export function definePaneType<D>(type: string, schema: S.Codec<D>): PaneTypeHandle<D> {
  const encode = encodeOwner(schema, `plugin.place '${type}'`);
  const check = (raw: JsonValue): Effect.Effect<JsonValue, PluginReducerError> =>
    Effect.gen(function* () {
      const decoded = yield* S.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError(
          (error) =>
            new PluginReducerError({
              message: `plugin.place '${type}': ${errorMessage(error)}`,
            }),
        ),
      );
      const wire = yield* encode(decoded);
      return yield* S.decodeEffect(DescriptorSchema)(wire).pipe(
        Effect.mapError(
          (error) =>
            new PluginReducerError({
              message: `plugin.place descriptor size for '${type}': ${errorMessage(error)}`,
            }),
        ),
      );
    });

  const place = (
    input:
      | { readonly mode: "split"; readonly pane: NewPaneId; readonly descriptor: D }
      | { readonly mode: "replace"; readonly descriptor: D },
  ): Effect.Effect<WorkspaceChange, PluginReducerError> =>
    Effect.gen(function* () {
      const wire = yield* encode(input.descriptor);
      const sized = yield* S.decodeEffect(DescriptorSchema)(wire).pipe(
        Effect.mapError(
          (error) =>
            new PluginReducerError({
              message: `plugin.place descriptor size for '${type}': ${errorMessage(error)}`,
            }),
        ),
      );
      if (input.mode === "split") {
        return {
          _tag: "plugin.place" as const,
          mode: "split" as const,
          pane: input.pane,
          type,
          descriptor: sized,
        };
      }
      return {
        _tag: "plugin.place" as const,
        mode: "replace" as const,
        type,
        descriptor: sized,
      };
    });

  return { type, check, place };
}
