import { expect, test } from "bun:test";
import { CONTEXT_PRIORITY, findContextPriorityConflicts, type ContextSpec } from "./key-context.ts";
import { createPluginContributions, type PluginInstance } from "./plugin/contributions.ts";

const spec = (id: string, priority: number): ContextSpec => ({
  id,
  active: () => true,
  priority,
  rebindable: true,
});

test("priority bands are ordered overlay > app-mode > pane > global", () => {
  expect(CONTEXT_PRIORITY.OVERLAY).toBeGreaterThan(CONTEXT_PRIORITY.APP_MODE);
  expect(CONTEXT_PRIORITY.APP_MODE).toBeGreaterThan(CONTEXT_PRIORITY.PANE);
  expect(CONTEXT_PRIORITY.PANE).toBeGreaterThan(CONTEXT_PRIORITY.GLOBAL);
});

test("distinct priorities report no conflict", () => {
  const contexts = [spec("a", CONTEXT_PRIORITY.PANE), spec("b", CONTEXT_PRIORITY.OVERLAY)];
  expect(findContextPriorityConflicts(contexts)).toEqual([]);
});

test("a same-priority collision is reported, not thrown", () => {
  const contexts = [spec("a", 200), spec("b", 100), spec("c", 200)];
  expect(() => findContextPriorityConflicts(contexts)).not.toThrow();
  expect(findContextPriorityConflicts(contexts)).toEqual([{ priority: 200, contexts: ["a", "c"] }]);
});

const instance = (id: string, generation: number): PluginInstance => ({ id, generation });

test("a plugin and core can both register a context; retiring the owner retires it", () => {
  const contributions = createPluginContributions();
  const contexts = contributions.table<ContextSpec>();
  const core = instance("amux.core", 0);
  const plugin = instance("git-panel", 0);

  contexts.add(core, "app.prefix", spec("app.prefix", CONTEXT_PRIORITY.APP_MODE));
  contexts.add(plugin, "git-panel.overlay", spec("git-panel.overlay", CONTEXT_PRIORITY.OVERLAY));
  expect(contributions.commit(core)).toEqual([]);
  expect(contributions.commit(plugin)).toEqual([]);

  expect(contexts.all().map((entry) => entry.name)).toEqual(["app.prefix", "git-panel.overlay"]);

  contributions.retire(plugin);
  expect(contexts.all().map((entry) => entry.name)).toEqual(["app.prefix"]);
});
