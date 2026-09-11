import { Array as Arr, Effect, Match, Option, PubSub, Result, Stream } from "effect";
import {
  languageForPath,
  type DocumentSnapshot,
  type LanguageCatalog,
  type LiveDocument,
  type LspCompletion,
  type LspCompletionList,
  type LspDiagnostic,
  type LspDocumentClient,
  type LspDocumentSymbol,
  type LspHover,
  type LspLocation,
  type LspSignatureHelp,
  type LspTextEdit,
  type LspWorkspaceEdit,
  type MarkedString,
  type LspServiceApi,
  type DocumentServiceApi,
} from "@danielfgray/amux-plugin-lsp";
import { applyEdits, type TextEdit } from "@danielfgray/amux-text-buffer";
import type { EditorState } from "./schema.ts";
import { lineAtRow, setBuffer } from "./buffer-state.ts";
import { finishChange, startChange } from "./history.ts";
import { pushJump } from "./jumps.ts";

/** Absolute path → LSP document URI. */
export const fileUri = (absolutePath: string): string => {
  const path = absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`;
  return `file://${encodeURI(path)}`;
};

/** Sync decode of a local `file:` URI (or absolute path) for jump targets. */
export const pathFromUri = (uri: string): Option.Option<string> => {
  if (!uri.startsWith("file:")) {
    return uri.startsWith("/") ? Option.some(uri) : Option.none();
  }
  const parseUrl = Option.liftThrowable((value: string) => new URL(value));
  const decodePath = Option.liftThrowable((value: string) => decodeURIComponent(value));
  return Option.flatMap(parseUrl(uri), (url) => {
    if (url.protocol !== "file:" || (url.host !== "" && url.host !== "localhost")) {
      return Option.none();
    }
    return decodePath(url.pathname);
  });
};

const markedStringText = (marked: MarkedString | { readonly value: string }): string =>
  Match.value(marked).pipe(
    Match.when(Match.string, (text) => text),
    Match.orElse((obj) => obj.value),
  );

const isMarkedStringList = (
  contents: LspHover["contents"],
): contents is readonly MarkedString[] => Arr.isArray(contents);

/** Flatten already-decoded hover contents for the floating popup. */
export const hoverText = (contents: LspHover["contents"]): string =>
  Match.value(contents).pipe(
    Match.when(isMarkedStringList, (items) =>
      items.map(markedStringText).filter(Boolean).join("\n"),
    ),
    Match.orElse(markedStringText),
  );

export const diagnosticsSummary = (diagnostics: readonly LspDiagnostic[]): string => {
  if (diagnostics.length === 0) return "";
  const errors = diagnostics.filter((d) => d.severity === 1).length;
  const warnings = diagnostics.filter((d) => d.severity === 2).length;
  if (errors > 0 && warnings > 0) return `[${errors}E ${warnings}W]`;
  if (errors > 0) return `[${errors} error${errors === 1 ? "" : "s"}]`;
  if (warnings > 0) return `[${warnings} warning${warnings === 1 ? "" : "s"}]`;
  return `[${diagnostics.length} diag]`;
};

const isCompletionList = (completion: LspCompletion): completion is LspCompletionList =>
  "items" in completion;

/** Labels from an already-decoded completion list or item array. */
export const completionLabels = (completion: LspCompletion): readonly string[] =>
  Match.value(completion).pipe(
    Match.when(isCompletionList, (list) => list.items.map((item) => item.label)),
    Match.orElse((items) => items.map((item) => item.label)),
  );

/** Normalize definition's single-or-array response. */
const isLocationList = (
  value: LspLocation | readonly LspLocation[],
): value is readonly LspLocation[] => Arr.isArray(value);

export const asLocations = (value: LspLocation | readonly LspLocation[]): readonly LspLocation[] =>
  Match.value(value).pipe(
    Match.when(isLocationList, (locs) => locs),
    Match.orElse((loc) => [loc]),
  );

/** Picker row label: `path:line:col`. */
export const locationLabel = (
  location: LspLocation,
  workspace: Option.Option<string> = Option.none(),
): string => {
  const path = Option.getOrElse(pathFromUri(location.uri), () => location.uri);
  const relative = Option.match(workspace, {
    onNone: () => path,
    onSome: (root) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path),
  });
  const { line, character } = location.range.start;
  return `${relative}:${line + 1}:${character + 1}`;
};

const isWordChar = (char: string): boolean => /[A-Za-z0-9_]/.test(char);

