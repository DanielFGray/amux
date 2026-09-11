import * as FileSystem from "effect/FileSystem";
import { Context, Effect, Option, Schema as S, Stream } from "effect";
import { readDocumentSnapshot } from "@danielfgray/amux/document-client.ts";
import { pathFromDocumentUri } from "@danielfgray/amux/document-uri.ts";

export const DocumentPosition = S.Struct({ line: S.Int, character: S.Int });
export type DocumentPosition = typeof DocumentPosition.Type;

export const DocumentSnapshot = S.Struct({
  uri: S.String,
  language: S.String,
  text: S.String,
  cursor: DocumentPosition,
});
export type DocumentSnapshot = typeof DocumentSnapshot.Type;

export const DocumentRequest = S.Struct({ uri: S.String, language: S.String });
export type DocumentRequest = typeof DocumentRequest.Type;

export class DocumentError extends S.TaggedError<DocumentError>()("DocumentError", {
  message: S.String,
}) {}

export interface LiveDocument {
  readonly uri: string;
  readonly snapshot: Effect.Effect<DocumentSnapshot, DocumentError>;
  readonly changes: Stream.Stream<DocumentSnapshot, DocumentError>;
}

export interface DocumentServiceApi {
  readonly read: (request: DocumentRequest) => Effect.Effect<DocumentSnapshot, DocumentError>;
  readonly changes: (uri: string) => Stream.Stream<DocumentSnapshot, DocumentError>;
  readonly register: (document: LiveDocument) => Effect.Effect<() => void, DocumentError>;
}

/** The live-buffer coeffect consumed by LSP servers and provided by editors. */
export class DocumentService extends Context.Service<DocumentService, DocumentServiceApi>()(
  "amux.lsp/DocumentService",
) {}

export interface DocumentServiceOptions {
  /**
   * When set, an open daemon OpenDocumentStore buffer wins over disk for
   * unregistered URIs — the worker twin of the editor's live provider.
   */
  readonly session?: string;
}

/**
 * A live provider wins while it is registered. Unopened files deliberately use
 * the disk fallback so LSP navigation can work before an editor has a buffer.
 * With `session`, an open store document is preferred over disk on read.
 * Change streams stay live-provider-only (editor registration); store updates
 * reach the editor via DocumentWatch, not a second LSP change channel.
 */
export const makeDocumentService = Effect.fnUntraced(function* (
  options: DocumentServiceOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const live = new Map<string, LiveDocument>();
  const session = options.session;

  const disk = Effect.fnUntraced(function* (request: DocumentRequest) {
    const path = yield* filePath(request.uri);
    const text = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((error) => new DocumentError({ message: String(error) })));
    return {
      uri: request.uri,
      language: request.language,
      text,
      cursor: { line: 0, character: 0 },
    } satisfies DocumentSnapshot;
  });

  const fromStore = (request: DocumentRequest) => {
    if (session === undefined) return Effect.fail(new DocumentError({ message: "no session" }));
    return pathFromDocumentUri(request.uri).pipe(
      Effect.mapError((error) => new DocumentError({ message: error.message })),
      Effect.flatMap((path) =>
        readDocumentSnapshot(session, path).pipe(
          Effect.mapError((error) => new DocumentError({ message: error.message })),
          Effect.flatMap((snap) =>
            Option.match(snap, {
              onNone: () => Effect.fail(new DocumentError({ message: "not open" })),
              onSome: (value) =>
                Effect.succeed({
                  uri: request.uri,
                  language: request.language,
                  text: value.text,
                  cursor: { line: 0, character: 0 },
                } satisfies DocumentSnapshot),
            }),
          ),
        ),
      ),
    );
  };

  const service: DocumentServiceApi = {
    read: (request) =>
      Effect.suspend(() => {
        const provider = live.get(request.uri);
        if (provider) return provider.snapshot;
        return fromStore(request).pipe(Effect.catch(() => disk(request)));
      }),
    changes: (uri) =>
      Stream.unwrap(
        Effect.sync(() => {
          const provider = live.get(uri);
          return provider ? provider.changes : Stream.empty;
        }),
      ),
    register: (document) =>
      Effect.suspend(() => {
        if (live.has(document.uri))
          return Effect.fail(
            new DocumentError({
              message: `document '${document.uri}' already has a live provider`,
            }),
          );
        return Effect.sync(() => {
          live.set(document.uri, document);
          return () => {
            if (live.get(document.uri) === document) live.delete(document.uri);
          };
        });
      }),
  };
  return service;
});

const filePath = (uri: string): Effect.Effect<string, DocumentError> =>
  Effect.try({
    try: () => new URL(uri),
    catch: (error) =>
      new DocumentError({ message: `invalid document URI '${uri}': ${String(error)}` }),
  }).pipe(
    Effect.flatMap((url) => {
      if (url.protocol !== "file:" || (url.host !== "" && url.host !== "localhost"))
        return Effect.fail(new DocumentError({ message: "document URI must be a local file URI" }));
      return Effect.try({
        try: () => decodeURIComponent(url.pathname),
        catch: (error) =>
          new DocumentError({ message: `invalid document URI '${uri}': ${String(error)}` }),
      });
    }),
  );
