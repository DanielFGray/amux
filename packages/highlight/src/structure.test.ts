import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { getDataPaths } from "@opentui/core";
import {
  byteColToUtf16Col,
  grammarForFiletype,
  layer as treeSitterLayer,
  TreeSitter,
  utf16ColToByteCol,
  type Grammar,
} from "./structure.ts";

const live = treeSitterLayer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer)),
);

const runtime = ManagedRuntime.make(live);

let typescript: Grammar;
let tsx: Grammar;
let javascript: Grammar;
let html: Grammar;

beforeAll(() =>
  runtime.runPromise(
    Effect.gen(function* () {
      typescript = yield* Effect.flatMap(TreeSitter, (ts) => ts.grammar("typescript"));
      tsx = yield* Effect.flatMap(TreeSitter, (ts) => ts.grammar("typescriptreact"));
      javascript = yield* Effect.flatMap(TreeSitter, (ts) => ts.grammar("javascript"));
      html = yield* Effect.flatMap(TreeSitter, (ts) => ts.grammar("html"));
    }),
  ),
);

afterAll(() => runtime.dispose());

test("grammarForFiletype maps react aliases to jsx-capable grammars", () => {
  expect(grammarForFiletype("typescriptreact")).toBe("tsx");
  expect(grammarForFiletype("javascriptreact")).toBe("javascript");
  expect(grammarForFiletype("rust")).toBe("rust");
});

test("grammar loads requested languages on demand", () => {
  expect(typescript.name).toBe("typescript");
  expect(tsx.name).toBe("tsx");
  expect(javascript.name).toBe("javascript");
});

test("parse fails typed for unknown filetype with no source", () =>
  runtime
    .runPromiseExit(
      Effect.gen(function* () {
        const ts = yield* TreeSitter;
        return yield* ts.grammar("definitely-not-a-lang");
      }),
    )
    .then((exit) => {
      expect(Exit.isFailure(exit)).toBe(true);
    }));

test("nodeAt finds a jsx_element under the cursor in TSX", () => {
  const content = `const el = (
  <div className="a">
    <span>hi</span>
  </div>
);
`;
  const tree = tsx.parse(content);
  expect(tree).not.toBeNull();
  if (tree === null) return;
  try {
    const node = tree.nodeAt(2, 8);
    expect(node).not.toBeNull();
    if (node === null) return;
    const types = [...node.ancestors()].map((n) => n.type);
    expect(types).toContain("jsx_element");
  } finally {
    tree.delete();
  }
});

test("nodeAt UTF-16 columns survive multi-byte characters", () => {
  const line = 'const s = "café";';
  expect(utf16ColToByteCol(line, 11)).toBe(11);
  const afterCafe = utf16ColToByteCol(line, 15);
  expect(byteColToUtf16Col(line, afterCafe)).toBe(15);
  expect(utf16ColToByteCol(line, 15) - utf16ColToByteCol(line, 14)).toBe(2);

  const content = `${line}\n`;
  const tree = typescript.parse(content);
  expect(tree).not.toBeNull();
  if (tree === null) return;
  try {
    const node = tree.nodeAt(0, 12);
    expect(node?.type === "string" || node?.type === "string_fragment").toBe(true);
  } finally {
    tree.delete();
  }
});

test("grammar loads html from cache or download", () => {
  const tree = html.parse("<div><span>x</span></div>");
  expect(tree).not.toBeNull();
  if (tree === null) return;
  try {
    const node = tree.nodeAt(0, 10);
    expect(node).not.toBeNull();
    if (node === null) return;
    const types = [...node.ancestors()].map((n) => n.type);
    expect(types.some((t) => t === "element" || t === "tag_name")).toBe(true);
  } finally {
    tree.delete();
  }
});

test("grammar loads a cached non-catalog grammar (rust) when present", () =>
  runtime
    .runPromiseExit(
      Effect.gen(function* () {
        const ts = yield* TreeSitter;
        return yield* ts.grammar("rust");
      }),
    )
    .then((exit) => {
      if (Exit.isFailure(exit)) return;
      const rust = exit.value;
      const tree = rust.parse("fn main() {}");
      expect(tree).not.toBeNull();
      tree?.delete();
    }));

test("concurrent grammar callers share one load", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const ts = yield* TreeSitter;
      const [a, b] = yield* Effect.all([ts.grammar("typescript"), ts.grammar("typescript")], {
        concurrency: 2,
      });
      expect(a).toBe(b);
    }),
  ));

test("a failed grammar load is not memoized; the next call retries", () => {
  // Expose FS/Path alongside TreeSitter — Layer.provide consumes them from the
  // tree-sitter layer's input, so a plain `live` runtime cannot yield* them.
  const isolated = ManagedRuntime.make(Layer.mergeAll(live, BunFileSystem.layer, BunPath.layer));
  return isolated
    .runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const languagesDir = path.join(getDataPaths().globalDataPath, "tree-sitter", "languages");
        const wasmPath = path.join(languagesDir, "tree-sitter-tsx.wasm");
        const hadFile = yield* fs.exists(wasmPath);
        const original = hadFile ? yield* fs.readFile(wasmPath) : null;
        yield* fs.makeDirectory(languagesDir, { recursive: true });
        yield* fs.writeFile(wasmPath, Buffer.from("not-a-wasm"));
        const ts = yield* TreeSitter;
        const first = yield* Effect.exit(ts.grammar("typescriptreact"));
        expect(Exit.isFailure(first)).toBe(true);
        if (original !== null) yield* fs.writeFile(wasmPath, original);
        else yield* fs.remove(wasmPath);
        const second = yield* ts.grammar("typescriptreact");
        expect(second.name).toBe("tsx");
        if (original !== null) yield* fs.writeFile(wasmPath, original);
      }),
    )
    .finally(() => isolated.dispose());
});
