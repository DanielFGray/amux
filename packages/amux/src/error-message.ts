import { Schema } from "effect";

const ErrorWithMessage = Schema.Struct({ message: Schema.optional(Schema.String) });

/** Preserve structured error messages when a boundary must expose a string. */
export const errorMessage = <T>(error: T): string => {
  // An Error subclass may shadow `message` with a non-string, so every input is decoded.
  const parsed = Schema.decodeUnknownOption(ErrorWithMessage)(error);
  if (parsed._tag === "Some" && parsed.value.message !== undefined) return parsed.value.message;
  return String(error);
};
