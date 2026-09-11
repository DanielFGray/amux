/**
 * Document URIs on the control plane are either `file:` URLs or absolute paths.
 * Relative paths are the caller's job to resolve before open.
 */
import { Effect, Schema as S } from "effect";

export class DocumentUriError extends S.TaggedError<DocumentUriError>()("DocumentUriError", {
  message: S.String,
}) {}

export const pathFromDocumentUri = (uri: string): Effect.Effect<string, DocumentUriError> => {
  if (!uri.startsWith("file:")) {
    if (!uri.startsWith("/")) {
      return Effect.fail(
        new DocumentUriError({
          message: `document URI must be absolute or file: (got '${uri}')`,
        }),
      );
    }
    return Effect.succeed(uri);
  }
  return Effect.try({
    try: () => new URL(uri),
    catch: (error) =>
      new DocumentUriError({ message: `invalid document URI '${uri}': ${String(error)}` }),
  }).pipe(
    Effect.flatMap((url) => {
      if (url.protocol !== "file:" || (url.host !== "" && url.host !== "localhost")) {
        return Effect.fail(
          new DocumentUriError({ message: "document URI must be a local file URI" }),
        );
      }
      return Effect.try({
        try: () => decodeURIComponent(url.pathname),
        catch: (error) =>
          new DocumentUriError({
            message: `invalid document URI '${uri}': ${String(error)}`,
          }),
      });
    }),
  );
};

export const fileUriFromPath = (path: string): string => {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  return `file://${encodeURI(absolute)}`;
};
