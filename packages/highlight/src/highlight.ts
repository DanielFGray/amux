/**
 * Shared tree-sitter highlighting for the editor and the agent harness.
 *
 * OpenTUI already ships the whole stack — a worker-based `TreeSitterClient`,
 * filetype detection, highlight queries, and `SyntaxStyle` — so this package
 * is a scoped wrapper, not a parser. Two shapes share one worker client:
 *
 * - buffers (`open`/`update`/`close` + `subscribe`): the editor mirrors its
 *   open files and publishes per-line chunks per keystroke;
 * - `snapshot`: one-shot highlights for static content (chat code fences),
 *   with no buffer lifecycle at all.
 *
 * Process rules every consumer inherits. Buffer ids come from a module-level
 * counter, so two providers in one process never collide on the shared
 * singleton client. The worker itself is process-lifetime: `shutdown` closes
 * buffers and destroys the style table but never destroys the client, since
 * a sibling provider may still use it. Unknown filetypes and every client
 * failure degrade to plain text — highlighting must never break its host.
 */
import { Context, Effect, Scope } from "effect";
import {
  getTreeSitterClient,
  infoStringToFiletype,
  pathToFiletype,
  SyntaxStyle,
  treeSitterToTextChunks,
  type FiletypeParserOptions,
  type HighlightRange,
  type HighlightResponse,
  type SimpleHighlight,
  type TextChunk,
} from "@opentui/core";
import { theme } from "@danielfgray/amux";

/** Per-line styled chunks, keyed by buffer row. */
export type LineChunks = ReadonlyMap<number, readonly TextChunk[]>;

export type HighlightListener = (file: string, version: number, chunks: LineChunks) => void;

/** The view-side snapshot contract: static content in, styled rows out.
 *  Views take this as a prop (bound to a runtime at the plugin boundary)
 *  so components never touch Effect or the worker directly. */
export type HighlightSnapshot = (content: string, filetype: string) => Promise<LineChunks | null>;

/** A fence info string (`ts`, `py`, …) to the filetype the parsers know.
 *  Undefined means render plain — untagged and unknown fences included. */
export const filetypeForInfo = (info: string): string | undefined =>
  info === "" ? undefined : infoStringToFiletype(info);

/**
 * The `TreeSitterClient` surface the provider uses. The real client satisfies
 * this structurally; tests hand in a fake. Buffer updates go through
 * `resetBuffer` — a debounced full re-parse in the worker — rather than
 * `updateBuffer`: incremental edits need exact tree-sitter `Edit` ranges,
 * and with empty edits the worker silently answers nothing. The re-parse
 * runs off-fiber, so keystrokes never wait for colors.
 */
export interface HighlightClient {
  initialize(): Promise<void>;
  createBuffer(id: number, content: string, filetype: string): Promise<unknown>;
  resetBuffer(bufferId: number, version: number, content: string): Promise<void>;
  removeBuffer(bufferId: number): Promise<void>;
  addFiletypeParser(parser: FiletypeParserOptions): void;
  highlightOnce(
    content: string,
    filetype: string,
  ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }>;
  on(
    event: "highlights:response",
    listener: (bufferId: number, version: number, highlights: HighlightResponse[]) => void,
  ): unknown;
  off(
    event: "highlights:response",
    listener: (bufferId: number, version: number, highlights: HighlightResponse[]) => void,
  ): unknown;
}

export interface HighlightProviderService {
  readonly open: (file: string, content: string) => Effect.Effect<void>;
  readonly update: (file: string, content: string) => Effect.Effect<void>;
  readonly close: (file: string) => Effect.Effect<void>;
  readonly subscribe: (listener: HighlightListener) => () => void;
  /** One-shot highlights for static content. Null when the filetype is
   *  unknown or the client fails — the caller renders plain text. */
  readonly snapshot: (content: string, filetype: string) => Effect.Effect<LineChunks | null>;
  /** Tear down this provider's buffers and style table. An Effect value
   *  rather than a thunk — Effect is already lazy. Never destroys the
   *  shared worker client. */
  readonly shutdown: Effect.Effect<void>;
}

export class HighlightProvider extends Context.Service<
  HighlightProvider,
  HighlightProviderService
>()("amux.highlight/Highlight") {}

/**
 * Token colors from the app's own Catppuccin Mocha table, so highlighted
 * code cannot drift from the chrome palette. Only base groups are
 * registered — `getStyle` falls back from `keyword.import` to `keyword`.
 */
const TOKEN_STYLES = {
  keyword: { fg: theme.mauve },
  string: { fg: theme.green },
  comment: { fg: theme.overlay1 },
  function: { fg: theme.blue },
  method: { fg: theme.blue },
  type: { fg: theme.yellow },
  constant: { fg: theme.peach },
  number: { fg: theme.peach },
  boolean: { fg: theme.peach },
  operator: { fg: theme.subtext0 },
  punctuation: { fg: theme.overlay1 },
  variable: { fg: theme.text },
  property: { fg: theme.blue },
} as const;

interface OpenBuffer {
  readonly id: number;
  version: number;
  content: string;
}

/** Process-wide buffer ids: every provider instance draws from this counter
 *  so two providers sharing the singleton client never collide. */
let nextBufferId = 1;

/** Build the provider against a client. The default is the process-wide
 *  singleton; tests inject a fake. `extraParsers` (grammars discovered from
 *  the worker's cache dir) register right after initialization, before any
 *  buffer opens. Initialization is lazy — the worker spawns on the first
 *  open of a known filetype. */