/** Identifier under the cursor — default text for `grn` rename. */
export const wordAtCursor = (state: EditorState): Option.Option<string> => {
  const line = lineAtRow(state.buffer, state.cursor.row);
  if (line.length === 0) return Option.none();
  let col = Math.min(state.cursor.col, Math.max(0, line.length - 1));
  if (!isWordChar(line[col]!)) {
    if (col > 0 && isWordChar(line[col - 1]!)) col -= 1;
    else return Option.none();
  }
  let start = col;
  let end = col + 1;
  while (start > 0 && isWordChar(line[start - 1]!)) start -= 1;
  while (end < line.length && isWordChar(line[end]!)) end += 1;
  return Option.some(line.slice(start, end));
};

/** Flatten WorkspaceEdit into per-URI TextEdit lists (`changes` + documentChanges). */
export const editsByUri = (edit: LspWorkspaceEdit): ReadonlyMap<string, readonly LspTextEdit[]> => {
  const out = new Map<string, LspTextEdit[]>();
  const add = (uri: string, edits: readonly LspTextEdit[]) => {
    const prev = out.get(uri) ?? [];
    out.set(uri, [...prev, ...edits]);
  };
  Option.match(Option.fromNullishOr(edit.changes), {
    onNone: () => undefined,
    onSome: (changes) => {
      for (const [uri, edits] of Object.entries(changes)) add(uri, edits);
    },
  });
  Option.match(Option.fromNullishOr(edit.documentChanges), {
    onNone: () => undefined,
    onSome: (changes) => {
      for (const change of changes) add(change.textDocument.uri, change.edits);
    },
  });
  return out;
};

/** Apply LSP text edits to the current buffer (same URI only). */
export const applyBufferEdits = (
  state: EditorState,
  edits: readonly LspTextEdit[],
): Option.Option<EditorState> => {
  if (edits.length === 0) return Option.some(state);
  const mapped: readonly TextEdit[] = edits.map((edit) => ({
    range: edit.range,
    newText: edit.newText,
  }));
  return Result.match(applyEdits(state.buffer, mapped), {
    onFailure: () => Option.none(),
    onSuccess: (buffer) =>
      Option.some(finishChange(setBuffer(startChange(state, ["grn"]), buffer, mapped))),
  });
};

/**
 * Same-file: jump list + cursor. Other file: jump list + `open` request with
 * landing cursor. Lives beside the LSP bridge so vim-core stays free of LSP.
 */
export const applyGoto = (
  state: EditorState,
  path: string,
  row: number,
  col: number,
): EditorState => {
  const cursor = { row: Math.max(0, row), col: Math.max(0, col) };
  const jumped = {
    ...state,
    mapKeys: [],
    jumpList: pushJump(state.jumpList, state.cursor),
    count: "",
    message: null,
  };
  if (state.file !== null && state.file === path) {
    return { ...jumped, cursor, request: null };
  }
  return {
    ...jumped,
    request: { _tag: "open", path, row: cursor.row, col: cursor.col },
  };
};

export interface EditorLspServices {
  readonly documents: DocumentServiceApi;
  readonly lsp: LspServiceApi;
  readonly catalog: LanguageCatalog;
}

export interface BufferCursor {
  readonly row: number;
  readonly col: number;
}

/**
 * Register the editor buffer as the live DocumentService provider and acquire
 * an LspDocumentClient for the file's language. No-ops (none) when the catalog
 * has no language for the path.
 */
export const attachEditorDocument = Effect.fnUntraced(function* (options: {
  readonly services: EditorLspServices;
  readonly file: string;
  readonly workspace: string;
  readonly snapshot: () => {
    readonly lines: readonly string[];
    readonly cursor: BufferCursor;
  };
  readonly changes: PubSub.PubSub<DocumentSnapshot>;
  readonly onDiagnostics: (diagnostics: readonly LspDiagnostic[]) => void;
}) {
  return yield* Option.match(languageForPath(options.services.catalog, options.file), {
    onNone: () => Effect.succeed(Option.none<LspDocumentClient>()),
    onSome: (languageId) =>
      Effect.gen(function* () {
        const uri = fileUri(options.file);
        const snapshotOf = (): DocumentSnapshot => {
          const state = options.snapshot();
          return {
            uri,
            language: languageId,
            text: state.lines.join("\n"),
            cursor: { line: state.cursor.row, character: state.cursor.col },
          };
        };

        const live: LiveDocument = {
          uri,
          snapshot: Effect.sync(snapshotOf),
          changes: Stream.fromPubSub(options.changes),
        };
        const release = yield* options.services.documents.register(live);
        yield* Effect.addFinalizer(() => Effect.sync(release));

        const client = yield* options.services.lsp.acquire({
          uri,
          language: languageId,
          workspace: options.workspace,
        });

        yield* Effect.forkScoped(
          client.diagnostics.pipe(
            Stream.runForEach((batch) => Effect.sync(() => options.onDiagnostics(batch))),
          ),
        );

        return Option.some(client);
      }),
  });
});

