/**
 * In-process tree-sitter for structural editor ops (tag surround, textobjects).
 *
 * OpenTUI's worker only returns highlight ranges — the AST never leaves it —
 * so tag algebra cannot share that tree. This module loads language wasm on
 * the main thread and answers sync queries once a grammar is ready.
 *
 * Loading is on-demand per filetype: `ensureStructure()` only boots the
 * runtime; `ensureGrammar(filetype)` resolves bundled → cache → download
 * (pinned URL catalog) and memoizes the Language. Opening a file kicks
 * `ensureGrammar` so the first `dst` is usually sync.
 *
 * Positions on the public surface use UTF-16 columns (editor cursors).
 * Internally tree-sitter points use UTF-8 byte columns within each line.
 */
import { createRequire } from "node:module";
// Path.Path-service adoption is a repo-wide policy decision tracked separately;
// this module only needs join/dirname for wasm paths, not an Effect Path service
// resolved at import time.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";
import { Effect } from "effect";
import * as Http from "effect/unstable/http";
import { getDataPaths } from "@opentui/core";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

export type StructurePoint = {
  readonly row: number;
  /** UTF-16 code unit column, matching the editor cursor. */
  readonly col: number;
};

export type StructureNode = {
  readonly type: string;
  readonly start: StructurePoint;
  readonly end: StructurePoint;
  readonly text: string;
  readonly childCount: number;
  child: (index: number) => StructureNode | null;
  namedChild: (index: number) => StructureNode | null;
  parent: () => StructureNode | null;
  /** Walk this node then parents, innermost first. */
  ancestors: () => Iterable<StructureNode>;
};

export type StructureTree = {
  readonly content: string;
  readonly filetype: string;
  /** Raw web-tree-sitter tree — kept for descendant lookup. */
  readonly _tree: Tree;
};

const require = createRequire(import.meta.url);

/**
 * Filetype → grammar wasm stem. `typescriptreact` needs `tsx` — OpenTUI's
 * bundled `typescript` wasm has almost no JSX nodes (highlighting aliases
 * react → typescript, fine for colors, wrong for tag algebra).
 * Everything else falls through to the filetype name (cache's `rust` →
 * `tree-sitter-rust.wasm`).
 */
const GRAMMAR_BY_FILETYPE = {
  javascript: "javascript",
  javascriptreact: "javascript",
  typescript: "typescript",
  typescriptreact: "tsx",
  html: "html",
  htm: "html",
} as const satisfies Record<string, string>;

/**
 * Download URLs for grammars we may need that are not OpenTUI-bundled.
 * Cache hits (including grammars other tooling already fetched into
 * `globalDataPath/tree-sitter/languages`) skip the network entirely.
 * Typescript release pin matches OpenTUI's parsers-config.ts.
 */
const GRAMMAR_DOWNLOAD_URL = {
  tsx: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
  html: "https://github.com/tree-sitter/tree-sitter-html/releases/download/v0.23.2/tree-sitter-html.wasm",
} as const satisfies Record<string, string>;

const languages = new Map<string, Language>();
/** In-flight loads so concurrent ensureGrammar calls share one fetch. */
const loading = new Map<string, Promise<boolean>>();
let initPromise: Promise<void> | null = null;
let parser: Parser | null = null;

const languagesDir = (): string =>
  join(getDataPaths().globalDataPath, "tree-sitter", "languages");

export const grammarForFiletype = (filetype: string): string => {
  if (Object.hasOwn(GRAMMAR_BY_FILETYPE, filetype)) {
    return GRAMMAR_BY_FILETYPE[filetype as keyof typeof GRAMMAR_BY_FILETYPE];
  }
  return filetype;
};

const resolveRuntimeWasm = (): Promise<string> => {
  const pkg = dirname(require.resolve("web-tree-sitter/package.json"));
  const wasmPath = join(pkg, "tree-sitter.wasm");
  return Bun.file(wasmPath)
    .exists()
    .then((ok) => {
      if (!ok) throw new Error(`missing web-tree-sitter runtime at ${wasmPath}`);
      return wasmPath;
    });
};

const resolveBundledGrammarWasm = (grammar: string): Promise<string | null> => {
  if (grammar !== "javascript" && grammar !== "typescript") return Promise.resolve(null);
  try {
    const coreRoot = dirname(require.resolve("@opentui/core/package.json"));
    const wasmPath = join(coreRoot, "assets", grammar, `tree-sitter-${grammar}.wasm`);
    return Bun.file(wasmPath)
      .exists()
      .then((ok) => (ok ? wasmPath : null));
  } catch {
    return Promise.resolve(null);
  }
};

const resolveCachedGrammarWasm = (grammar: string): Promise<string | null> => {
  const wasmPath = join(languagesDir(), `tree-sitter-${grammar}.wasm`);
  return Bun.file(wasmPath)
    .exists()
    .then((ok) => (ok ? wasmPath : null));
};

/** Bundled → cache. Does not download. */
const resolveLocalGrammarWasm = (grammar: string): Promise<string | null> =>
  resolveBundledGrammarWasm(grammar).then((local) => local ?? resolveCachedGrammarWasm(grammar));