export const makeHighlightProvider = (
  client: HighlightClient = getTreeSitterClient(),
  extraParsers: readonly FiletypeParserOptions[] = [],
): Effect.Effect<HighlightProviderService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const style = SyntaxStyle.fromStyles({ ...TOKEN_STYLES });
    const buffers = new Map<string, OpenBuffer>();
    const listeners = new Set<HighlightListener>();
    let initPromise: Promise<void> | null = null;
    let shut = false;
    let didShutdown = false;

    const ensure = (): Promise<void> => {
      if (initPromise === null) {
        initPromise = client
          .initialize()
          .then(() => {
            for (const parser of extraParsers) client.addFiletypeParser(parser);
          })
          .catch(() => {
            initPromise = null;
          }) as Promise<void>;
      }
      return initPromise;
    };

    const onResponse = (bufferId: number, version: number, responses: HighlightResponse[]) => {
      for (const [file, state] of buffers) {
        if (state.id !== bufferId || state.version !== version) continue;
        const chunks = toLineChunks(state.content, responses, style);
        for (const listener of listeners) listener(file, version, chunks);
      }
    };
    client.on("highlights:response", onResponse);

    const dropBuffer = (file: string): Promise<void> => {
      const state = buffers.get(file);
      if (state === undefined) return Promise.resolve();
      buffers.delete(file);
      return client.removeBuffer(state.id).catch(() => {});
    };

    const open = Effect.fnUntraced(function* (file: string, content: string) {
      if (shut) return;
      yield* Effect.promise(() => dropBuffer(file));
      const filetype = pathToFiletype(file);
      if (filetype === undefined) return;
      yield* Effect.promise(() =>
        ensure()
          .then((): Promise<boolean> => {
            if (shut) return Promise.resolve(false);
            const id = nextBufferId++;
            return client.createBuffer(id, content, filetype).then(() => {
              buffers.set(file, { id, version: 1, content });
              return true;
            });
          })
          .catch(() => false),
      );
    });

    const update = Effect.fnUntraced(function* (file: string, content: string) {
      if (shut) return;
      const state = buffers.get(file);
      if (state === undefined) {
        // Opened before the provider knew it, or a previous failure
        // dropped it — (re)open instead of silently staying plain.
        yield* open(file, content);
        return;
      }
      if (state.content === content) return;
      state.version += 1;
      state.content = content;
      const version = state.version;
      const id = state.id;
      yield* Effect.promise(() =>
        client.resetBuffer(id, version, content).catch(() => dropBuffer(file)),
      );
    });

    const close = (file: string): Effect.Effect<void> => Effect.promise(() => dropBuffer(file));

    const snapshot = (content: string, filetype: string): Effect.Effect<LineChunks | null> =>
      Effect.promise(() =>
        ensure()
          .then(() => client.highlightOnce(content, filetype))
          .then((result) => {
            const highlights = result.highlights ?? [];
            if (highlights.length === 0) return null;
            return splitChunkLines(treeSitterToTextChunks(content, highlights, style));
          })
          .catch(() => null),
      );

    const subscribe = (listener: HighlightListener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };

    const shutdown: Effect.Effect<void> = Effect.promise(() => {
      if (didShutdown) return Promise.resolve();
      didShutdown = true;
      shut = true;
      buffers.clear();
      client.off("highlights:response", onResponse);
      style.destroy();
      return Promise.resolve();
    });

    yield* Effect.addFinalizer(() => shutdown);

    return { open, update, close, subscribe, snapshot, shutdown };
  });

/** Whole-buffer responses sliced into per-line chunks. Ranges outside the
 *  line or overlapping an earlier (higher-priority) range are clamped or
 *  skipped; gaps stay plain so concatenated chunks always equal the line. */
const toLineChunks = (
  content: string,
  responses: readonly HighlightResponse[],
  style: SyntaxStyle,
): LineChunks => {
  const lines = content.split("\n");
  const out = new Map<number, readonly TextChunk[]>();
  for (const response of responses) {
    out.set(response.line, lineChunks(lines[response.line] ?? "", response.highlights, style));
  }
  return out;
};

const lineChunks = (
  line: string,
  ranges: readonly HighlightRange[],
  style: SyntaxStyle,
): readonly TextChunk[] => {
  const sorted = [...ranges].sort((a, b) => a.startCol - b.startCol);
  const chunks: TextChunk[] = [];
  let col = 0;
  for (const range of sorted) {
    const start = Math.max(0, Math.min(range.startCol, line.length));
    const end = Math.max(start, Math.min(range.endCol, line.length));
    if (start > col) chunks.push({ __isChunk: true, text: line.slice(col, start) });
    if (end > col) {
      const text = line.slice(Math.max(col, start), end);
      if (text.length > 0) {
        const fg = styleForGroup(style, range.group)?.fg;
        chunks.push(fg === undefined ? { __isChunk: true, text } : { __isChunk: true, text, fg });
      }
      col = end;
    }
  }
  if (col < line.length) chunks.push({ __isChunk: true, text: line.slice(col) });
  return chunks;
};

/** Flat one-shot chunks re-keyed by row. Empty slices are dropped; a row
 *  with no chunks renders from the raw line, exactly like the buffer path. */
const splitChunkLines = (chunks: readonly TextChunk[]): LineChunks => {
  const out = new Map<number, TextChunk[]>();
  let row = 0;
  for (const chunk of chunks) {
    const parts = chunk.text.split("\n");
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) row++;
      const text = parts[index]!;
      if (text.length === 0) continue;
      let line = out.get(row);
      if (line === undefined) {
        line = [];
        out.set(row, line);
      }
      line.push({ ...chunk, text });
    }
  }
  return out;
};

const styleForGroup = (style: SyntaxStyle, group: string) =>
  style.getStyle(group) ?? (group.includes(".") ? style.getStyle(group.split(".")[0]!) : undefined);
