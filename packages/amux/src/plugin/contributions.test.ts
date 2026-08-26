import { expect, test } from "bun:test";
import { createPluginContributions, type PluginInstance } from "./contributions.ts";

const instance = (id: string, generation: number): PluginInstance => ({ id, generation });

test("a plugin that has not committed has registered nothing anyone can see", () => {
  const contributions = createPluginContributions();
  const views = contributions.table<string>();

  views.add(instance("sidebar", 0), "tree", "first");

  expect(views.get("tree")).toBeUndefined();
  expect(views.all()).toEqual([]);
});

test("committing makes an instance's names visible and drops the generation it replaced", () => {
  const contributions = createPluginContributions();
  const views = contributions.table<string>();
  const first = instance("sidebar", 0);
  const second = instance("sidebar", 1);

  views.add(first, "tree", "first");
  contributions.commit(first);
  views.add(second, "tree", "second");

  expect(views.get("tree")).toBe("first");

  expect(contributions.commit(second)).toEqual([]);
  expect(views.get("tree")).toBe("second");
  expect(views.all().map((entry) => entry.value)).toEqual(["second"]);
});

test("a name another plugin is already showing is refused on the spot", () => {
  const contributions = createPluginContributions();
  const bindings = contributions.table<string>();
  const sidebar = instance("sidebar", 0);

  bindings.add(sidebar, "toggle", "sidebar's");
  contributions.commit(sidebar);

  expect(() => bindings.add(instance("palette", 0), "toggle", "palette's")).toThrow(
    "already registered by 'sidebar'",
  );
});

/**
 * The reason a commit can fail even though every registration was accepted.
 *
 * A new generation claims its names while nobody is reading them, so a name
 * another plugin takes in the meantime was free when it was claimed and is not
 * free when it would become visible. Discovering it then must leave everything
 * as it was, or a reload would take the running version down on its way out.
 */
test("a name taken while an instance was invisible blocks its commit and changes nothing", () => {
  const contributions = createPluginContributions();
  const bindings = contributions.table<string>();
  const running = instance("sidebar", 0);
  const other = instance("palette", 0);
  const next = instance("sidebar", 1);

  bindings.add(running, "toggle", "sidebar's");
  contributions.commit(running);

  bindings.add(next, "toggle", "new sidebar's");
  bindings.add(next, "focus", "new sidebar's");
  bindings.add(other, "focus", "palette's");
  contributions.commit(other);

  expect(contributions.commit(next)).toEqual(["focus"]);
  expect(bindings.get("toggle")).toBe("sidebar's");
  expect(bindings.get("focus")).toBe("palette's");
});

test("two generations of one plugin are not a conflict with each other", () => {
  const contributions = createPluginContributions();
  const panels = contributions.table<string>();
  const first = instance("status", 0);
  const second = instance("status", 1);

  panels.add(first, "bar", "old");
  contributions.commit(first);

  expect(() => panels.add(second, "bar", "new")).not.toThrow();
  expect(contributions.commit(second)).toEqual([]);
});

test("a plugin claiming one name twice is its own bug and is refused", () => {
  const contributions = createPluginContributions();
  const panels = contributions.table<string>();
  const owner = instance("status", 0);

  panels.add(owner, "bar", "one");

  expect(() => panels.add(owner, "bar", "two")).toThrow("registered 'bar' twice");
});

test("conflicts are looked for across every table, not the one being written", () => {
  const contributions = createPluginContributions();
  const panels = contributions.table<string>();
  const bindings = contributions.table<string>();
  const running = instance("sidebar", 0);
  const other = instance("palette", 0);

  panels.add(running, "tree", "sidebar's");
  bindings.add(running, "toggle", "sidebar's");
  bindings.add(other, "toggle", "palette's");
  contributions.commit(other);

  expect(contributions.commit(running)).toEqual(["toggle"]);
  expect(panels.get("tree")).toBeUndefined();
});

test("retiring hides a committed instance without disturbing the others", () => {
  const contributions = createPluginContributions();
  const panels = contributions.table<string>();
  const sidebar = instance("sidebar", 0);
  const status = instance("status", 0);

  panels.add(sidebar, "tree", "sidebar's");
  panels.add(status, "bar", "status's");
  contributions.commit(sidebar);
  contributions.commit(status);

  contributions.retire(sidebar);

  expect(panels.get("tree")).toBeUndefined();
  expect(panels.get("bar")).toBe("status's");
});

test("retiring a generation that is no longer the visible one leaves the visible one alone", () => {
  const contributions = createPluginContributions();
  const panels = contributions.table<string>();
  const first = instance("sidebar", 0);
  const second = instance("sidebar", 1);

  panels.add(first, "tree", "old");
  contributions.commit(first);
  panels.add(second, "tree", "new");
  contributions.commit(second);

  contributions.retire(first);

  expect(panels.get("tree")).toBe("new");
});

test("disposing a registration takes the name back", () => {
  const contributions = createPluginContributions();
  const panels = contributions.table<string>();
  const owner = instance("sidebar", 0);

  const dispose = panels.add(owner, "tree", "sidebar's");
  contributions.commit(owner);
  dispose();

  expect(panels.get("tree")).toBeUndefined();
  expect(panels.all()).toEqual([]);
});
