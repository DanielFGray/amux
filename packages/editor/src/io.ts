/**
 * The editor's filesystem surface, declared as an `Effect` `Service`.
 *
 * The plugin builds the live implementation at activation
 * (`plugin.tsx`'s `buildEditorIo`), publishes it for future consumers,
 * and hands the same instance to the pane view through its props — so
 * the pane and any future consumer read through one instance.
 * A test swaps in an in-memory version (`./test/io.ts`) by mounting
 * the view directly, the way the bench already does.
 *
 * `PlatformError` flows through the typed error channel rather than
 * surfacing as a stringified `Error`, which was the original
 * `Effect.runPromise` smell.
 */
import { Context, Effect, Schema as S } from "effect";
import { PlatformError } from "effect/PlatformError";

export const EditorDescriptor = S.Struct({ file: S.String });
export type EditorDescriptor = S.Schema.Type<typeof EditorDescriptor>;

export const EditorDescriptorOrNull = S.NullOr(EditorDescriptor);
export type EditorDescriptorOrNull = S.Schema.Type<typeof EditorDescriptorOrNull>;

export const EditorReadResult = S.Struct({
  file: S.String,
  lines: S.Array(S.String),
});
export type EditorReadResult = S.Schema.Type<typeof EditorReadResult>;

export interface EditorIoService {
  readonly read: (file: string, spaceDir: string) => Effect.Effect<EditorReadResult, PlatformError>;
  readonly write: (
    file: string,
    lines: readonly string[],
    spaceDir: string,
  ) => Effect.Effect<void, PlatformError>;
  readonly resolve: (spaceDir: string, path: string) => Effect.Effect<string, never>;
}

export class EditorIo extends Context.Service<EditorIo, EditorIoService>()("amux.editor/Io") {}
