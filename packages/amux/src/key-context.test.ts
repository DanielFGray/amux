import { expect, test } from "bun:test";
import {
  CONTEXT_PRIORITY,
  findContextPriorityConflicts,
  resolveUnhandled,
  type ContextSpec,
} from "./key-context.ts";
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

test("resolveUnhandled offers the key to the highest-priority active context first", () => {
  const seen: string[] = [];
  const record = (id: string) => () => {
    seen.push(id);
    return true;
  };
  const settings: ContextSpec = {
    id: "settings",
    active: () => true,
    priority: CONTEXT_PRIORITY.OVERLAY + 10,
    rebindable: false,
    handle: record("settings"),
  };
  const prompt: ContextSpec = {
    id: "prompt",
    active: () => true,
    priority: CONTEXT_PRIORITY.OVERLAY + 40,
    rebindable: false,
    handle: record("prompt"),
  };
  // Opened last and ranked higher, so it takes the keystroke off settings
  // without either one knowing the other exists.
  const key = { name: "escape" } as never;
  expect(resolveUnhandled([settings, prompt], key)).toBe(true);
  expect(seen).toEqual(["prompt"]);
});

test("resolveUnhandled skips a context with no catch-all and an inactive one with higher priority", () => {
  const bindingsOnly: ContextSpec = {
    id: "pane-normal",
    active: () => true,
    priority: CONTEXT_PRIORITY.APP_MODE + 1000,
    rebindable: true,
  };
  const closedOverlay: ContextSpec = {
    id: "settings",
    active: () => false,
    priority: CONTEXT_PRIORITY.OVERLAY,
    rebindable: false,
    handle: () => true,
  };
  const seen: string[] = [];
  const fallback: ContextSpec = {
    id: "copy-mode",
    active: () => true,
    priority: CONTEXT_PRIORITY.APP_MODE,
    rebindable: false,
    handle: () => {
      seen.push("copy-mode");
      return true;
    },
  };
  const key = { name: "x" } as never;
  expect(resolveUnhandled([bindingsOnly, closedOverlay, fallback], key)).toBe(true);
  expect(seen).toEqual(["copy-mode"]);
});

test("resolveUnhandled falls through a context that declines the key to the one beneath it", () => {
  const seen: string[] = [];
  // Copy mode's escape-layering: a higher-priority context claims only
  // Escape (returning false for everything else), so every other key still
  // reaches the base context underneath it.
  const selection: ContextSpec = {
    id: "copy-mode.selection",
    active: () => true,
    priority: CONTEXT_PRIORITY.APP_MODE + 1,
    rebindable: false,
    handle: (event) => {
      if ((event as { name: string }).name !== "escape") return false;
      seen.push("selection:escape");
      return true;
    },
  };
  const base: ContextSpec = {
    id: "copy-mode",
    active: () => true,
    priority: CONTEXT_PRIORITY.APP_MODE,
    rebindable: false,
    handle: (event) => {
      seen.push(`copy-mode:${(event as { name: string }).name}`);
      return true;
    },
  };
  expect(resolveUnhandled([base, selection], { name: "escape" } as never)).toBe(true);
  expect(resolveUnhandled([base, selection], { name: "w" } as never)).toBe(true);
  expect(seen).toEqual(["selection:escape", "copy-mode:w"]);
});

test("resolveUnhandled returns false when nothing active claims the key", () => {
  expect(resolveUnhandled([], { name: "x" } as never)).toBe(false);
});
