/**
 * In-process tree-sitter for structural editor ops (tag surround, textobjects).
 *
 * OpenTUI's worker only returns highlight ranges — the AST never leaves it —
 * so tag algebra cannot share that tree. This service owns the runtime Parser
 * in a scope and loads language wasm on demand (bundled → cache → pinned URL).
 *
 * Positions on the public surface use UTF-16 columns (editor cursors).
 * Internally tree-sitter points use UTF-8 byte columns within each line.
 *
 * Trees hold wasm memory: callers must `delete()` a StructureTree when done.
 * `findTagAt` owns the tree for the duration of one query.
 */
import { createRequire } from "node:module";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Schema as S,
  SynchronizedRef,
  type Scope,
} from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { getDataPaths } from "@opentui/core";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";
import type {
  StructureGrammar,
  StructureNode,
  StructurePoint,
  StructureTree,
} from "@danielfgray/amux-vim";

export class RuntimeWasmMissing extends S.TaggedError<RuntimeWasmMissing>()("RuntimeWasmMissing", {
  path: S.String,
}) {}

export class GrammarSourceMissing extends S.TaggedError<GrammarSourceMissing>()(
  "GrammarSourceMissing",
  { grammar: S.String },
) {}

export class GrammarDownloadFailed extends S.TaggedError<GrammarDownloadFailed>()(
  "GrammarDownloadFailed",
  {
    grammar: S.String,
    url: S.String,
    status: S.optionalKey(S.Finite),
  },
) {}

export class GrammarWasmLoadFailed extends S.TaggedError<GrammarWasmLoadFailed>()(
  "GrammarWasmLoadFailed",
  {
    grammar: S.String,
    path: S.String,
  },
) {}

export type GrammarUnavailable =
  | GrammarSourceMissing
  | GrammarDownloadFailed
  | GrammarWasmLoadFailed;

export interface TreeSitterService {
  /**
   * Resolve bundled → cache → pinned download, memoized per grammar stem.
   * Concurrent callers share one load.
   */
  readonly grammar: (filetype: string) => Effect.Effect<StructureGrammar, GrammarUnavailable>;
}

export class TreeSitter extends Context.Service<TreeSitter, TreeSitterService>()(
  "amux/TreeSitter",
) {}

const require = createRequire(import.meta.url);

/**
 * Filetype → grammar wasm stem. `typescriptreact` needs `tsx` — OpenTUI's
 * bundled `typescript` wasm has almost no JSX nodes (highlighting aliases
 * react → typescript, fine for colors, wrong for tag algebra).
 * Everything else falls through to the filetype name (cache's `rust` →
 * `tree-sitter-rust.wasm`).
 */
const GRAMMAR_BY_FILETYPE = new Map<string, string>([
  ["javascript", "javascript"],
  ["javascriptreact", "javascript"],
  ["typescript", "typescript"],
  ["typescriptreact", "tsx"],
  ["html", "html"],
  ["htm", "html"],
]);

/**
 * Download URLs for grammars we may need that are not OpenTUI-bundled.
 * Cache hits (including grammars other tooling already fetched into
 * `globalDataPath/tree-sitter/languages`) skip the network entirely.
 * Typescript release pin matches OpenTUI's parsers-config.ts.
 */
const GRAMMAR_DOWNLOAD_URL = new Map<string, string>([
  [
    "tsx",
    "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
  ],
  [
    "html",
    "https://github.com/tree-sitter/tree-sitter-html/releases/download/v0.23.2/tree-sitter-html.wasm",
  ],
]);

export const grammarForFiletype = (filetype: string): string =>
  GRAMMAR_BY_FILETYPE.get(filetype) ?? filetype;

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