export const publishBufferChange = (
  changes: PubSub.PubSub<DocumentSnapshot>,
  snapshot: DocumentSnapshot,
) => PubSub.publish(changes, snapshot);

const comparePos = (
  a: { readonly line: number; readonly character: number },
  b: { readonly line: number; readonly character: number },
): number => (a.line !== b.line ? a.line - b.line : a.character - b.character);

const sortedDiagnostics = (diagnostics: readonly LspDiagnostic[]): readonly LspDiagnostic[] =>
  [...diagnostics].sort((a, b) => comparePos(a.range.start, b.range.start));

/**
 * Jump target among published diagnostics. Cite: neovim `vim.diagnostic.jump`
 * (`]d`/`[d` wrap; `]D`/`[D` first/last).
 */
export function jumpDiagnostic(
  diagnostics: readonly LspDiagnostic[],
  cursor: { readonly row: number; readonly col: number },
  kind: "next" | "prev" | "first" | "last",
  count = 1,
): Option.Option<{ readonly row: number; readonly col: number }> {
  const sorted = sortedDiagnostics(diagnostics);
  if (sorted.length === 0) return Option.none();
  if (kind === "first") {
    const d = sorted[0]!;
    return Option.some({ row: d.range.start.line, col: d.range.start.character });
  }
  if (kind === "last") {
    const d = sorted[sorted.length - 1]!;
    return Option.some({ row: d.range.start.line, col: d.range.start.character });
  }

  const cursorPos = { line: cursor.row, character: cursor.col };
  const times = Math.max(1, count);
  if (kind === "next") {
    let idx = sorted.findIndex((d) => comparePos(d.range.start, cursorPos) > 0);
    if (idx < 0) idx = 0; // wrap
    const d = sorted[(idx + times - 1) % sorted.length]!;
    return Option.some({ row: d.range.start.line, col: d.range.start.character });
  }
  // prev
  let idx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (comparePos(sorted[i]!.range.start, cursorPos) < 0) {
      idx = i;
      break;
    }
  }
  if (idx < 0) idx = sorted.length - 1; // wrap
  const d = sorted[(idx - (times - 1) + sorted.length * times) % sorted.length]!;
  return Option.some({ row: d.range.start.line, col: d.range.start.character });
}

/** Diagnostic covering the cursor, else the nearest on the same line. */
export function diagnosticAtCursor(
  diagnostics: readonly LspDiagnostic[],
  cursor: { readonly row: number; readonly col: number },
): Option.Option<LspDiagnostic> {
  const onLine = diagnostics.filter((d) => d.range.start.line === cursor.row);
  const covering = onLine.find(
    (d) =>
      d.range.start.character <= cursor.col &&
      (d.range.end.line > cursor.row || d.range.end.character >= cursor.col),
  );
  if (covering) return Option.some(covering);
  if (onLine.length > 0) {
    return Option.some(
      [...onLine].sort(
        (a, b) =>
          Math.abs(a.range.start.character - cursor.col) -
          Math.abs(b.range.start.character - cursor.col),
      )[0]!,
    );
  }
  return Option.none();
}

export const formatDiagnostic = (d: LspDiagnostic): string => {
  const sev =
    d.severity === 1 ? "Error" : d.severity === 2 ? "Warn" : d.severity === 3 ? "Info" : "Hint";
  const src = d.source !== undefined ? `${d.source}: ` : "";
  return `${sev}: ${src}${d.message}`;
};

/** Flatten document symbols (and children) to jump locations for `gO`. */
export function flattenDocumentSymbols(
  uri: string,
  symbols: readonly LspDocumentSymbol[],
): readonly LspLocation[] {
  const out: LspLocation[] = [];
  const walk = (items: readonly LspDocumentSymbol[]) => {
    for (const sym of items) {
      out.push({ uri, range: sym.selectionRange });
      if (sym.children !== undefined && sym.children.length > 0) walk(sym.children);
    }
  };
  walk(symbols);
  return out;
}

/** Flatten signature help into hover-like text. */
export const signatureHelpText = (help: LspSignatureHelp): string => {
  const idx = Math.min(
    Math.max(0, help.activeSignature ?? 0),
    Math.max(0, help.signatures.length - 1),
  );
  const sig = help.signatures[idx];
  if (sig === undefined) return "";
  const docs =
    sig.documentation === undefined
      ? ""
      : typeof sig.documentation === "string"
        ? `\n${sig.documentation}`
        : "value" in sig.documentation
          ? `\n${sig.documentation.value}`
          : "";
  return `${sig.label}${docs}`;
};
