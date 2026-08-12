/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createSessionViews } from "./session-views.tsx";

test("pane types reject duplicate registrations and dispose by identity", () => {
  const views = createSessionViews();
  const dispose = views.register("native", () => <text>native</text>);
  expect(views.has("native")).toBe(true);
  expect(() => views.register("native", () => <text>other</text>)).toThrow("already registered");
  dispose();
  expect(views.has("native")).toBe(false);
});
