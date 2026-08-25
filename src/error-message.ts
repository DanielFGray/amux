import { Schema } from "effect";

const ErrorWithMessage = Schema.Struct({ message: Schema.optional(Schema.String) });

/** Preserve structured error messages when a boundary must expose a string. */
export const errorMessage = <T>(error: T): string => {
  if (error instanceof Error) return error.message;
  const parsed = Schema.decodeUnknownOption(ErrorWithMessage)(error);
  if (parsed._tag === "Some" && parsed.value.message !== undefined) return parsed.value.message;
  return String(error);
};
