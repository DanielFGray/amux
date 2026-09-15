/**
 * Control-plane helpers for the daemon OpenDocumentStore.
 * Used by the harness worker and the editor so disk writes do not bypass an
 * open buffer. Keystroke sync uses {@link applyDocumentEdits} / {@link replaceDocument}
 * (no disk); agent `write` and `:w` use {@link writeDocument} / {@link saveDocument}.
 */
import { Effect, Option, Scope, Stream } from "effect";
import type { DocumentMeta, DocumentSnapshot, TextEdit } from "@danielfgray/amux-text-buffer";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { connectControl, controlCall, toControlError } from "./control-client.ts";
import type { ControlError } from "./control.ts";
import { fileUriFromPath } from "./document-uri.ts";

/** Open (or re-enter) a document. Without `text`, loads from disk on first open. */
export const openDocument = (
  session: string,
  absolutePath: string,
  text?: string,
): Effect.Effect<DocumentMeta, ControlError> => {
  const uri = fileUriFromPath(absolutePath);
  return controlCall(session, (control) => control.DocumentOpen({ uri, text })).pipe(
    Effect.mapError(toControlError),
  );
};

/** The control calls a document replace makes. */
export interface DocumentControl {
  readonly DocumentSnapshot: (input: {
    readonly uri: string;
  }) => Effect.Effect<DocumentMeta & { readonly text: string }, ControlError | RpcClientError>;
  readonly DocumentOpen: (input: {
    readonly uri: string;
  }) => Effect.Effect<DocumentMeta, ControlError | RpcClientError>;
  readonly DocumentWrite: (input: {
    readonly uri: string;
    readonly baseGeneration: number;
    readonly text: string;
  }) => Effect.Effect<DocumentMeta, ControlError | RpcClientError>;
}

const currentGeneration = (control: DocumentControl, uri: string) =>
  control.DocumentSnapshot({ uri }).pipe(
    Effect.map((snap) => snap.generation),
    Effect.catch(() => control.DocumentOpen({ uri }).pipe(Effect.map((meta) => meta.generation))),
  );

/**
 * Replace buffer contents on an open control client without persisting. One
 * stale-generation rebase retry keeps a coalesced keystroke flush from losing
 * to an agent write.
 */
export const replaceDocumentOn = (
  control: DocumentControl,
  absolutePath: string,
  text: string,
  baseGeneration?: number,
): Effect.Effect<DocumentMeta, ControlError | RpcClientError> => {
  const uri = fileUriFromPath(absolutePath);
  return Effect.gen(function* () {
    const generation =
      baseGeneration === undefined ? yield* currentGeneration(control, uri) : baseGeneration;
    return yield* control.DocumentWrite({ uri, baseGeneration: generation, text }).pipe(
      Effect.catch((error) => {
        if (!String(error).includes("stale generation")) return Effect.fail(error);
        return currentGeneration(control, uri).pipe(
          Effect.flatMap((next) => control.DocumentWrite({ uri, baseGeneration: next, text })),
        );
      }),
    );
  });
};

/**
 * Replace buffer contents without persisting. One stale-generation rebase
 * retry keeps a coalesced keystroke flush from losing to an agent write.
 */
export const replaceDocument = (
  session: string,
  absolutePath: string,
  text: string,
  baseGeneration?: number,
): Effect.Effect<DocumentMeta, ControlError> =>
  controlCall(session, (control) =>
    replaceDocumentOn(control, absolutePath, text, baseGeneration),
  ).pipe(Effect.mapError(toControlError));

/** Persist the open buffer to disk and clear dirty. */
export const saveDocument = (
  session: string,
  absolutePath: string,
): Effect.Effect<DocumentMeta, ControlError> => {
  const uri = fileUriFromPath(absolutePath);
  return controlCall(session, (control) => control.DocumentSave({ uri })).pipe(
    Effect.mapError(toControlError),
  );
};

/** Drop an open document (force clears dirty). Used when a patch deletes a file. */
export const closeDocument = (
  session: string,
  absolutePath: string,
  force = true,
): Effect.Effect<void, ControlError> => {
  const uri = fileUriFromPath(absolutePath);
  return controlCall(session, (control) => control.DocumentClose({ uri, force })).pipe(
    Effect.mapError(toControlError),
  );
};

/** Replace the whole document through the store and persist to disk. */
export const writeDocument = (
  session: string,
  absolutePath: string,
  text: string,
): Effect.Effect<DocumentMeta, ControlError> => {
  const uri = fileUriFromPath(absolutePath);
  return controlCall(session, (control) =>
    Effect.gen(function* () {
      const generation = yield* currentGeneration(control, uri);
      yield* control.DocumentWrite({ uri, baseGeneration: generation, text });
      return yield* control.DocumentSave({ uri });
    }),
  ).pipe(Effect.mapError(toControlError));
};

/**
 * Apply LSP-shaped edits without persisting. Keystroke-sync counterpart to
 * {@link replaceDocument}. Use {@link writeDocument} / {@link saveDocument}
 * when the buffer must hit disk.
 */
export const applyDocumentEdits = (
  session: string,
  absolutePath: string,
  edits: readonly TextEdit[],
  baseGeneration?: number,
): Effect.Effect<DocumentMeta, ControlError> => {
  const uri = fileUriFromPath(absolutePath);
  return controlCall(session, (control) =>
    Effect.gen(function* () {
      const generation =
        baseGeneration === undefined ? yield* currentGeneration(control, uri) : baseGeneration;
      return yield* control
        .DocumentApply({
          uri,
          baseGeneration: generation,
          edits: [...edits],
        })
        .pipe(
          Effect.catch((error) => {
            if (!String(error).includes("stale generation")) return Effect.fail(error);
            return currentGeneration(control, uri).pipe(
              Effect.flatMap((next) =>
                control.DocumentApply({
                  uri,
                  baseGeneration: next,
                  edits: [...edits],
                }),
              ),
            );
          }),
        );
    }),
  ).pipe(Effect.mapError(toControlError));
};

export const readDocumentSnapshot = (
  session: string,
  absolutePath: string,
): Effect.Effect<Option.Option<DocumentSnapshot>, ControlError> => {
  const uri = fileUriFromPath(absolutePath);
  return controlCall(session, (control) =>
    control.DocumentSnapshot({ uri }).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none()),
    ),
  ).pipe(Effect.mapError(toControlError));
};

/** Prefer an open store buffer; otherwise `None` so the caller can fall back to disk. */
export const readOpenDocumentText = (
  session: string,
  absolutePath: string,
): Effect.Effect<Option.Option<string>, ControlError> =>
  readDocumentSnapshot(session, absolutePath).pipe(Effect.map(Option.map((snap) => snap.text)));

/**
 * Live snapshots for one path (or every open document when `absolutePath` is
 * omitted). Owns the control connection for the enclosing scope — same lifetime
 * rule as {@link controlEvents}.
 */
export const documentWatch = (
  session: string,
  absolutePath?: string,
): Effect.Effect<Stream.Stream<DocumentSnapshot, RpcClientError>, ControlError, Scope.Scope> => {
  const uri = absolutePath === undefined ? undefined : fileUriFromPath(absolutePath);
  return Effect.map(connectControl(session), (control) =>
    control.DocumentWatch(uri === undefined ? {} : { uri }),
  );
};
