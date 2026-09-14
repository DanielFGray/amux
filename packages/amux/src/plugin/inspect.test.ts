import { expect } from "bun:test";
import { Effect } from "effect";
import { pathToFileURL } from "node:url";
import { testEffect } from "../test-effect.ts";
import { COMMAND_META, type CommandMeta } from "../commands.ts";
import type { CommandSpec, Keys } from "../bindings.ts";
import type { ContextSpec } from "../key-context.ts";
import type { PaneContent } from "../layout.ts";
import type { Contribution, PluginInstance } from "./contributions.ts";
import { createPluginContributions } from "./contributions.ts";
import {
  formatInspectResult,
  inspect,
  parsePluginCommandTag,
  provenanceFor,
  type InspectCatalog,
} from "./inspect.ts";
import type { PluginStatus } from "./types.ts";

const keys: Keys = { prefix: "ctrl+a", leader: "space", bindings: {} };

const owner = (id: string, generation = 1): PluginInstance => ({ id, generation });

const binding = (
  name: string,
  opts: Partial<CommandSpec> & { owner: PluginInstance },
): Contribution<CommandSpec> => ({
  owner: opts.owner,
  name,
  value: {
    name,
    desc: opts.desc ?? name,
    group: opts.group ?? "test",
    key: opts.key,
    context: opts.context,
    run: Effect.void,
  },
});

const catalog = (parts: {
  bindings?: readonly Contribution<CommandSpec>[];
  contexts?: readonly Contribution<ContextSpec>[];
  statuses?: readonly PluginStatus[];
  generations?: ReadonlyMap<string, number>;
  sources?: ReadonlyMap<string, URL>;
  paneViews?: ReadonlyMap<string, PluginInstance>;
  panes?: ReadonlyMap<string, PaneContent>;
  commandMetas?: ReadonlyMap<string, CommandMeta>;
}): InspectCatalog => ({
  bindings: () => parts.bindings ?? [],
  contexts: () => parts.contexts ?? [],
  paneViewOwner: (type) => parts.paneViews?.get(type),
  commandMeta: (tag) =>
    parts.commandMetas?.get(tag) ??
    (Object.hasOwn(COMMAND_META, tag) ? COMMAND_META[tag as keyof typeof COMMAND_META] : undefined),
  pluginStatus: (id) => parts.statuses?.find((status) => status.id === id),
  pluginGeneration: (id) => parts.generations?.get(id),
  pluginSource: (id) => parts.sources?.get(id),
  paneContent: (paneId) => parts.panes?.get(paneId),
  keys: () => keys,
});

testEffect("parsePluginCommandTag keeps dotted plugin ids", () =>
  Effect.sync(() => {
    expect(parsePluginCommandTag("plugin.amux.notifications.ring")).toEqual({
      pluginId: "amux.notifications",
      verb: "ring",
    });
    expect(parsePluginCommandTag("pane.split")).toBeUndefined();
  }),
);

testEffect("inspect command reports core provenance", () =>
  Effect.sync(() => {
    const result = inspect(catalog({}), { command: "pane.split" });
    expect(result.found).toBe(true);
    expect(result.provider?.pluginId).toBe("amux");
    expect(result.whyActive).toContain("core command");
  }),
);

testEffect("inspect command reports plugin id, generation, and source", () =>
  Effect.sync(() => {
    const result = inspect(
      catalog({
        statuses: [{ id: "live.review", phase: "active", waitingFor: [] }],
        generations: new Map([["live.review", 3]]),
        sources: new Map([["live.review", pathToFileURL("/tmp/scratch/live.review.ts")]]),
        commandMetas: new Map([
          [
            "plugin.live.review.send-selection",
            {
              name: "plugin.live.review.send-selection",
              desc: "send selection",
              group: "scratch",
              target: "server",
              exposure: "human",
            },
          ],
        ]),
      }),
      { command: "plugin.live.review.send-selection" },
    );
    expect(result.found).toBe(true);
    expect(result.provider).toEqual({
      pluginId: "live.review",
      generation: 3,
      source: "/tmp/scratch/live.review.ts",
      phase: "active",
      waitingFor: [],
      active: true,
    });
    expect(result.whyActive).toBe("plugin 'live.review' is active");
  }),
);

testEffect("inspect binding names the contributing plugin and context activity", () =>
  Effect.sync(() => {
    let contextActive = true;
    const context: ContextSpec = {
      id: "copy-mode",
      active: () => contextActive,
      priority: 10,
      rebindable: false,
    };
    const plugin = owner("amux.commands", 2);
    const cat = catalog({
      bindings: [binding("pane.copy-mode", { owner: plugin, key: "<prefix>[", context })],
      statuses: [{ id: "amux.commands", phase: "active", waitingFor: [] }],
      generations: new Map([["amux.commands", 2]]),
    });
    const active = inspect(cat, { binding: "pane.copy-mode" });
    expect(active.found).toBe(true);
    expect(active.provider?.pluginId).toBe("amux.commands");
    expect(active.provider?.generation).toBe(2);
    expect(active.whyActive).toContain("context 'copy-mode' is active");
    expect(active.details?.keys).toEqual(["<prefix>["]);

    contextActive = false;
    const inactive = inspect(cat, { binding: "pane.copy-mode" });
    expect(inactive.whyActive).toContain("context 'copy-mode' is inactive");
  }),
);

