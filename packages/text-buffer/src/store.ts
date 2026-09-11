/**
 * In-memory open-document authority keyed by URI.
 *
 * Deliberately a plain class (like PasteBuffers): no Effect lifecycle. The
 * daemon owns one instance; editor and agent clients reach it over RPC later.
 * Disk I/O stays outside — callers supply text on open and persist on save.
 */
import { Option, Result, Schema as S } from "effect";
import {
  applyEdits,
  byteLength,
  charCount,
  empty,
  fromText,
  lineCount,
  sliceLines,
  toText,
  type TextBuffer,
  type TextEdit,
  TextBufferError,
} from "./buffer.ts";

export class DocumentStoreError extends S.TaggedError<DocumentStoreError>()("DocumentStoreError", {
  operation: S.String,
  message: S.String,
}) {}

export interface DocumentMeta {
  readonly uri: string;
  readonly generation: number;
  readonly dirty: boolean;
  readonly lineCount: number;
  /** UTF-8 byte length of serialized `toText` — O(1) from the SumTree summary. */
  readonly byteLength: number;
  /** UTF-16 length of serialized `toText` — O(1) from the SumTree summary. */
  readonly charCount: number;
  readonly refs: number;
}

export interface DocumentSnapshot extends DocumentMeta {
  readonly text: string;
}

type Entry = {
  buffer: TextBuffer;
  generation: number;
  dirty: boolean;
  refs: number;
};

export class OpenDocumentStore {
  readonly #docs = new Map<string, Entry>();
  readonly #listeners = new Set<(snapshot: DocumentSnapshot) => void>();

  /** Subscribe to content/dirty/generation changes. Returns unsubscribe. */
  subscribe(listener: (snapshot: DocumentSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Open or re-enter a URI. First open loads `text`; later opens bump refs. */
  open(uri: string, text?: string): DocumentMeta {
    const existing = this.#docs.get(uri);
    if (existing !== undefined) {
      existing.refs += 1;
      return this.#meta(uri, existing);
    }
    const buffer = text === undefined ? empty() : fromText(text);
    const entry: Entry = { buffer, generation: 1, dirty: false, refs: 1 };
    this.#docs.set(uri, entry);
    this.#emit(uri, entry);
    return this.#meta(uri, entry);
  }

  /**
   * Apply edits if `baseGeneration` matches. Stale bases fail so clients rebase.
   * Marks dirty and bumps generation on success.
   */
  apply(
    uri: string,
    baseGeneration: number,
    edits: readonly TextEdit[],
  ): Result.Result<DocumentMeta, DocumentStoreError | TextBufferError> {
    const entry = this.#docs.get(uri);
    if (entry === undefined) {
      return Result.fail(
        new DocumentStoreError({ operation: "apply", message: `document '${uri}' is not open` }),
      );
    }
    if (entry.generation !== baseGeneration) {
      return Result.fail(
        new DocumentStoreError({
          operation: "apply",
          message: `stale generation ${baseGeneration} (current ${entry.generation})`,
        }),
      );
    }
    return applyEdits(entry.buffer, edits).pipe(
      Result.map((buffer) => {
        entry.buffer = buffer;
        entry.generation += 1;
        entry.dirty = true;
        this.#emit(uri, entry);
        return this.#meta(uri, entry);
      }),
    );
  }

  /** Replace entire contents (agent `write` / full buffer set). Still generation-checked. */
  write(
    uri: string,
    baseGeneration: number,
    text: string,
  ): Result.Result<DocumentMeta, DocumentStoreError> {
    const entry = this.#docs.get(uri);
    if (entry === undefined) {
      return Result.fail(
        new DocumentStoreError({ operation: "write", message: `document '${uri}' is not open` }),
      );
    }
    if (entry.generation !== baseGeneration) {
      return Result.fail(
        new DocumentStoreError({
          operation: "write",
          message: `stale generation ${baseGeneration} (current ${entry.generation})`,
        }),
      );
    }
    entry.buffer = fromText(text);
    entry.generation += 1;
    entry.dirty = true;
    this.#emit(uri, entry);
    return Result.succeed(this.#meta(uri, entry));
  }

  meta(uri: string): Option.Option<DocumentMeta> {
    const entry = this.#docs.get(uri);
    return entry === undefined ? Option.none() : Option.some(this.#meta(uri, entry));
  }

  snapshot(uri: string): Option.Option<DocumentSnapshot> {
    const entry = this.#docs.get(uri);
    if (entry === undefined) return Option.none();
    return Option.some({ ...this.#meta(uri, entry), text: toText(entry.buffer) });
  }

  sliceLines(uri: string, start: number, end: number): Option.Option<readonly string[]> {
    const entry = this.#docs.get(uri);
    if (entry === undefined) return Option.none();
    return Option.some(sliceLines(entry.buffer, start, end));
  }

  /** Caller persists `text`; we clear dirty. */
  markSaved(uri: string): Result.Result<DocumentMeta, DocumentStoreError> {
    const entry = this.#docs.get(uri);
    if (entry === undefined) {
      return Result.fail(
        new DocumentStoreError({ operation: "save", message: `document '${uri}' is not open` }),
      );
    }
    entry.dirty = false;
    this.#emit(uri, entry);
    return Result.succeed(this.#meta(uri, entry));
  }

  textForSave(uri: string): Option.Option<string> {
    const entry = this.#docs.get(uri);
    return entry === undefined ? Option.none() : Option.some(toText(entry.buffer));
  }

  close(
    uri: string,
    options?: { readonly force?: boolean },
  ): Result.Result<void, DocumentStoreError> {
    const entry = this.#docs.get(uri);
    if (entry === undefined) {
      return Result.fail(
        new DocumentStoreError({ operation: "close", message: `document '${uri}' is not open` }),
      );
    }
    if (entry.dirty && options?.force !== true && entry.refs <= 1) {
      return Result.fail(
        new DocumentStoreError({
          operation: "close",
          message: `document '${uri}' has unsaved changes`,
        }),
      );
    }
    entry.refs -= 1;
    if (entry.refs <= 0) {
      this.#docs.delete(uri);
    }
    return Result.succeed(undefined);
  }

  list(): readonly DocumentMeta[] {
    return [...this.#docs.entries()].map(([uri, entry]) => this.#meta(uri, entry));
  }

  #emit(uri: string, entry: Entry): void {
    if (this.#listeners.size === 0) return;
    const snapshot: DocumentSnapshot = { ...this.#meta(uri, entry), text: toText(entry.buffer) };
    for (const listener of this.#listeners) listener(snapshot);
  }

  #meta(uri: string, entry: Entry): DocumentMeta {
    return {
      uri,
      generation: entry.generation,
      dirty: entry.dirty,
      lineCount: lineCount(entry.buffer),
      byteLength: byteLength(entry.buffer),
      charCount: charCount(entry.buffer),
      refs: entry.refs,
    };
  }
}
