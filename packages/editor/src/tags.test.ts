import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { TreeSitter, treeSitterLayer, type Grammar } from "@danielfgray/amux-highlight";
import { findTagAt, tagDelimiters, tagTextObjectRange } from "./tags.ts";

const live = treeSitterLayer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer)),
);
const runtime = ManagedRuntime.make(live);

let tsx: Grammar;
let html: Grammar;

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
    }),
);

afterAll(() => runtime.dispose());

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

test("tagDelimiters builds open/close from the typed prompt", () => {
  expect(Option.getOrThrow(tagDelimiters("div"))).toEqual({ open: "<div>", close: "</div>" });
  expect(Option.getOrThrow(tagDelimiters('div className="x"'))).toEqual({
    open: '<div className="x">',
    close: "</div>",
  });
  expect(Option.isNone(tagDelimiters(""))).toBe(true);
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

test("findTagAt is none when grammar is absent", () => {
  const lines = ["<div>hi</div>"];
  expect(Option.isNone(findTagAt(lines, { row: 0, col: 2 }, Option.none()))).toBe(true);
});