testEffect("inspect key is describe-key over the binding table", () =>
  Effect.sync(() => {
    const plugin = owner("amux.commands");
    const result = inspect(
      catalog({
        bindings: [binding("app.help", { owner: plugin, key: "<prefix>?" })],
        statuses: [{ id: "amux.commands", phase: "active", waitingFor: [] }],
      }),
      { key: "<prefix>?" },
    );
    expect(result.found).toBe(true);
    expect(result.details?.binding).toBe("app.help");
    expect(result.provider?.pluginId).toBe("amux.commands");
  }),
);

testEffect("inspect pane resolves pty vs plugin view ownership", () =>
  Effect.sync(() => {
    const pty = inspect(
      catalog({
        panes: new Map([["p1", { kind: "pty", session: "s1" }]]),
      }),
      { pane: "p1" },
    );
    expect(pty.found).toBe(true);
    expect(pty.provider?.pluginId).toBe("amux");
    expect(pty.whyActive).toContain("core pty");

    const viewOwner = owner("amux.editor", 4);
    const pluginPane = inspect(
      catalog({
        panes: new Map([["p2", { kind: "plugin", type: "editor", descriptor: {}, session: "s2" }]]),
        paneViews: new Map([["editor", viewOwner]]),
        statuses: [{ id: "amux.editor", phase: "active", waitingFor: [] }],
        generations: new Map([["amux.editor", 4]]),
        sources: new Map([["amux.editor", pathToFileURL("/plugins/editor/index.ts")]]),
      }),
      { pane: "p2" },
    );
    expect(pluginPane.found).toBe(true);
    expect(pluginPane.provider?.pluginId).toBe("amux.editor");
    expect(pluginPane.provider?.generation).toBe(4);
    expect(pluginPane.details?.paneType).toBe("editor");
  }),
);

testEffect("inspect plugin reports waitingFor when inactive on deps", () =>
  Effect.sync(() => {
    const result = inspect(
      catalog({
        statuses: [{ id: "amux.notifications", phase: "waiting", waitingFor: ["amux/Panel"] }],
        generations: new Map([["amux.notifications", 1]]),
      }),
      { plugin: "amux.notifications" },
    );
    expect(result.found).toBe(true);
    expect(result.provider?.active).toBe(false);
    expect(result.whyActive).toContain("waiting for: amux/Panel");
  }),
);

testEffect("sessionViews.ownerOf reads the contribution owner", () =>
  Effect.sync(() => {
    const contributions = createPluginContributions();
    // Dynamic import avoided — exercise ownerOf via the table pattern inspect uses.
    const views = contributions.table<{ (): null }>();
    const plugin = owner("amux.editor", 1);
    contributions.commit(plugin);
    views.add(plugin, "editor", () => null);
    expect(views.all().find((entry) => entry.name === "editor")?.owner).toEqual(plugin);
  }),
);

testEffect("provenanceFor prefers an explicit generation from the contribution", () =>
  Effect.sync(() => {
    const prov = provenanceFor(
      catalog({
        generations: new Map([["x", 9]]),
        statuses: [{ id: "x", phase: "active", waitingFor: [] }],
      }),
      "x",
      2,
    );
    expect(prov.generation).toBe(2);
  }),
);

testEffect("formatInspectResult lists owner, why, and source for humans", () =>
  Effect.sync(() => {
    const result = inspect(
      catalog({
        commandMetas: new Map([
          [
            "plugin.live.review.send-selection",
            {
              name: "plugin.live.review.send-selection",
              desc: "send selection to pane",
              group: "plugins",
              target: "client",
              exposure: "agent",
            } satisfies CommandMeta,
          ],
        ]),
        statuses: [{ id: "live.review", phase: "active", waitingFor: [] }],
        generations: new Map([["live.review", 3]]),
        sources: new Map([["live.review", pathToFileURL("/state/amux/scratch/live.review.ts")]]),
      }),
      { command: "plugin.live.review.send-selection" },
    );
    const lines = formatInspectResult(result);
    expect(lines[0]).toBe("command  plugin.live.review.send-selection");
    expect(lines).toContain("send selection to pane");
    expect(lines).toContain("owner  live.review  gen 3");
    expect(lines.some((line) => line.startsWith("why    "))).toBe(true);
    expect(lines.some((line) => line.includes("/scratch/live.review.ts"))).toBe(true);
  }),
);

testEffect("formatInspectResult reports not-found briefly", () =>
  Effect.sync(() => {
    expect(formatInspectResult(inspect(catalog({}), { pane: "%missing" }))).toEqual([
      "pane  %missing",
      "not found",
    ]);
  }),
);