/** Fetch a grammar into the OpenTUI language cache when we have a pinned URL. */
const downloadGrammarWasm = (grammar: string): Promise<string | null> => {
  if (!Object.hasOwn(GRAMMAR_DOWNLOAD_URL, grammar)) return Promise.resolve(null);
  const url = GRAMMAR_DOWNLOAD_URL[grammar as keyof typeof GRAMMAR_DOWNLOAD_URL];
  const dir = languagesDir();
  Bun.spawnSync(["mkdir", "-p", dir]);
  const dest = join(dir, `tree-sitter-${grammar}.wasm`);
  return Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* Http.HttpClient.get(url);
      if (response.status !== 200) return null;
      const bytes = yield* response.arrayBuffer;
      yield* Effect.promise(() => Bun.write(dest, new Uint8Array(bytes)));
      return dest;
    }).pipe(
      Effect.provide(Http.FetchHttpClient.layer),
      Effect.orElseSucceed(() => null),
    ),
  );
};

const wrapNode = (node: Node, content: string): StructureNode => {
  const start = pointFromTreeSitter(content, node.startPosition.row, node.startPosition.column);
  const end = pointFromTreeSitter(content, node.endPosition.row, node.endPosition.column);
  return {
    type: node.type,
    start,
    end,
    text: node.text,
    childCount: node.childCount,
    child: (index) => {
      const child = node.child(index);
      return child === null ? null : wrapNode(child, content);
    },
    namedChild: (index) => {
      const child = node.namedChild(index);
      return child === null ? null : wrapNode(child, content);
    },
    parent: () => {
      const parent = node.parent;
      return parent === null ? null : wrapNode(parent, content);
    },
    ancestors: function* () {
      let current: Node | null = node;
      while (current !== null) {
        yield wrapNode(current, content);
        current = current.parent;
      }
    },
  };
};

/** UTF-16 column → tree-sitter byte column on the same line. */
export const utf16ColToByteCol = (line: string, col: number): number => {
  const clamped = Math.max(0, Math.min(col, line.length));
  return Buffer.byteLength(line.slice(0, clamped), "utf8");
};

/** Tree-sitter byte column → UTF-16 column on the same line. */
export const byteColToUtf16Col = (line: string, byteCol: number): number => {
  const buf = Buffer.from(line, "utf8");
  const clamped = Math.max(0, Math.min(byteCol, buf.length));
  return buf.subarray(0, clamped).toString("utf8").length;
};

const lineAt = (content: string, row: number): string => {
  const lines = content.split("\n");
  return lines[row] ?? "";
};

const pointFromTreeSitter = (content: string, row: number, byteCol: number): StructurePoint => ({
  row,
  col: byteColToUtf16Col(lineAt(content, row), byteCol),
});

/** Boot the web-tree-sitter runtime only — no grammars yet. */
export const ensureStructure = (): Promise<void> => {
  if (initPromise !== null) return initPromise;
  initPromise = resolveRuntimeWasm()
    .then((runtimeWasm) =>
      Parser.init({
        locateFile: () => runtimeWasm,
      }),
    )
    .then(() => {
      parser = new Parser();
    })
    .catch((error) => {
      initPromise = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
  return initPromise;
};

/**
 * On-demand load of the grammar for `filetype`. Safe to call repeatedly;
 * concurrent callers share one promise. Returns false when no local wasm
 * exists and no download URL is registered (or the download fails).
 */
export const ensureGrammar = (filetype: string): Promise<boolean> => {
  const grammar = grammarForFiletype(filetype);
  if (languages.has(grammar)) return Promise.resolve(true);

  const inflight = loading.get(grammar);
  if (inflight !== undefined) return inflight;

  const promise = ensureStructure()
    .then((): Promise<boolean> => {
      if (languages.has(grammar)) return Promise.resolve(true);
      return resolveLocalGrammarWasm(grammar).then((local) => {
        const wasmPromise = local !== null ? Promise.resolve(local) : downloadGrammarWasm(grammar);
        return wasmPromise.then((wasmPath) => {
          if (wasmPath === null) return false;
          return Language.load(wasmPath)
            .then((language) => {
              languages.set(grammar, language);
              return true;
            })
            .catch(() => false);
        });
      });
    })
    .finally(() => {
      loading.delete(grammar);
    });

  loading.set(grammar, promise);
  return promise;
};

/** Whether sync parseStructure can succeed for this filetype right now. */
export const structureReady = (filetype: string): boolean => {
  if (parser === null) return false;
  return languages.has(grammarForFiletype(filetype));
};

/**
 * Sync parse. Returns null when the runtime/grammar is not loaded yet —
 * call `ensureGrammar(filetype)` first (file-open path) so keypresses stay sync.
 */
export const parseStructure = (content: string, filetype: string): StructureTree | null => {
  if (parser === null) return null;
  const grammar = grammarForFiletype(filetype);
  const language = languages.get(grammar);
  if (language === undefined) return null;
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (tree === null) return null;
  return { content, filetype, _tree: tree };
};

/** Innermost node containing the UTF-16 cursor, or null. */
export const nodeAt = (tree: StructureTree, row: number, col: number): StructureNode | null => {
  const line = lineAt(tree.content, row);
  const byteCol = utf16ColToByteCol(line, col);
  const node = tree._tree.rootNode.descendantForPosition({ row, column: byteCol });
  return node === null ? null : wrapNode(node, tree.content);
};

/** Test/reset hook — drops languages so the next ensure reloads. */
export const resetStructureForTests = (): void => {
  languages.clear();
  loading.clear();
  parser = null;
  initPromise = null;
};
