/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createSessionViews } from "./session-views.tsx";
import { testContributor } from "./test-contributor.ts";
import type { PluginInstance } from "./contributions.ts";

test("a pane type resolves once registered and stops resolving once disposed", () => {
  const { contributions, owner } = testContributor();
  const views = createSessionViews(contributions);

  const dispose = views.register(owner, "native", () => <text>native</text>);
  expect(views.has("native")).toBe(true);

  dispose();
  expect(views.has("native")).toBe(false);
});

test("a second plugin cannot take a pane type another one is showing", () => {
  const { contributions, owner } = testContributor("harness");
  const views = createSessionViews(contributions);
  const other: PluginInstance = { id: "impostor", generation: 0 };

  views.register(owner, "native", () => <text>native</text>);

  expect(() => views.register(other, "native", () => <text>other</text>)).toThrow(
    "already registered by 'harness'",
  );
});

/**
 * What a reload does to a pane that is on screen while it happens.
 *
 * The new run of a plugin claims the pane type its old run still holds. Both
 * registrations exist at once; the pane keeps drawing the committed one until
 * the host commits the new one, and never sees the type go missing.
 */
test("two runs of one plugin may hold a pane type, and the committed one wins", () => {
  const { contributions, owner } = testContributor("harness");
  const views = createSessionViews(contributions);
  const next: PluginInstance = { id: "harness", generation: 1 };

  views.register(owner, "native", () => <text>first</text>);
  const first = views.has("native");

  views.register(next, "native", () => <text>second</text>);
  const duringReload = views.has("native");
  contributions.commit(next);

  expect([first, duringReload, views.has("native")]).toEqual([true, true, true]);
});
