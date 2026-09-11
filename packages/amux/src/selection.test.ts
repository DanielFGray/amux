/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { RenderState, Terminal } from "./ghostty.ts";
import { captureRange } from "./shim.ts";
import { clearSelection, setSelection } from "./shim.ts";
import { project } from "./harness.ts";
import { makeLayout } from "./layout.ts";
import { testEffect } from "./test-effect.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

test("selection uses screen coordinates through scrollback", () => {
  const term = new Terminal(10, 3, 100);
  term.write(bytes("old\r\nvisible\r\nlast\r\nnew"));
  expect(term.scrollbar.offset).toBe(1);
  setSelection(term.handle, 0, 0, 2, 0);
  expect(
    new TextDecoder().decode(
      captureRange(term.handle, {
        startTag: 2,
        startX: 0,
        startY: 0,
        endTag: 2,
        endX: 2,
        endY: 0,
      }),
    ),
  ).toBe("old");
  clearSelection(term.handle);
  term.free();
});

test("render state reports selected cells without losing wide graphemes", () => {
  const term = new Terminal(12, 2);
  term.write(bytes("A\u30a2B"));
  setSelection(term.handle, 1, 0, 2, 0);
  const state = new RenderState();
  state.update(term);
  const selected: string[] = [];
  state.forEachCell((_x, _y, text, _fg, _bg, _width, isSelected) => {
    if (isSelected) selected.push(text);
  });
  expect(selected.join("")).toContain("\u30a2");
  clearSelection(term.handle);
  state.free();
  term.free();
});

test("empty selection is cleared instead of copied", () => {
  const term = new Terminal(10, 2);
  term.write(bytes("text"));
  setSelection(term.handle, 1, 0, 1, 0);
  clearSelection(term.handle);
  const state = new RenderState();
  state.update(term);
  let selected = false;
  state.forEachCell((_x, _y, _text, _fg, _bg, _width, value) => {
    selected ||= value;
  });
  expect(selected).toBe(false);
  state.free();
  term.free();
});

testEffect(Layer.empty).live(
  "drag selection copies through the pane and survives pane borders",
  Effect.gen(function* () {
    const scene = yield* project(
      makeLayout({
        root: { type: "pane", id: "pane-1", content: { kind: "pty", session: "s1" }, weight: 1 },
        focus: "pane-1",
      }),
      { width: 30, height: 8 },
    );
    const pane = scene.window.panes[0]!;
    const copied: string[] = [];
    pane.onCopy = (text) => {
      copied.push(text);
      return true;
    };
    pane.session!.term.write(bytes("drag"));
    yield* scene.renderOnce();
    yield* Effect.promise(() =>
      scene.t.mockMouse.drag(pane.x + 1, pane.y + 1, pane.x + 4, pane.y + 1),
    );
    expect(copied).toEqual(["drag"]);
  }),
);