const wrapNode = (node: Node, content: string): StructureNode => {
  const start = pointFromTreeSitter(content, node.startPosition.row, node.startPosition.column);
  const end = pointFromTreeSitter(content, node.endPosition.row, node.endPosition.column);
  return {
    id: node.id,
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

const makeStructureTree = (content: string, tree: Tree): StructureTree => {
  let live: Tree | null = tree;
  const root = wrapNode(tree.rootNode, content);
  return {
    content,
    root,
    nodeAt: (row, col) => {
      if (live === null) return null;
      const line = lineAt(content, row);
      const byteCol = utf16ColToByteCol(line, col);
      const node = live.rootNode.descendantForPosition({ row, column: byteCol });
      return node === null ? null : wrapNode(node, content);
    },
    delete: () => {
      if (live === null) return;
      live.delete();
      live = null;
    },
  };
};

const make: Effect.Effect<
  TreeSitterService,
  RuntimeWasmMissing,
  Scope.Scope | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;

  const pkgRoot = (pkg: string): Option.Option<string> => {
    try {
      return Option.some(pathSvc.dirname(require.resolve(`${pkg}/package.json`)));
    } catch {
      return Option.none();
    }
  };

  const runtimeWasm = yield* Option.match(pkgRoot("web-tree-sitter"), {
    onNone: () => Effect.fail(new RuntimeWasmMissing({ path: "web-tree-sitter" })),
    onSome: (root) => Effect.succeed(pathSvc.join(root, "tree-sitter.wasm")),
  });
  const runtimeExists = yield* fs
    .exists(runtimeWasm)
    .pipe(Effect.mapError(() => new RuntimeWasmMissing({ path: runtimeWasm })));
  if (!runtimeExists) {
    return yield* new RuntimeWasmMissing({ path: runtimeWasm });
  }

  yield* Effect.tryPromise({
    try: () =>
      Parser.init({
        locateFile: () => runtimeWasm,
      }),
    catch: () => new RuntimeWasmMissing({ path: runtimeWasm }),
  });

  const parser = new Parser();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      parser.delete();
    }),
  );

  const languagesDir = pathSvc.join(getDataPaths().globalDataPath, "tree-sitter", "languages");

  /** In-flight / completed loads. Failed attempts are removed so the next
   *  open retries; concurrent callers share one Deferred. */
  const loads = yield* SynchronizedRef.make(
    new Map<string, Deferred.Deferred<StructureGrammar, GrammarUnavailable>>(),
  );

  const resolveBundled = (grammar: string): Effect.Effect<Option.Option<string>> => {
    if (grammar !== "javascript" && grammar !== "typescript") {
      return Effect.succeed(Option.none());
    }
    return Option.match(pkgRoot("@opentui/core"), {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (coreRoot) => {
        const wasmPath = pathSvc.join(coreRoot, "assets", grammar, `tree-sitter-${grammar}.wasm`);
        return fs.exists(wasmPath).pipe(
          Effect.map((ok) => (ok ? Option.some(wasmPath) : Option.none())),
          Effect.orElseSucceed(() => Option.none()),
        );
      },
    });
  };

  const resolveCached = (grammar: string): Effect.Effect<Option.Option<string>> => {
    const wasmPath = pathSvc.join(languagesDir, `tree-sitter-${grammar}.wasm`);
    return fs.exists(wasmPath).pipe(
      Effect.map((ok) => (ok ? Option.some(wasmPath) : Option.none())),
      Effect.orElseSucceed(() => Option.none()),
    );
  };

  const download = (
    grammar: string,
  ): Effect.Effect<string, GrammarSourceMissing | GrammarDownloadFailed> => {
    const url = GRAMMAR_DOWNLOAD_URL.get(grammar);
    if (url === undefined) {
      return Effect.fail(new GrammarSourceMissing({ grammar }));
    }
    const dest = pathSvc.join(languagesDir, `tree-sitter-${grammar}.wasm`);
    return Effect.gen(function* () {
      yield* fs.makeDirectory(languagesDir, { recursive: true }).pipe(
        Effect.mapError(
          () =>
            new GrammarDownloadFailed({
              grammar,
              url,
            }),
        ),
      );
      const response = yield* HttpClient.get(url).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError(
          () =>
            new GrammarDownloadFailed({
              grammar,
              url,
            }),
        ),
      );
      if (response.status !== 200) {
        return yield* new GrammarDownloadFailed({
          grammar,
          url,
          status: response.status,
        });
      }
      const bytes = yield* response.arrayBuffer.pipe(
        Effect.mapError(
          () =>
            new GrammarDownloadFailed({
              grammar,
              url,
              status: response.status,
            }),
        ),
      );
      yield* fs.writeFile(dest, new Uint8Array(bytes)).pipe(
        Effect.mapError(
          () =>
            new GrammarDownloadFailed({
              grammar,
              url,
              status: response.status,
            }),
        ),
      );
      return dest;
    });
  };

  const loadLanguage = (
    grammar: string,
    wasmPath: string,
  ): Effect.Effect<Language, GrammarWasmLoadFailed> =>
    Effect.tryPromise({
      try: () => Language.load(wasmPath),
      catch: () => new GrammarWasmLoadFailed({ grammar, path: wasmPath }),
    });

  const doLoad = (grammar: string): Effect.Effect<StructureGrammar, GrammarUnavailable> =>
    Effect.gen(function* () {
      const local = yield* resolveBundled(grammar).pipe(
        Effect.flatMap((bundled) =>
          Option.match(bundled, {
            onSome: (p) => Effect.succeed(Option.some(p)),
            onNone: () => resolveCached(grammar),
          }),
        ),
      );
      const wasmPath = yield* Option.match(local, {
        onSome: (p) => Effect.succeed(p),
        onNone: () => download(grammar),
      });
      const language = yield* loadLanguage(grammar, wasmPath);
      return {
        name: grammar,
        parse: (content) => {
          parser.setLanguage(language);
          const tree = parser.parse(content);
          if (tree === null) return null;
          return makeStructureTree(content, tree);
        },
      } satisfies StructureGrammar;
    });

  const grammar = Effect.fnUntraced(function* (filetype: string) {
    const name = grammarForFiletype(filetype);
    // One Deferred per attempt: the winner of this modify runs doLoad; losers
    // await the same Deferred. Failures delete the slot so the next open retries.
    const candidate = yield* Deferred.make<StructureGrammar, GrammarUnavailable>();
    const shared = yield* SynchronizedRef.modify(loads, (map) => {
      const hit = map.get(name);
      if (hit !== undefined) return [hit, map] as const;
      const next = new Map(map);
      next.set(name, candidate);
      return [candidate, next] as const;
    });
    if (shared !== candidate) {
      return yield* Deferred.await(shared);
    }
    const exit = yield* Effect.exit(doLoad(name));
    if (Exit.isSuccess(exit)) {
      yield* Deferred.succeed(candidate, exit.value);
      return exit.value;
    }
    yield* SynchronizedRef.update(loads, (map) => {
      if (map.get(name) !== candidate) return map;
      const next = new Map(map);
      next.delete(name);
      return next;
    });
    yield* Deferred.failCause(candidate, exit.cause);
    return yield* Effect.failCause(exit.cause);
  });

  return { grammar } satisfies TreeSitterService;
});

export const layer: Layer.Layer<
  TreeSitter,
  RuntimeWasmMissing,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> = Layer.effect(TreeSitter, make);
