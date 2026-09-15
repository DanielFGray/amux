/**
 * Integration: highlight StructureGrammar drives the vim engine's tag/surround path.
 * Lives in the editor package so @danielfgray/amux-vim never imports highlight.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { TreeSitter, treeSitterLayer } from "@danielfgray/amux-highlight";
import type { StructureGrammar } from "@danielfgray/amux-vim";
import {
  bufferFromLines,
  findTagAt,
  initialEditor,
  linesOf,
  reduceEditor,
  tagTextObjectRange,
  type EditorState,
  type Key,
} from "@danielfgray/amux-vim";

const live = treeSitterLayer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer)),
);
const runtime = ManagedRuntime.make(live);

let tsx: StructureGrammar;
let html: StructureGrammar;
let tsxGrammar: StructureGrammar;

beforeAll(() =>
  runtime
    .runPromise(
      Effect.gen(function* () {
        const ts = yield* TreeSitter;
        return {
          tsx: yield* ts.grammar("typescriptreact"),
          html: yield* ts.grammar("html"),
        };
      }),
    )
    .then((loaded) => {
      tsx = loaded.tsx;
      html = loaded.html;
      tsxGrammar = loaded.tsx;
    }),
);

afterAll(() => runtime.dispose());

function key(name: string, extra: Partial<Key> = {}): Key {
  return {
    name,
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    sequence: name,
    ...extra,
  };
}

function typeKeys(state: EditorState, keys: Array<string | Key>): EditorState {
  let current = state;
  for (const entry of keys) {
    const event = typeof entry === "string" ? key(entry) : entry;
    current = reduceEditor(current, { _tag: "key", key: event });
  }
  return current;
}

function text(state: EditorState): string {
  return linesOf(state.buffer).join("\n");
}

test("findTagAt picks the innermost jsx_element", () => {
  const lines = ["<div>", "  <span>hi</span>", "</div>"];
  const inner = Option.getOrThrow(findTagAt(lines, { row: 1, col: 6 }, Option.some(tsx)));
  expect(inner.name).toBe("span");
  expect(inner.open).toBe("<span>");
  expect(inner.close).toBe("</span>");
  expect(inner.selfClosing).toBe(false);

  const outer = Option.getOrThrow(findTagAt(lines, { row: 1, col: 1 }, Option.some(tsx)));
  expect(outer.name).toBe("div");
});

test("findTagAt handles self-closing jsx", () => {
  const lines = ['<div><img src="x" /></div>'];
  const match = Option.getOrThrow(findTagAt(lines, { row: 0, col: 8 }, Option.some(tsx)));
  expect(match.selfClosing).toBe(true);
  expect(match.name).toBe("img");
  expect(match.close).toBe("");
});

test("findTagAt works for html filetype", () => {
  const lines = ["<div id=a><span>x</span></div>"];
  const match = Option.getOrThrow(findTagAt(lines, { row: 0, col: 14 }, Option.some(html)));
  expect(match.name).toBe("span");
  expect(match.open).toBe("<span>");
});

test("tagTextObjectRange it/at", () => {
  const lines = ["<div>", "  hi", "</div>"];
  const inner = Option.getOrThrow(
    tagTextObjectRange(lines, { row: 1, col: 2 }, Option.some(tsx), true),
  );
  expect(inner.from).toEqual({ row: 0, col: 5 });
  expect(inner.to).toEqual({ row: 2, col: 0 });

  const outer = Option.getOrThrow(
    tagTextObjectRange(lines, { row: 1, col: 2 }, Option.some(tsx), false),
  );
  expect(outer.from).toEqual({ row: 0, col: 0 });
  expect(outer.to).toEqual({ row: 2, col: 6 });

  const self = tagTextObjectRange(lines, { row: 0, col: 0 }, Option.some(tsx), true);
  expect(Option.isSome(self)).toBe(true);
});

test("dst deletes surrounding JSX tags", () => {
  const start: EditorState = {
    ...initialEditor(),
    file: "Widget.tsx",
    grammar: tsxGrammar,
    buffer: bufferFromLines(["<div>", "  hi", "</div>"]),
    cursor: { row: 1, col: 2 },
  };
  const deleted = typeKeys(start, ["d", "s", "t"]);
  expect(text(deleted)).toBe("\n  hi\n");
  expect(deleted.pendingSurround).toBeNull();
});

test("cstdiv> changes surrounding JSX tag name", () => {
  const start: EditorState = {
    ...initialEditor(),
    file: "Widget.tsx",
    grammar: tsxGrammar,
    buffer: bufferFromLines(["<span>hi</span>"]),
    cursor: { row: 0, col: 6 },
  };
  const changed = typeKeys(start, ["c", "s", "t", "d", "i", "v", ">"]);
  expect(text(changed)).toBe("<div>hi</div>");
});

test("ysiwtspan> wraps the inner word in a tag", () => {
  const start: EditorState = {
    ...initialEditor(),
    file: "Widget.tsx",
    grammar: tsxGrammar,
    buffer: bufferFromLines(["hello world"]),
    cursor: { row: 0, col: 0 },
  };
  const wrapped = typeKeys(start, ["y", "s", "i", "w", "t", "s", "p", "a", "n", ">"]);
  expect(text(wrapped)).toBe("<span>hello</span> world");
});

test("dit deletes inner tag contents; dat deletes the whole element", () => {
  const start: EditorState = {
    ...initialEditor(),
    file: "Widget.tsx",
    grammar: tsxGrammar,
    buffer: bufferFromLines(["<div>hello</div>"]),
    cursor: { row: 0, col: 6 },
  };
  const inner = typeKeys(start, ["d", "i", "t"]);
  expect(text(inner)).toBe("<div></div>");

  const outerStart: EditorState = {
    ...initialEditor(),
    file: "Widget.tsx",
    grammar: tsxGrammar,
    buffer: bufferFromLines(["<div>hello</div>"]),
    cursor: { row: 0, col: 6 },
  };
  const outer = typeKeys(outerStart, ["d", "a", "t"]);
  expect(text(outer)).toBe("");
});
