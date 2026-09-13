import { Schema as S } from "effect";

/** Typed failure from plugin activate (conversion, validation, load policy). */
export class PluginActivateError extends S.TaggedError<PluginActivateError>()(
  "PluginActivateError",
  { message: S.String },
) {}
